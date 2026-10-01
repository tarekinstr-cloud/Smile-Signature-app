-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Plan de salle visuel (à exécuter après 20261001000000_ticket_no_per_day.sql et
-- 20261001000000_supplier_invoice_cancel.sql). À exécuter à la main dans Supabase > SQL Editor.
--
-- • Fond de salle : halls.background_url / background_path. L'image est rangée dans le bucket Storage public
--   « floor-backgrounds » (créé ici) ; écriture réservée aux permissions « edit » (Modifier le plan) ou « settings »
--   (Paramètres > Modifier fond d'écran). set_hall_background() enregistre l'image sur la salle.
-- • Couverts : orders.guests (nombre de personnes à table) colore autant de chaises sur le plan.
-- • Chrono : orders.served_at (bouton « Servi », heure du serveur) arrête le chrono ; le prochain envoi en cuisine
--   (Valider après Suite) le relance depuis l'heure de l'envoi (orders.timer_at). Sans « Servi » : depuis l'ouverture.
-- • app_config : seuils du chrono (vert / orange / rouge), Paramètres > Configurations.
-- • server_now() : heure du serveur, pour corriger l'horloge des appareils (jamais de durée négative).
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- ───────────── Heure du serveur ─────────────

create or replace function public.server_now()
returns timestamptz
language sql stable as $$ select now() $$;
revoke all on function public.server_now() from public, anon;
grant execute on function public.server_now() to authenticated;

-- ───────────── Fond de salle ─────────────

alter table public.halls add column if not exists background_url text;
alter table public.halls add column if not exists background_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('floor-backgrounds', 'floor-backgrounds', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "floor backgrounds read" on storage.objects;
create policy "floor backgrounds read" on storage.objects for select
  using (bucket_id = 'floor-backgrounds');
drop policy if exists "floor backgrounds write" on storage.objects;
create policy "floor backgrounds write" on storage.objects for insert to authenticated
  with check (bucket_id = 'floor-backgrounds' and (public.has_permission('edit') or public.has_permission('settings')));
drop policy if exists "floor backgrounds update" on storage.objects;
create policy "floor backgrounds update" on storage.objects for update to authenticated
  using (bucket_id = 'floor-backgrounds' and (public.has_permission('edit') or public.has_permission('settings')));
drop policy if exists "floor backgrounds delete" on storage.objects;
create policy "floor backgrounds delete" on storage.objects for delete to authenticated
  using (bucket_id = 'floor-backgrounds' and (public.has_permission('edit') or public.has_permission('settings')));

-- Enregistre (ou retire, p_url null) l'image d'une salle ; renvoie l'ancien chemin pour supprimer l'ancien fichier.
create or replace function public.set_hall_background(p_hall_id uuid, p_url text, p_path text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_old text;
begin
  if not (public.has_permission('edit') or public.has_permission('settings')) then
    raise exception 'permission_denied:edit';
  end if;
  select background_path into v_old from public.halls where id = p_hall_id for update;
  if not found then
    raise exception 'hall_not_found';
  end if;
  update public.halls set background_url = nullif(trim(coalesce(p_url, '')), ''), background_path = nullif(trim(coalesce(p_path, '')), '')
   where id = p_hall_id;
  return v_old;
end $$;
revoke all on function public.set_hall_background(uuid, text, text) from public, anon;
grant execute on function public.set_hall_background(uuid, text, text) to authenticated;

-- ───────────── Couverts et chrono ─────────────

alter table public.orders add column if not exists guests integer;
alter table public.orders drop constraint if exists orders_guests_check;
alter table public.orders add constraint orders_guests_check check (guests is null or guests between 1 and 99);
alter table public.orders add column if not exists served_at timestamptz;
alter table public.orders add column if not exists timer_at timestamptz;

-- « Servi » : à l'heure du serveur.
create or replace function public.mark_order_served(p_order_id uuid)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_at timestamptz := now();
begin
  update public.orders set served_at = v_at where id = p_order_id and status = 'open';
  if not found then
    raise exception 'order_not_open';
  end if;
  return v_at;
end $$;
revoke all on function public.mark_order_served(uuid) from public, anon;
grant execute on function public.mark_order_served(uuid) to authenticated;

-- Un envoi en cuisine après « Servi » relance le chrono depuis l'heure de l'envoi.
create or replace function public.order_items_restart_timer() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.orders set served_at = null, timer_at = new.sent_at
   where id = new.order_id and served_at is not null and status = 'open';
  return null;
end $$;
revoke all on function public.order_items_restart_timer() from public, anon, authenticated;

drop trigger if exists order_items_restart_timer on public.order_items;
create trigger order_items_restart_timer
  after update of sent_at on public.order_items
  for each row when (old.sent_at is null and new.sent_at is not null)
  execute function public.order_items_restart_timer();

-- ───────────── Configurations ─────────────

create table if not exists public.app_config (
  id               int primary key default 1 check (id = 1),
  timer_warn_min   int not null default 15 check (timer_warn_min between 1 and 600),
  timer_alert_min  int not null default 30 check (timer_alert_min between 2 and 600),
  updated_at       timestamptz not null default now(),
  constraint app_config_timer_order check (timer_alert_min > timer_warn_min)
);
insert into public.app_config (id) values (1) on conflict (id) do nothing;

alter table public.app_config enable row level security;
drop policy if exists "read app_config" on public.app_config;
create policy "read app_config" on public.app_config for select to authenticated using (true);
drop policy if exists "settings write app_config" on public.app_config;
create policy "settings write app_config" on public.app_config for update to authenticated
  using (public.has_permission('settings')) with check (public.has_permission('settings'));
grant select, update on public.app_config to authenticated;

-- ───────────── Realtime : le plan suit les fonds et les seuils ─────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_config') then
    alter publication supabase_realtime add table public.app_config;
  end if;
end $$;

notify pgrst, 'reload schema';

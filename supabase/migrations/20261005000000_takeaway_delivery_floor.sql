-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- À emporter et Livraison affichés comme une salle, livreurs, bipeur
-- (à exécuter après 20261004000000_guests_everywhere.sql). À exécuter à la main dans Supabase > SQL Editor.
--
-- • Fonds des vues À emporter et Livraison : app_config.takeaway_background_* / delivery_background_*, images dans
--   le bucket floor-backgrounds (créé ici s'il n'existe pas), écrites par set_area_background() (permission
--   « edit » ou « settings »), comme les fonds de salle.
-- • Bipeur : app_config.pager_enabled (Paramètres > Configurations) et orders.pager_no (n° du bipeur remis au client).
-- • Livreurs : app_users.is_driver et app_users.phone (Gestion des employés, permission « staff ») ;
--   orders.driver_id / driver_name / driver_phone (nom et téléphone copiés à l'affectation : ils restent sur la
--   commande si le compte change). list_drivers() : livreurs actifs, lisibles par tous les comptes (service).
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- ───────────── Configurations (créée par 20261002000000_floor_visual.sql ; recréée ici au besoin) ─────────────

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

alter table public.app_config add column if not exists takeaway_background_url text;
alter table public.app_config add column if not exists takeaway_background_path text;
alter table public.app_config add column if not exists delivery_background_url text;
alter table public.app_config add column if not exists delivery_background_path text;
alter table public.app_config add column if not exists pager_enabled boolean not null default false;

-- ───────────── Images de fond (bucket partagé avec les fonds de salle) ─────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('floor-backgrounds', 'floor-backgrounds', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

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

-- Fond de la vue À emporter ou Livraison (p_url null : retiré) ; renvoie l'ancien chemin pour supprimer le fichier.
create or replace function public.set_area_background(p_area text, p_url text, p_path text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_old text;
  v_url text := nullif(trim(coalesce(p_url, '')), '');
  v_path text := nullif(trim(coalesce(p_path, '')), '');
begin
  if not (public.has_permission('edit') or public.has_permission('settings')) then
    raise exception 'permission_denied:edit';
  end if;
  if p_area = 'takeaway' then
    select takeaway_background_path into v_old from public.app_config where id = 1 for update;
    update public.app_config set takeaway_background_url = v_url, takeaway_background_path = v_path, updated_at = now() where id = 1;
  elsif p_area = 'delivery' then
    select delivery_background_path into v_old from public.app_config where id = 1 for update;
    update public.app_config set delivery_background_url = v_url, delivery_background_path = v_path, updated_at = now() where id = 1;
  else
    raise exception 'bad_area';
  end if;
  return v_old;
end $$;
revoke all on function public.set_area_background(text, text, text) from public, anon;
grant execute on function public.set_area_background(text, text, text) to authenticated;

-- ───────────── Bipeur ─────────────

alter table public.orders add column if not exists pager_no text;
alter table public.orders drop constraint if exists orders_pager_no_check;
alter table public.orders add constraint orders_pager_no_check check (pager_no is null or length(pager_no) between 1 and 10);

-- ───────────── Livreurs ─────────────

alter table public.app_users add column if not exists is_driver boolean not null default false;
alter table public.app_users add column if not exists phone text;
alter table public.app_users drop constraint if exists app_users_phone_check;
alter table public.app_users add constraint app_users_phone_check check (phone is null or length(phone) <= 30);

alter table public.orders add column if not exists driver_id uuid references auth.users (id) on delete set null;
alter table public.orders add column if not exists driver_name text;
alter table public.orders add column if not exists driver_phone text;
create index if not exists orders_driver on public.orders (driver_id) where driver_id is not null;

-- Gestion des employés : tous les comptes actifs, avec la case Livreur et le téléphone.
create or replace function public.list_staff_drivers()
returns table (user_id uuid, name text, username text, is_driver boolean, phone text)
language sql stable security definer set search_path = public as $$
  select a.user_id, coalesce(nullif(trim(a.display_name), ''), a.username), a.username, a.is_driver, a.phone
    from public.app_users a
   where a.active and public.has_permission('staff')
   order by 2
$$;
revoke all on function public.list_staff_drivers() from public, anon;
grant execute on function public.list_staff_drivers() to authenticated;

create or replace function public.set_staff_driver(p_user_id uuid, p_is_driver boolean, p_phone text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_permission('staff') then
    raise exception 'permission_denied:staff';
  end if;
  update public.app_users set is_driver = coalesce(p_is_driver, false), phone = nullif(left(trim(coalesce(p_phone, '')), 30), '')
   where user_id = p_user_id;
  if not found then
    raise exception 'user_not_found';
  end if;
end $$;
revoke all on function public.set_staff_driver(uuid, boolean, text) from public, anon;
grant execute on function public.set_staff_driver(uuid, boolean, text) to authenticated;

-- Livreurs actifs, pour les choisir sur une livraison (tous les comptes).
create or replace function public.list_drivers()
returns table (user_id uuid, name text, phone text)
language sql stable security definer set search_path = public as $$
  select a.user_id, coalesce(nullif(trim(a.display_name), ''), a.username), a.phone
    from public.app_users a
   where a.active and a.is_driver
   order by 2
$$;
revoke all on function public.list_drivers() from public, anon;
grant execute on function public.list_drivers() to authenticated;

-- Affecte (ou retire, p_driver null) le livreur d'une livraison ; son nom et son téléphone sont copiés sur la commande.
create or replace function public.set_order_driver(p_order_id uuid, p_driver uuid)
returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_name text;
  v_phone text;
begin
  if p_driver is not null then
    select coalesce(nullif(trim(display_name), ''), username), phone into v_name, v_phone
      from public.app_users where user_id = p_driver and active and is_driver;
    if not found then
      raise exception 'driver_not_found';
    end if;
  end if;
  update public.orders set driver_id = p_driver, driver_name = v_name, driver_phone = v_phone
   where id = p_order_id and order_type = 'delivery'
  returning * into v_order;
  if not found then
    raise exception 'order_not_found';
  end if;
  return v_order;
end $$;
revoke all on function public.set_order_driver(uuid, uuid) from public, anon;
grant execute on function public.set_order_driver(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';

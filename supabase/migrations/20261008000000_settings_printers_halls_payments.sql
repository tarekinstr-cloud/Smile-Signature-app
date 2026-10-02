-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Paramètres (suite) : imprimante par plat, gestion des salles, modes de paiement, motifs, sécurité, photos
-- des articles (à exécuter après 20261007000000_settings_restaurant_ticket.sql).
-- À exécuter à la main dans Supabase > SQL Editor.
--
-- • Imprimante par plat : items.printer_id remplace les imprimantes de la catégorie de l'article ; écrit par
--   set_item_printer() (Admin ou permission « settings »).
-- • Salles : halls.active (une salle désactivée n'apparaît plus au service) ; écriture des salles avec la
--   permission « edit » ou « settings ». La suppression d'une salle dont une table a une commande ouverte reste
--   refusée par la base (garde-fou orders_zz_keep_table de 20260928030000_keep_order_table.sql).
-- • Modes de paiement : table payment_modes (Espèces et Carte, plus CIB, Edahabia et BaridiMob désactivés au
--   départ). Seul le mode « cash » (Espèces) compte dans la caisse. Un paiement n'est accepté que dans un mode actif.
-- • Motifs : app_config.cancel_reasons / offer_reasons / discount_reasons (null : liste par défaut de l'app) ;
--   orders.offer_reason / discount_reason et order_items.offer_reason / discount_reason.
-- • Sécurité : app_config.pin_login_enabled et auto_logout_min (null : désactivée) ; table user_pins (code PIN
--   à 4 chiffres chiffré avec bcrypt, illisible par l'app : seules les fonctions ci-dessous y accèdent), écrite
--   par set_user_pin() (Admin). La connexion par PIN passe par la
--   fonction Edge « pin-login » (supabase/functions/pin-login), seule à pouvoir appeler pin_login_check().
--   5 codes faux de suite bloquent le PIN du compte 5 minutes.
-- • Photos des articles : items.photo_url / photo_path, images (déjà réduites à 512 px par l'app) dans le bucket
--   public item-photos, écrites par set_item_photo() (permission « edit » ou « settings »).
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- ───────────── Imprimante par plat ─────────────

alter table public.items add column if not exists printer_id uuid references public.printers (id) on delete set null;
create index if not exists items_printer_id on public.items (printer_id) where printer_id is not null;

-- Imprimante d'un article (p_printer_id null : celle(s) de sa catégorie).
create or replace function public.set_item_printer(p_item_id uuid, p_printer_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_app_admin() or public.has_permission('settings')) then
    raise exception 'permission_denied:settings';
  end if;
  update public.items set printer_id = p_printer_id where id = p_item_id;
  if not found then
    raise exception 'item_not_found';
  end if;
end $$;
revoke all on function public.set_item_printer(uuid, uuid) from public, anon;
grant execute on function public.set_item_printer(uuid, uuid) to authenticated;

-- ───────────── Salles ─────────────

alter table public.halls add column if not exists active boolean not null default true;

drop policy if exists "perm edit write halls" on public.halls;
create policy "perm edit write halls" on public.halls for all to authenticated
  using (public.has_permission('edit') or public.has_permission('settings'))
  with check (public.has_permission('edit') or public.has_permission('settings'));

-- ───────────── Modes de paiement ─────────────

create table if not exists public.payment_modes (
  code        text primary key check (code ~ '^[a-z0-9_]{1,30}$'),
  label       text check (label is null or length(trim(label)) between 1 and 40),
  active      boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  -- Espèces reste toujours proposé : c'est le seul mode qui passe par la caisse.
  constraint payment_modes_cash_active check (code <> 'cash' or active)
);
comment on table public.payment_modes is
  'Modes de paiement (Paramètres > Configurations > Paiement). code = payments.method ; seul « cash » compte dans la caisse ; label null : nom traduit par l''app (cash, card).';

insert into public.payment_modes (code, label, active, sort_order) values
  ('cash', null, true, 0),
  ('card', null, true, 1),
  ('cib', 'CIB', false, 2),
  ('edahabia', 'Edahabia', false, 3),
  ('baridimob', 'BaridiMob', false, 4)
on conflict (code) do nothing;

alter table public.payment_modes enable row level security;
drop policy if exists "read payment_modes" on public.payment_modes;
create policy "read payment_modes" on public.payment_modes for select to authenticated using (true);
drop policy if exists "settings write payment_modes" on public.payment_modes;
create policy "settings write payment_modes" on public.payment_modes for all to authenticated
  using (public.is_app_admin() or public.has_permission('settings'))
  with check (public.is_app_admin() or public.has_permission('settings'));
grant select, insert, update, delete on public.payment_modes to authenticated;

-- Espèces et Carte ne se suppriment pas ; un mode déjà utilisé non plus (les rapports gardent son nom) : désactivez-le.
create or replace function public.payment_modes_guard_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.code in ('cash', 'card') then
    raise exception 'payment_mode_builtin';
  end if;
  if exists (select 1 from public.payments where method = old.code) then
    raise exception 'payment_mode_used';
  end if;
  return old;
end $$;
revoke all on function public.payment_modes_guard_delete() from public, anon, authenticated;
drop trigger if exists payment_modes_guard_delete on public.payment_modes;
create trigger payment_modes_guard_delete before delete on public.payment_modes
  for each row execute function public.payment_modes_guard_delete();

-- Le code d'un mode ne change pas (les paiements y sont liés par leur texte).
create or replace function public.payment_modes_keep_code() returns trigger
language plpgsql set search_path = public as $$
begin
  new.code := old.code;
  return new;
end $$;
revoke all on function public.payment_modes_keep_code() from public, anon, authenticated;
drop trigger if exists payment_modes_keep_code on public.payment_modes;
create trigger payment_modes_keep_code before update on public.payment_modes
  for each row execute function public.payment_modes_keep_code();

-- Un nouveau paiement doit être dans un mode actif.
create or replace function public.payments_check_mode() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.payment_modes where code = new.method and active) then
    raise exception 'payment_mode_inactive';
  end if;
  return new;
end $$;
revoke all on function public.payments_check_mode() from public, anon, authenticated;
drop trigger if exists payments_check_mode on public.payments;
create trigger payments_check_mode before insert on public.payments
  for each row execute function public.payments_check_mode();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'payment_modes') then
    alter publication supabase_realtime add table public.payment_modes;
  end if;
end $$;

-- ───────────── Configurations : motifs et sécurité ─────────────

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
  using (public.is_app_admin() or public.has_permission('settings'))
  with check (public.is_app_admin() or public.has_permission('settings'));
grant select, update on public.app_config to authenticated;

alter table public.app_config add column if not exists cancel_reasons text[];
alter table public.app_config add column if not exists offer_reasons text[];
alter table public.app_config add column if not exists discount_reasons text[];
alter table public.app_config add column if not exists pin_login_enabled boolean not null default false;
alter table public.app_config add column if not exists auto_logout_min int;
alter table public.app_config drop constraint if exists app_config_reasons_check;
alter table public.app_config add constraint app_config_reasons_check check (
  coalesce(cardinality(cancel_reasons), 0) <= 30 and coalesce(cardinality(offer_reasons), 0) <= 30
  and coalesce(cardinality(discount_reasons), 0) <= 30);
alter table public.app_config drop constraint if exists app_config_auto_logout_check;
alter table public.app_config add constraint app_config_auto_logout_check check (auto_logout_min is null or auto_logout_min between 1 and 480);

alter table public.orders add column if not exists offer_reason text;
alter table public.orders add column if not exists discount_reason text;
alter table public.order_items add column if not exists offer_reason text;
alter table public.order_items add column if not exists discount_reason text;
alter table public.orders drop constraint if exists orders_adjust_reason_check;
alter table public.orders add constraint orders_adjust_reason_check
  check (coalesce(length(offer_reason), 0) <= 60 and coalesce(length(discount_reason), 0) <= 60);
alter table public.order_items drop constraint if exists order_items_adjust_reason_check;
alter table public.order_items add constraint order_items_adjust_reason_check
  check (coalesce(length(offer_reason), 0) <= 60 and coalesce(length(discount_reason), 0) <= 60);

-- ───────────── Connexion rapide par PIN ─────────────

create table if not exists public.user_pins (
  user_id           uuid primary key references public.app_users (user_id) on delete cascade,
  pin_hash          text not null,
  failed            int not null default 0,
  locked_until      timestamptz,
  updated_at        timestamptz not null default now()
);
-- RLS sans politique : aucune lecture ni écriture directe depuis l'app.
alter table public.user_pins enable row level security;
revoke all on public.user_pins from anon, authenticated;

-- Code PIN d'un compte (p_pin null ou vide : retiré). Admin seulement.
create or replace function public.set_user_pin(p_user_id uuid, p_pin text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_pin text := nullif(trim(coalesce(p_pin, '')), '');
begin
  if not public.is_app_admin() then
    raise exception 'permission_denied:admin';
  end if;
  if v_pin is not null and v_pin !~ '^[0-9]{4}$' then
    raise exception 'pin_invalid';
  end if;
  if not exists (select 1 from public.app_users where user_id = p_user_id) then
    raise exception 'user_not_found';
  end if;
  if v_pin is null then
    delete from public.user_pins where user_id = p_user_id;
  else
    insert into public.user_pins (user_id, pin_hash) values (p_user_id, crypt(v_pin, gen_salt('bf')))
    on conflict (user_id) do update set pin_hash = excluded.pin_hash, failed = 0, locked_until = null, updated_at = now();
  end if;
end $$;
revoke all on function public.set_user_pin(uuid, text) from public, anon;
grant execute on function public.set_user_pin(uuid, text) to authenticated;

-- Comptes qui ont un PIN (page Utilisateurs).
create or replace function public.users_with_pin()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select user_id from public.user_pins where public.is_app_admin()
$$;
revoke all on function public.users_with_pin() from public, anon;
grant execute on function public.users_with_pin() to authenticated;

-- Écran de connexion (avant toute session) : la connexion par PIN est-elle activée, et pour quels comptes.
create or replace function public.login_options()
returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'pin_login', coalesce(c.pin_login_enabled, false),
    'pin_users', case when coalesce(c.pin_login_enabled, false) then coalesce(
      (select json_agg(a.username order by lower(a.username)) from public.app_users a join public.user_pins p on p.user_id = a.user_id where a.active), '[]'::json)
      else '[]'::json end)
  from (select 1) x left join public.app_config c on c.id = 1
$$;
revoke all on function public.login_options() from public;
grant execute on function public.login_options() to anon, authenticated;

-- Vérifie un PIN et renvoie l'adresse de connexion du compte. Réservé à la fonction Edge pin-login (service_role).
create or replace function public.pin_login_check(p_username text, p_pin text)
returns text
language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  v_user uuid;
  p public.user_pins;
  v_email text;
begin
  if not coalesce((select pin_login_enabled from public.app_config where id = 1), false) then
    raise exception 'pin_disabled';
  end if;
  select a.user_id into v_user from public.app_users a where lower(a.username) = lower(trim(coalesce(p_username, ''))) and a.active;
  select * into p from public.user_pins where user_id = v_user for update;
  if v_user is null or p.user_id is null then
    raise exception 'pin_bad';
  end if;
  if p.locked_until is not null and p.locked_until > now() then
    raise exception 'pin_locked';
  end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' or crypt(p_pin, p.pin_hash) <> p.pin_hash then
    update public.user_pins
       set failed = case when p.failed + 1 >= 5 then 0 else p.failed + 1 end,
           locked_until = case when p.failed + 1 >= 5 then now() + interval '5 minutes' else null end
     where user_id = v_user;
    return null;
  end if;
  update public.user_pins set failed = 0, locked_until = null where user_id = v_user;
  select u.email::text into v_email from auth.users u where u.id = v_user;
  return v_email;
end $$;
revoke all on function public.pin_login_check(text, text) from public, anon, authenticated;
grant execute on function public.pin_login_check(text, text) to service_role;

-- ───────────── Photos des articles ─────────────

alter table public.items add column if not exists photo_url text;
alter table public.items add column if not exists photo_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('item-photos', 'item-photos', true, 1048576, array['image/webp', 'image/jpeg'])
on conflict (id) do nothing;

drop policy if exists "item photos read" on storage.objects;
create policy "item photos read" on storage.objects for select
  using (bucket_id = 'item-photos');
drop policy if exists "item photos write" on storage.objects;
create policy "item photos write" on storage.objects for insert to authenticated
  with check (bucket_id = 'item-photos' and (public.has_permission('edit') or public.has_permission('settings')));
drop policy if exists "item photos update" on storage.objects;
create policy "item photos update" on storage.objects for update to authenticated
  using (bucket_id = 'item-photos' and (public.has_permission('edit') or public.has_permission('settings')));
drop policy if exists "item photos delete" on storage.objects;
create policy "item photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'item-photos' and (public.has_permission('edit') or public.has_permission('settings')));

-- Photo d'un article (p_url null : retirée) ; renvoie l'ancien chemin pour supprimer le fichier.
create or replace function public.set_item_photo(p_item_id uuid, p_url text, p_path text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_old text;
begin
  if not (public.has_permission('edit') or public.has_permission('settings')) then
    raise exception 'permission_denied:edit';
  end if;
  select photo_path into v_old from public.items where id = p_item_id for update;
  if not found then
    raise exception 'item_not_found';
  end if;
  update public.items set photo_url = nullif(trim(coalesce(p_url, '')), ''), photo_path = nullif(trim(coalesce(p_path, '')), '')
   where id = p_item_id;
  return v_old;
end $$;
revoke all on function public.set_item_photo(uuid, text, text) from public, anon;
grant execute on function public.set_item_photo(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';

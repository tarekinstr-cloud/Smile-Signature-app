-- Smile Signature: appareils connectés (menu Gestion des employés > Appareils connectés)
-- Idempotent: peut être exécuté plusieurs fois sans problème.
-- À exécuter après 20260930050000_payroll.sql.
--
-- Plusieurs tablettes / PC peuvent utiliser l'application en même temps (même base, mises à jour en direct).
-- Cette page sert seulement à voir qui utilise quel appareil : aucune limite du nombre d'appareils.
-- Chaque navigateur garde un identifiant d'appareil (localStorage) et un nom optionnel saisi à la connexion
-- (« Tablette Caisse », « Tablette Salle »…). Une ligne par appareil : dernier utilisateur connecté,
-- début de la session, dernière activité (signal envoyé chaque minute tant que l'application est ouverte),
-- et l'heure de déconnexion.
-- Nouvelle permission « devices » : voir la liste et retirer un appareil de la liste. Par défaut : Admin oui, Employé non.

-- ───────────── Table ─────────────

create table if not exists public.device_sessions (
  id            uuid primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  device_name   text check (device_name is null or length(device_name) <= 40),
  user_agent    text,
  started_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  ended_at      timestamptz
);

create index if not exists device_sessions_last_seen on public.device_sessions (last_seen_at desc);

comment on table public.device_sessions is 'Appareils qui utilisent l''application : dernier utilisateur, dernière activité (page Appareils connectés).';

-- ───────────── Permission « devices » ─────────────

alter table public.role_permissions drop constraint if exists role_permissions_permission_check;
alter table public.role_permissions add constraint role_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones',
  'cancel_order', 'offer', 'discount'));
alter table public.user_permissions drop constraint if exists user_permissions_permission_check;
alter table public.user_permissions add constraint user_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones',
  'cancel_order', 'offer', 'discount'));

insert into public.role_permissions (role, permission, allowed)
values ('admin', 'devices', true), ('employe', 'devices', false)
on conflict (role, permission) do nothing;

create or replace function public.my_permissions()
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p order by p), '{}')
  from unnest(array['staff', 'payroll', 'devices', 'stock', 'suppliers', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations',
                    'delivery_zones', 'cancel_order', 'offer', 'discount']) p
  where public.has_permission(p)
$$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- ───────────── Signal d'activité (tout compte connecté) ─────────────
-- Appelé à la connexion puis chaque minute. Un autre utilisateur sur le même appareil (ou une reconnexion)
-- recommence la session ; un nom vide garde le nom déjà connu de l'appareil.

create or replace function public.device_heartbeat(p_device uuid, p_name text default null, p_agent text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_name text := nullif(left(trim(coalesce(p_name, '')), 40), '');
begin
  if auth.uid() is null then
    raise exception 'not_signed_in';
  end if;
  insert into public.device_sessions as d (id, user_id, device_name, user_agent)
  values (p_device, auth.uid(), v_name, left(p_agent, 300))
  on conflict (id) do update set
    started_at = case when d.user_id <> excluded.user_id or d.ended_at is not null then now() else d.started_at end,
    user_id = excluded.user_id,
    device_name = coalesce(excluded.device_name, d.device_name),
    user_agent = coalesce(excluded.user_agent, d.user_agent),
    last_seen_at = now(),
    ended_at = null;
end $$;
revoke all on function public.device_heartbeat(uuid, text, text) from public, anon;
grant execute on function public.device_heartbeat(uuid, text, text) to authenticated;

-- Déconnexion depuis l'application : la session de cet appareil est close.
create or replace function public.device_sign_out(p_device uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.device_sessions set ended_at = now(), last_seen_at = now()
  where id = p_device and user_id = auth.uid() and ended_at is null;
end $$;
revoke all on function public.device_sign_out(uuid) from public, anon;
grant execute on function public.device_sign_out(uuid) to authenticated;

-- ───────────── Liste (permission « devices ») ─────────────
-- idle_seconds est calculé par la base (même horloge pour tous les appareils).

drop function if exists public.list_devices();
create or replace function public.list_devices()
returns table (id uuid, user_id uuid, username text, display_name text, device_name text, user_agent text,
               started_at timestamptz, last_seen_at timestamptz, ended_at timestamptz, idle_seconds integer)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.has_permission('devices') then
    raise exception 'no_permission';
  end if;
  return query
    select d.id, d.user_id, coalesce(a.username, split_part(u.email::text, '@', 1)), coalesce(a.display_name, ''),
           d.device_name, d.user_agent, d.started_at, d.last_seen_at, d.ended_at,
           greatest(0, extract(epoch from now() - d.last_seen_at))::integer
    from public.device_sessions d
    join auth.users u on u.id = d.user_id
    left join public.app_users a on a.user_id = d.user_id
    order by d.last_seen_at desc;
end $$;
revoke all on function public.list_devices() from public, anon;
grant execute on function public.list_devices() to authenticated;

-- Retirer un appareil de la liste (il réapparaît à sa prochaine connexion).
create or replace function public.remove_device(p_device uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_permission('devices') then
    raise exception 'no_permission';
  end if;
  delete from public.device_sessions where id = p_device;
end $$;
revoke all on function public.remove_device(uuid) from public, anon;
grant execute on function public.remove_device(uuid) to authenticated;

-- ───────────── RLS : lecture directe (temps réel) avec la permission ; écriture seulement par les fonctions ─────────────

alter table public.device_sessions enable row level security;
drop policy if exists "perm devices read device_sessions" on public.device_sessions;
create policy "perm devices read device_sessions" on public.device_sessions for select to authenticated
  using (public.has_permission('devices'));

grant select on public.device_sessions to authenticated;

-- ───────────── Realtime : la liste se met à jour en direct ─────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'device_sessions') then
    alter publication supabase_realtime add table public.device_sessions;
  end if;
end $$;

-- ───────────── Multi-appareils : le stock aussi en direct ─────────────
-- Plan de salle, commandes, paiements, réservations, zones et acomptes étaient déjà diffusés.
-- Le stock (ajusté depuis plusieurs appareils) se met maintenant à jour sans recharger la page.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stock_items') then
    alter publication supabase_realtime add table public.stock_items;
  end if;
end $$;

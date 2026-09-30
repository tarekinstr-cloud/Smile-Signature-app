-- Smile Signature: réservations de tables (menu Clients)
-- Idempotent: peut être exécuté plusieurs fois sans problème.
-- À exécuter après 20260930000000_permissions.sql.
--
-- Une réservation vise une salle (hall_id), et une table précise si le client en a choisi une (table_id, sinon null).
-- Statuts : confirmed (Confirmée), cancelled (Annulée), honored (Honorée), no_show (No-show).
-- Nouvelle permission « reservations » : ouvrir le menu Clients, créer et modifier les réservations.
-- Le plan de salle lit les réservations pour tout le monde (petit indicateur sur les tables réservées).

-- ───────────── Table ─────────────

create table if not exists public.reservations (
  id           uuid primary key default gen_random_uuid(),
  client_name  text not null check (length(trim(client_name)) > 0),
  phone        text not null default '',
  party_size   integer not null default 2 check (party_size between 1 and 200),
  hall_id      uuid references public.halls (id) on delete set null,
  table_id     uuid references public.tables (id) on delete set null,
  reserved_at  timestamptz not null,
  status       text not null default 'confirmed' check (status in ('confirmed', 'cancelled', 'honored', 'no_show')),
  note         text not null default '',
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists reservations_reserved_at_idx on public.reservations (reserved_at);
create index if not exists reservations_table_id_idx on public.reservations (table_id);

-- La table choisie doit être dans la salle de la réservation (la salle suit la table si elle est absente).
create or replace function public.reservations_check_table() returns trigger
language plpgsql set search_path = public as $$
declare
  v_hall uuid;
begin
  new.client_name := trim(new.client_name);
  new.phone := trim(coalesce(new.phone, ''));
  new.note := trim(coalesce(new.note, ''));
  if new.table_id is not null then
    select hall_id into v_hall from public.tables where id = new.table_id;
    if new.hall_id is null then
      new.hall_id := v_hall;
    elsif v_hall is distinct from new.hall_id then
      raise exception 'reservation_table_hall';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists reservations_check_table on public.reservations;
create trigger reservations_check_table before insert or update on public.reservations
  for each row execute function public.reservations_check_table();

-- ───────────── Permission « reservations » ─────────────

alter table public.role_permissions drop constraint if exists role_permissions_permission_check;
alter table public.role_permissions add constraint role_permissions_permission_check check (permission in (
  'staff', 'stock', 'suppliers', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'cancel_order', 'offer', 'discount'));
alter table public.user_permissions drop constraint if exists user_permissions_permission_check;
alter table public.user_permissions add constraint user_permissions_permission_check check (permission in (
  'staff', 'stock', 'suppliers', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'cancel_order', 'offer', 'discount'));

-- Par défaut : admin oui, employé non (comme les autres sections). Réglable dans Fichier > Permissions.
insert into public.role_permissions (role, permission, allowed)
values ('admin', 'reservations', true), ('employe', 'reservations', false)
on conflict (role, permission) do nothing;

create or replace function public.my_permissions()
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p order by p), '{}')
  from unnest(array['staff', 'stock', 'suppliers', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations',
                    'cancel_order', 'offer', 'discount']) p
  where public.has_permission(p)
$$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- ───────────── RLS ─────────────

alter table public.reservations enable row level security;
drop policy if exists "staff read reservations" on public.reservations;
drop policy if exists "perm reservations write reservations" on public.reservations;
create policy "staff read reservations" on public.reservations for select to authenticated using (true);
create policy "perm reservations write reservations" on public.reservations for all to authenticated
  using (public.has_permission('reservations')) with check (public.has_permission('reservations'));

-- ───────────── Realtime : l'indicateur du plan de salle se met à jour sur tous les appareils ─────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'reservations') then
    alter publication supabase_realtime add table public.reservations;
  end if;
end $$;

-- Smile Signature: zones de livraison (menu Édition) et frais de livraison sur les commandes « Livraison »
-- Idempotent: peut être exécuté plusieurs fois sans problème.
-- À exécuter après 20260930020000_honor_reservation.sql (nécessite aussi 20260928050000_delivery.sql).
--
-- Une zone = un nom (quartier, ville), des frais de livraison en DA et un temps de livraison estimé (minutes, optionnel).
-- Une livraison peut choisir une zone : ses frais s'ajoutent au total de la commande (ligne « Frais de livraison »).
-- Le nom et les frais sont copiés sur la commande au moment du choix : modifier ou supprimer une zone ne change
-- pas les commandes déjà prises.
-- Nouvelle permission « delivery_zones » : ajouter, modifier et supprimer les zones (Édition > Zones de livraison).
-- Tout le monde peut lire les zones (pour les choisir sur une livraison).

-- ───────────── Table ─────────────

create table if not exists public.delivery_zones (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(trim(name)) > 0),
  fee             numeric(10,2) not null default 0 check (fee >= 0),
  estimated_time  integer check (estimated_time is null or estimated_time between 1 and 1440),
  created_at      timestamptz not null default now()
);

create unique index if not exists delivery_zones_name_key on public.delivery_zones (lower(trim(name)));

comment on column public.delivery_zones.estimated_time is 'Temps de livraison estimé, en minutes (null: non précisé).';

-- ───────────── Commandes : zone et frais ─────────────

alter table public.orders
  add column if not exists delivery_zone_id    uuid references public.delivery_zones (id) on delete set null,
  add column if not exists delivery_zone_name  text,
  add column if not exists delivery_fee        numeric(10,2) not null default 0;

alter table public.orders drop constraint if exists orders_delivery_fee_check;
alter table public.orders add constraint orders_delivery_fee_check check (delivery_fee >= 0);

comment on column public.orders.delivery_fee is 'Frais de livraison copiés de la zone choisie (0 sans zone ou hors livraison).';

-- Choisir une zone copie son nom et ses frais sur la commande. Sans zone (retirée par l'app), l'app remet les frais à 0.
-- Une zone supprimée met delivery_zone_id à null mais garde le nom et les frais déjà copiés.
create or replace function public.orders_delivery_zone() returns trigger
language plpgsql set search_path = public as $$
declare
  z public.delivery_zones;
begin
  if new.order_type is distinct from 'delivery' then
    new.delivery_zone_id := null;
    new.delivery_zone_name := null;
    new.delivery_fee := 0;
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status <> 'open'
     and (new.delivery_fee is distinct from old.delivery_fee or new.delivery_zone_id is distinct from old.delivery_zone_id and new.delivery_zone_id is not null) then
    raise exception 'order_not_open';
  end if;
  if new.delivery_zone_id is not null and (tg_op = 'INSERT' or new.delivery_zone_id is distinct from old.delivery_zone_id) then
    select * into z from public.delivery_zones where id = new.delivery_zone_id;
    if not found then
      raise exception 'delivery_zone_not_found';
    end if;
    new.delivery_zone_name := z.name;
    new.delivery_fee := z.fee;
  end if;
  new.delivery_fee := coalesce(new.delivery_fee, 0);
  return new;
end $$;

drop trigger if exists orders_delivery_zone on public.orders;
create trigger orders_delivery_zone
  before insert or update of delivery_zone_id, delivery_zone_name, delivery_fee, order_type on public.orders
  for each row execute function public.orders_delivery_zone();

-- ───────────── Total : les frais de livraison s'ajoutent (même règle que src/lib/billing.ts) ─────────────
-- Lignes après leurs remises, puis remise sur la commande, puis + frais de livraison.
-- Pas de frais tant que la commande n'a aucun article, ni quand toute la commande est offerte.

create or replace function public.order_total(p_order_id uuid)
returns numeric
language sql stable set search_path = public as $$
  with o as (
    select * from public.orders where id = p_order_id
  ),
  l as (
    select case
      when i.offered or o.offered then 0
      else round(i.unit_price * i.quantity, 2) - public.discount_amount(round(i.unit_price * i.quantity, 2), i.discount_type, i.discount_value)
    end as net
    from public.order_items i join o on i.order_id = o.id
  ),
  s as (
    select coalesce(sum(net), 0) as sub, count(*) as n from l
  )
  select case when o.offered then 0
    else s.sub - public.discount_amount(s.sub, o.discount_type, o.discount_value)
      + case when s.n > 0 then coalesce(o.delivery_fee, 0) else 0 end
  end
  from o, s
$$;
grant execute on function public.order_total(uuid) to authenticated;

-- ───────────── Permission « delivery_zones » ─────────────

alter table public.role_permissions drop constraint if exists role_permissions_permission_check;
alter table public.role_permissions add constraint role_permissions_permission_check check (permission in (
  'staff', 'stock', 'suppliers', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones',
  'cancel_order', 'offer', 'discount'));
alter table public.user_permissions drop constraint if exists user_permissions_permission_check;
alter table public.user_permissions add constraint user_permissions_permission_check check (permission in (
  'staff', 'stock', 'suppliers', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones',
  'cancel_order', 'offer', 'discount'));

-- Par défaut : admin oui, employé non (comme les autres sections). Réglable dans Fichier > Permissions.
insert into public.role_permissions (role, permission, allowed)
values ('admin', 'delivery_zones', true), ('employe', 'delivery_zones', false)
on conflict (role, permission) do nothing;

create or replace function public.my_permissions()
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p order by p), '{}')
  from unnest(array['staff', 'stock', 'suppliers', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones',
                    'cancel_order', 'offer', 'discount']) p
  where public.has_permission(p)
$$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- ───────────── RLS ─────────────

alter table public.delivery_zones enable row level security;
drop policy if exists "staff read delivery_zones" on public.delivery_zones;
drop policy if exists "perm delivery_zones write delivery_zones" on public.delivery_zones;
create policy "staff read delivery_zones" on public.delivery_zones for select to authenticated using (true);
create policy "perm delivery_zones write delivery_zones" on public.delivery_zones for all to authenticated
  using (public.has_permission('delivery_zones')) with check (public.has_permission('delivery_zones'));

-- ───────────── Realtime : la liste des zones se met à jour sur tous les appareils ─────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'delivery_zones') then
    alter publication supabase_realtime add table public.delivery_zones;
  end if;
end $$;

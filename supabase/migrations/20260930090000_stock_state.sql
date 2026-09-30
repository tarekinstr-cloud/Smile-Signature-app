-- Smile Signature: État du stock (Gestion du Stock) : vue d'ensemble valorisée, stock minimum, mouvements par période,
-- inventaire physique.
-- Idempotent: peut être exécuté plusieurs fois sans problème.
-- À exécuter après 20260930080000_stock_locations.sql.
--
--   stock_items.min_quantity   Stock minimum (seuil d'alerte), modifiable depuis la fiche article. Vide : pas d'alerte.
--   stock_state()              Chaque article : Qté Dépôt, Qté Cuisine, dernier prix d'achat, dernier fournisseur.
--   stock_report(from, to)     Mouvements par période, calculés à partir de stock_movements (aucune donnée dupliquée) :
--                              stock initial, entrées (achats), transferts, sorties (charges), ajustements, stock final.
--   record_inventory(lines)    Inventaire physique : quantités comptées par article et par emplacement ; l'écart
--                              (compté − théorique) est enregistré comme mouvement « adjustment », en une transaction.
--   stock_inventories          Historique des inventaires (utilisateur, date, lignes avec théorique, compté, écart).
-- Nouvelles permissions : « stock_state » (voir l'État du stock) et « inventory » (faire un inventaire).
-- Par défaut : Admin oui, Employé non (réglable dans Fichier > Permissions).

-- ───────────── Stock minimum ─────────────

alter table public.stock_items add column if not exists min_quantity numeric(12,3);
alter table public.stock_items drop constraint if exists stock_items_min_quantity_check;
alter table public.stock_items add constraint stock_items_min_quantity_check check (min_quantity is null or min_quantity >= 0);
comment on column public.stock_items.min_quantity is 'Stock minimum (Dépôt + Cuisine) : en dessous, « Stock bas ». Vide : pas d''alerte.';

-- ───────────── Inventaires ─────────────

create table if not exists public.stock_inventories (
  id           uuid primary key default gen_random_uuid(),
  note         text not null default '',
  line_count   integer not null default 0,
  gap_value    numeric(12,2) not null default 0,   -- somme des écarts valorisés (lignes sans prix d'achat non comptées)
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  user_name    text not null default '',
  created_at   timestamptz not null default now()
);
create index if not exists stock_inventories_date on public.stock_inventories (created_at desc);

create table if not exists public.stock_inventory_lines (
  id             uuid primary key default gen_random_uuid(),
  inventory_id   uuid not null references public.stock_inventories (id) on delete cascade,
  stock_item_id  uuid references public.stock_items (id) on delete set null,
  item_name      text not null default '',
  unit           text not null default '',
  location       text not null check (location in ('depot', 'kitchen')),
  theoretical    numeric(12,3) not null,
  counted        numeric(12,3) not null check (counted >= 0),
  gap            numeric(12,3) not null,          -- compté − théorique
  unit_cost      numeric(12,2),                   -- dernier prix d'achat au moment de l'inventaire
  position       integer not null default 0
);
create index if not exists stock_inventory_lines_inventory on public.stock_inventory_lines (inventory_id, position);

-- Les ajustements d'un inventaire pointent vers lui.
alter table public.stock_movements add column if not exists inventory_id uuid references public.stock_inventories (id) on delete set null;

comment on table public.stock_inventories is 'Inventaires physiques, écrits seulement par record_inventory().';

-- ───────────── Permissions « stock_state » et « inventory » ─────────────

alter table public.role_permissions drop constraint if exists role_permissions_permission_check;
alter table public.role_permissions add constraint role_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stock_state', 'inventory',
  'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount'));
alter table public.user_permissions drop constraint if exists user_permissions_permission_check;
alter table public.user_permissions add constraint user_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stock_state', 'inventory',
  'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount'));

insert into public.role_permissions (role, permission, allowed)
values ('admin', 'stock_state', true), ('employe', 'stock_state', false),
       ('admin', 'inventory', true), ('employe', 'inventory', false)
on conflict (role, permission) do nothing;

create or replace function public.my_permissions()
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p order by p), '{}')
  from unnest(array['staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges',
                    'stock_state', 'inventory', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones',
                    'cancel_order', 'offer', 'discount']) p
  where public.has_permission(p)
$$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- ───────────── Vue d'ensemble ─────────────
-- Dernier prix d'achat et dernier fournisseur : la ligne de facture la plus récente de l'article.
-- suppliers : tous les fournisseurs chez qui l'article a été acheté, [{"id", "name"}] (filtre par fournisseur).

drop function if exists public.stock_state();
create or replace function public.stock_state()
returns table (
  id uuid, name text, unit text, quantity numeric, kitchen_quantity numeric, min_quantity numeric, updated_at timestamptz,
  last_price numeric, last_supplier_id uuid, last_supplier_name text, suppliers jsonb
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.has_permission('stock_state') or public.has_permission('inventory')) then
    raise exception 'no_permission';
  end if;
  return query
    select s.id, s.name, s.unit, s.quantity, s.kitchen_quantity, s.min_quantity, s.updated_at,
           lp.unit_price, lp.supplier_id, lp.supplier_name,
           coalesce((select jsonb_agg(distinct jsonb_build_object('id', i.supplier_id, 'name', i.supplier_name))
                       from public.supplier_invoice_items ii
                       join public.supplier_invoices i on i.id = ii.invoice_id
                      where ii.stock_item_id = s.id and i.supplier_id is not null), '[]'::jsonb)
      from public.stock_items s
      left join lateral (
        select ii.unit_price, i.supplier_id, i.supplier_name
          from public.supplier_invoice_items ii
          join public.supplier_invoices i on i.id = ii.invoice_id
         where ii.stock_item_id = s.id
         order by i.date desc, i.created_at desc, ii.position desc
         limit 1
      ) lp on true
     order by s.name;
end $$;
revoke all on function public.stock_state() from public, anon;
grant execute on function public.stock_state() to authenticated;

-- ───────────── Mouvements par période ─────────────
-- Calculé à rebours depuis les quantités actuelles : stock à une date = actuel − mouvements depuis cette date.
-- Donc juste même si des mouvements anciens manquent (avant 20260930080000_stock_locations.sql).
-- Par article, sur [p_from, p_to[ :
--   purchases    entrées (achats), au Dépôt
--   transfers    Dépôt → Cuisine ; returns : Cuisine → Dépôt (ne changent pas le total)
--   charges      sorties de la Cuisine (charges cuisine)
--   adjustments  ajustements ± et écarts d'inventaire, signés
-- initial + purchases − charges + adjustments = final (sur le total Dépôt + Cuisine).

create or replace function public.stock_report(p_from timestamptz, p_to timestamptz)
returns table (
  id uuid, name text, unit text,
  initial_depot numeric, initial_kitchen numeric,
  purchases numeric, transfers numeric, returns numeric, charges numeric, adjustments numeric,
  final_depot numeric, final_kitchen numeric
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_permission('stock_state') then
    raise exception 'no_permission';
  end if;
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'bad_period';
  end if;
  return query
    with m as (
      select sm.stock_item_id, sm.type, sm.quantity, sm.created_at,
             (case when sm.to_location = 'depot' then sm.quantity else 0 end)
               - (case when sm.from_location = 'depot' then sm.quantity else 0 end) as d_depot,
             (case when sm.to_location = 'kitchen' then sm.quantity else 0 end)
               - (case when sm.from_location = 'kitchen' then sm.quantity else 0 end) as d_kitchen
        from public.stock_movements sm
       where sm.created_at >= p_from and sm.stock_item_id is not null
    ), agg as (
      select m.stock_item_id,
             sum(m.d_depot) as since_from_depot,
             sum(m.d_kitchen) as since_from_kitchen,
             sum(case when m.created_at >= p_to then m.d_depot else 0 end) as since_to_depot,
             sum(case when m.created_at >= p_to then m.d_kitchen else 0 end) as since_to_kitchen,
             sum(case when m.created_at < p_to and m.type = 'purchase' then m.quantity else 0 end) as purchases,
             sum(case when m.created_at < p_to and m.type = 'transfer' then m.quantity else 0 end) as transfers,
             sum(case when m.created_at < p_to and m.type = 'return' then m.quantity else 0 end) as returns,
             sum(case when m.created_at < p_to and m.type = 'charge' then m.quantity else 0 end) as charges,
             sum(case when m.created_at < p_to and m.type = 'adjustment' then m.d_depot + m.d_kitchen else 0 end) as adjustments
        from m
       group by m.stock_item_id
    )
    select s.id, s.name, s.unit,
           s.quantity - coalesce(a.since_from_depot, 0), s.kitchen_quantity - coalesce(a.since_from_kitchen, 0),
           coalesce(a.purchases, 0), coalesce(a.transfers, 0), coalesce(a.returns, 0), coalesce(a.charges, 0), coalesce(a.adjustments, 0),
           s.quantity - coalesce(a.since_to_depot, 0), s.kitchen_quantity - coalesce(a.since_to_kitchen, 0)
      from public.stock_items s
      left join agg a on a.stock_item_id = s.id
     order by s.name;
end $$;
revoke all on function public.stock_report(timestamptz, timestamptz) from public, anon;
grant execute on function public.stock_report(timestamptz, timestamptz) to authenticated;

-- ───────────── Inventaire physique ─────────────
-- p_lines : [{"stock_item_id": "…", "location": "depot" | "kitchen", "counted": 12.5, "expected": 13}, …]
-- expected = quantité théorique affichée pendant le comptage : si le stock a bougé entre-temps (transfert, charge sur
-- une autre tablette), tout est annulé avec « inventory_stale {json} » pour recompter en connaissance de cause.
-- Tout ou rien, lignes verrouillées dans l'ordre des articles (pas d'interblocage entre appareils).

create or replace function public.record_inventory(p_lines jsonb, p_note text)
returns public.stock_inventories
language plpgsql security definer set search_path = public as $$
declare
  v_line record;
  v_item public.stock_items;
  v_inv public.stock_inventories;
  v_user text := public.current_user_name();
  v_theory numeric;
  v_gap numeric;
  v_cost numeric;
  v_value numeric := 0;
  v_pos integer := 0;
begin
  if not public.has_permission('inventory') then
    raise exception 'no_permission';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'no_lines';
  end if;
  perform public.stock_rpc_begin();

  insert into public.stock_inventories (note, user_name) values (trim(coalesce(p_note, '')), v_user) returning * into v_inv;

  for v_line in
    select (e ->> 'stock_item_id')::uuid as stock_item_id, e ->> 'location' as location,
           round((e ->> 'counted')::numeric, 3) as counted, (e ->> 'expected')::numeric as expected
      from jsonb_array_elements(p_lines) e
     order by 1, 2
  loop
    if v_line.stock_item_id is null then
      raise exception 'stock_item_not_found';
    end if;
    if v_line.location is null or v_line.location not in ('depot', 'kitchen') then
      raise exception 'bad_location';
    end if;
    if v_line.counted is null or v_line.counted < 0 then
      raise exception 'bad_quantity';
    end if;
    select * into v_item from public.stock_items where id = v_line.stock_item_id for update;
    if not found then
      raise exception 'stock_item_not_found';
    end if;
    if exists (select 1 from public.stock_inventory_lines l
                where l.inventory_id = v_inv.id and l.stock_item_id = v_item.id and l.location = v_line.location) then
      raise exception 'duplicate_line';
    end if;
    v_theory := case when v_line.location = 'depot' then v_item.quantity else v_item.kitchen_quantity end;
    if v_line.expected is not null and v_line.expected <> v_theory then
      raise exception '%', 'inventory_stale ' || json_build_object(
        'item', v_item.name, 'unit', v_item.unit, 'location', v_line.location, 'expected', v_line.expected, 'current', v_theory)::text;
    end if;
    v_gap := v_line.counted - v_theory;
    v_cost := public.last_purchase_price(v_item.id);

    insert into public.stock_inventory_lines (inventory_id, stock_item_id, item_name, unit, location, theoretical, counted, gap, unit_cost, position)
    values (v_inv.id, v_item.id, v_item.name, v_item.unit, v_line.location, v_theory, v_line.counted, v_gap, v_cost, v_pos);
    v_pos := v_pos + 1;

    if v_gap <> 0 then
      update public.stock_items
         set quantity = case when v_line.location = 'depot' then v_line.counted else quantity end,
             kitchen_quantity = case when v_line.location = 'kitchen' then v_line.counted else kitchen_quantity end,
             updated_at = now()
       where id = v_item.id;
      insert into public.stock_movements (batch_id, type, stock_item_id, item_name, unit, quantity, from_location, to_location,
                                          note, unit_cost, inventory_id, user_name)
      values (v_inv.id, 'adjustment', v_item.id, v_item.name, v_item.unit, abs(v_gap),
              case when v_gap < 0 then v_line.location end, case when v_gap > 0 then v_line.location end,
              'Inventaire', v_cost, v_inv.id, v_user);
      v_value := v_value + coalesce(round(v_gap * v_cost, 2), 0);
    end if;
  end loop;

  update public.stock_inventories set line_count = v_pos, gap_value = v_value where id = v_inv.id returning * into v_inv;
  return v_inv;
end $$;
revoke all on function public.record_inventory(jsonb, text) from public, anon;
grant execute on function public.record_inventory(jsonb, text) to authenticated;

-- ───────────── RLS : lecture de l'historique, écriture seulement par record_inventory() ─────────────

alter table public.stock_inventories enable row level security;
alter table public.stock_inventory_lines enable row level security;
drop policy if exists "perm read stock_inventories" on public.stock_inventories;
create policy "perm read stock_inventories" on public.stock_inventories for select to authenticated
  using (public.has_permission('stock_state') or public.has_permission('inventory'));
drop policy if exists "perm read stock_inventory_lines" on public.stock_inventory_lines;
create policy "perm read stock_inventory_lines" on public.stock_inventory_lines for select to authenticated
  using (public.has_permission('stock_state') or public.has_permission('inventory'));
grant select on public.stock_inventories, public.stock_inventory_lines to authenticated;

-- Le stock minimum se règle dans la fiche article (page Ingrédients et produits, permission « stock »), comme le nom
-- et l'unité : les règles d'écriture existantes de stock_items s'appliquent.

-- ───────────── Realtime : l'historique des inventaires suit sur tous les appareils (channel « stock » existant) ─────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stock_inventories') then
    alter publication supabase_realtime add table public.stock_inventories;
  end if;
end $$;

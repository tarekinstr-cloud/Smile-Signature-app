-- Smile Signature: fiches techniques et consommation automatique du stock Cuisine par les ventes.
-- Idempotent: peut être exécuté plusieurs fois sans problème.
-- À exécuter après 20260930090000_stock_state.sql.
--
--   recipe_lines                 Fiches techniques : ingrédients du stock et quantité consommée par portion.
--                                option_id vide : fiche de l'article (commune à toutes les tailles) ;
--                                option_id = une taille (S/M/L…) ou un supplément (ex. fromage = +50 g de fromage).
--                                quantity est dans l'unité du stock ; input_unit / input_quantity gardent la saisie (g pour kg…).
--   stock_items.purchase_unit    Unité d'achat (ex. fardeau) et purchase_factor : 1 unité d'achat = N unités de stock
--   stock_items.purchase_factor  (ex. 1 fardeau = 6 bouteilles). Le stock reste dans l'unité de l'article.
--   Consommation automatique     Quand une commande passe à « payée » (paiement total, partiel soldé ou tout offert), les
--                                ingrédients de ses fiches sortent du stock Cuisine : mouvement « consumption » avec la
--                                référence de la commande. Une seule fois par commande (table order_stock_consumptions),
--                                dans la même transaction que le paiement. Les commandes annulées ne déduisent rien.
--                                Le stock Cuisine peut devenir négatif : une vente n'est jamais bloquée par le stock.
--                                Seules les commandes payées après l'exécution de ce script sont déduites (pas de rétroactif).
--   stock_report(from, to)       + colonne consumption (Consommation (ventes)), comptée dans le stock final.
--   consumption_report(from, to) Consommation théorique (ventes) comparée aux écarts d'inventaire (pertes, gaspillage).
-- Nouvelle permission « recipes » (Modifier les fiches techniques). Par défaut : Admin oui, Employé non.

-- ───────────── Unités d'achat ─────────────

alter table public.stock_items add column if not exists purchase_unit text not null default '';
alter table public.stock_items add column if not exists purchase_factor numeric(12,3);
alter table public.stock_items drop constraint if exists stock_items_purchase_factor_check;
alter table public.stock_items add constraint stock_items_purchase_factor_check check (purchase_factor is null or purchase_factor > 0);
comment on column public.stock_items.purchase_unit is 'Unité d''achat (ex. fardeau), vide : achat dans l''unité du stock.';
comment on column public.stock_items.purchase_factor is '1 unité d''achat = purchase_factor unités de stock (ex. 6 bouteilles).';

-- Ligne de facture achetée en unité d'achat : quantité et prix par unité d'achat, factor = unités de stock par unité.
alter table public.supplier_invoice_items add column if not exists factor numeric(12,3) not null default 1;
alter table public.supplier_invoice_items drop constraint if exists supplier_invoice_items_factor_check;
alter table public.supplier_invoice_items add constraint supplier_invoice_items_factor_check check (factor > 0);

-- Coût par unité de stock : plus précis (700 DA le fardeau de 6 = 116,6667 DA la bouteille).
alter table public.stock_movements alter column unit_cost type numeric(14,4);

-- ───────────── Stock Cuisine négatif autorisé (ventes) ─────────────

alter table public.stock_items drop constraint if exists stock_items_kitchen_quantity_check;

-- ───────────── Mouvements « consumption » ─────────────

alter table public.stock_movements drop constraint if exists stock_movements_type_check;
alter table public.stock_movements add constraint stock_movements_type_check
  check (type in ('purchase', 'transfer', 'return', 'charge', 'adjustment', 'consumption'));
alter table public.stock_movements add column if not exists order_id uuid references public.orders (id) on delete set null;
create index if not exists stock_movements_order on public.stock_movements (order_id) where order_id is not null;

-- ───────────── Fiches techniques ─────────────

create table if not exists public.recipe_lines (
  id              uuid primary key default gen_random_uuid(),
  item_id         uuid not null references public.items (id) on delete cascade,
  option_id       uuid references public.options (id) on delete cascade,
  stock_item_id   uuid not null references public.stock_items (id) on delete cascade,
  quantity        numeric(14,6) not null check (quantity > 0),     -- par portion, dans l'unité du stock
  input_unit      text not null default '',                        -- unité saisie (g, ml, cl…)
  input_quantity  numeric(14,4),                                   -- quantité saisie
  position        integer not null default 0,
  updated_at      timestamptz not null default now()
);
create unique index if not exists recipe_lines_unique
  on public.recipe_lines (item_id, coalesce(option_id, '00000000-0000-0000-0000-000000000000'::uuid), stock_item_id);
create index if not exists recipe_lines_option on public.recipe_lines (option_id) where option_id is not null;
comment on table public.recipe_lines is 'Fiches techniques, écrites seulement par save_recipe().';

-- Date d'activation : les commandes payées avant ne sont jamais déduites.
create table if not exists public.recipe_settings (
  id                      boolean primary key default true check (id),
  consumption_started_at  timestamptz not null default now()
);
insert into public.recipe_settings (id) values (true) on conflict (id) do nothing;

-- Une ligne par commande déduite : la garantie « jamais deux fois ».
create table if not exists public.order_stock_consumptions (
  order_id    uuid primary key references public.orders (id) on delete cascade,
  status      text not null default 'done' check (status in ('done', 'error')),
  lines       integer not null default 0,
  error       text,
  created_at  timestamptz not null default now()
);

-- ───────────── Permission « recipes » ─────────────

alter table public.role_permissions drop constraint if exists role_permissions_permission_check;
alter table public.role_permissions add constraint role_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stock_state', 'inventory',
  'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount'));
alter table public.user_permissions drop constraint if exists user_permissions_permission_check;
alter table public.user_permissions add constraint user_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stock_state', 'inventory',
  'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount'));

insert into public.role_permissions (role, permission, allowed)
values ('admin', 'recipes', true), ('employe', 'recipes', false)
on conflict (role, permission) do nothing;

create or replace function public.my_permissions()
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p order by p), '{}')
  from unnest(array['staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges',
                    'stock_state', 'inventory', 'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations',
                    'delivery_zones', 'cancel_order', 'offer', 'discount']) p
  where public.has_permission(p)
$$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- ───────────── Dernier prix d'achat : par unité de stock ─────────────

create or replace function public.last_purchase_price(p_item_id uuid)
returns numeric
language sql stable security definer set search_path = public as $$
  select round(ii.unit_price / ii.factor, 4)
  from public.supplier_invoice_items ii
  join public.supplier_invoices i on i.id = ii.invoice_id
  where ii.stock_item_id = p_item_id
  order by i.date desc, i.created_at desc, ii.position desc
  limit 1
$$;
revoke all on function public.last_purchase_price(uuid) from public, anon;
grant execute on function public.last_purchase_price(uuid) to authenticated;

-- État du stock : même fonction que 20260930090000_stock_state.sql, prix par unité de stock et unité d'achat en plus.
drop function if exists public.stock_state();
create or replace function public.stock_state()
returns table (
  id uuid, name text, unit text, quantity numeric, kitchen_quantity numeric, min_quantity numeric, updated_at timestamptz,
  last_price numeric, last_supplier_id uuid, last_supplier_name text, suppliers jsonb, purchase_unit text, purchase_factor numeric
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.has_permission('stock_state') or public.has_permission('inventory')) then
    raise exception 'no_permission';
  end if;
  return query
    select s.id, s.name, s.unit, s.quantity, s.kitchen_quantity, s.min_quantity, s.updated_at,
           round(lp.unit_price / lp.factor, 4), lp.supplier_id, lp.supplier_name,
           coalesce((select jsonb_agg(distinct jsonb_build_object('id', i.supplier_id, 'name', i.supplier_name))
                       from public.supplier_invoice_items ii
                       join public.supplier_invoices i on i.id = ii.invoice_id
                      where ii.stock_item_id = s.id and i.supplier_id is not null), '[]'::jsonb),
           s.purchase_unit, s.purchase_factor
      from public.stock_items s
      left join lateral (
        select ii.unit_price, ii.factor, i.supplier_id, i.supplier_name
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

-- ───────────── Effectuer un achat : en unité de stock ou en unité d'achat ─────────────
-- Même fonction que 20260930080000_stock_locations.sql. Une ligne dont l'unité est l'unité d'achat de l'article
-- (ex. 2 fardeaux à 700 DA) ajoute quantité × coefficient au stock (12 bouteilles) ; le mouvement garde le prix par
-- unité de stock (116,6667 DA). Le coefficient est toujours lu sur l'article, jamais envoyé par l'appareil.

create or replace function public.create_supplier_purchase(p_supplier_id uuid, p_date date, p_lines jsonb, p_paid numeric)
returns public.supplier_invoices
language plpgsql security definer set search_path = public as $$
declare
  v_supplier public.suppliers;
  v_invoice public.supplier_invoices;
  v_line jsonb;
  v_item public.stock_items;
  v_qty numeric;
  v_price numeric;
  v_unit text;
  v_factor numeric;
  v_total numeric := 0;
  v_paid numeric := round(coalesce(p_paid, 0), 2);
  v_pos integer := 0;
  v_batch uuid := gen_random_uuid();
  v_user text := public.current_user_name();
begin
  if not public.has_permission('purchases') then
    raise exception 'no_permission';
  end if;
  select * into v_supplier from public.suppliers where id = p_supplier_id;
  if not found then
    raise exception 'supplier_not_found';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'no_lines';
  end if;
  perform public.stock_rpc_begin();

  insert into public.supplier_invoices (supplier_id, supplier_name, date, total_amount)
  values (v_supplier.id, v_supplier.name, coalesce(p_date, current_date), 0)
  returning * into v_invoice;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := (v_line ->> 'quantity')::numeric;
    v_price := round((v_line ->> 'unit_price')::numeric, 2);
    v_unit := trim(coalesce(v_line ->> 'unit', ''));
    if v_qty is null or v_qty <= 0 then
      raise exception 'bad_quantity';
    end if;
    if v_price is null or v_price < 0 then
      raise exception 'bad_price';
    end if;
    select * into v_item from public.stock_items where id = (v_line ->> 'stock_item_id')::uuid for update;
    if not found then
      raise exception 'stock_item_not_found';
    end if;
    v_factor := case
      when v_item.purchase_factor is not null and v_item.purchase_unit <> '' and lower(v_unit) = lower(trim(v_item.purchase_unit))
        then v_item.purchase_factor
      else 1 end;
    -- + quantité achetée (en unités de stock) au Dépôt ; l'unité de l'article est remplie s'il n'en avait pas.
    update public.stock_items
       set quantity = quantity + round(v_qty * v_factor, 3),
           unit = case when unit = '' and v_factor = 1 then v_unit else unit end,
           updated_at = now()
     where id = v_item.id
    returning * into v_item;
    insert into public.supplier_invoice_items (invoice_id, stock_item_id, item_name, quantity, unit, unit_price, position, factor)
    values (v_invoice.id, v_item.id, v_item.name, v_qty, coalesce(nullif(v_unit, ''), v_item.unit), v_price, v_pos, v_factor);
    insert into public.stock_movements (batch_id, type, stock_item_id, item_name, unit, quantity, to_location, unit_cost, invoice_id, user_name)
    values (v_batch, 'purchase', v_item.id, v_item.name, v_item.unit, round(v_qty * v_factor, 3), 'depot', round(v_price / v_factor, 4),
            v_invoice.id, v_user);
    v_total := v_total + round(v_qty * v_price, 2);
    v_pos := v_pos + 1;
  end loop;

  if v_paid < 0 or v_paid > v_total then
    raise exception 'bad_paid_amount';
  end if;
  if v_paid > 0 then
    insert into public.supplier_invoice_payments (invoice_id, amount, date) values (v_invoice.id, v_paid, v_invoice.date);
  end if;

  update public.supplier_invoices
     set total_amount = v_total, paid_amount = v_paid, payment_status = public.supplier_payment_status(v_total, v_paid)
   where id = v_invoice.id
  returning * into v_invoice;
  return v_invoice;
end $$;
revoke all on function public.create_supplier_purchase(uuid, date, jsonb, numeric) from public, anon;
grant execute on function public.create_supplier_purchase(uuid, date, jsonb, numeric) to authenticated;

-- ───────────── Fiches techniques : lecture et enregistrement ─────────────

-- Ingrédients pour l'écran Fiche technique : unité, unité d'achat et dernier prix par unité de stock (coût de revient).
create or replace function public.recipe_stock_items()
returns table (id uuid, name text, unit text, purchase_unit text, purchase_factor numeric, last_price numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.has_permission('recipes') or public.has_permission('stock_state')) then
    raise exception 'no_permission';
  end if;
  return query
    select s.id, s.name, s.unit, s.purchase_unit, s.purchase_factor, public.last_purchase_price(s.id)
      from public.stock_items s
     order by s.name;
end $$;
revoke all on function public.recipe_stock_items() from public, anon;
grant execute on function public.recipe_stock_items() to authenticated;

-- Remplace toute la fiche d'un article (base, tailles et suppléments) en une transaction.
-- p_lines : [{"option_id": null | "…", "stock_item_id": "…", "quantity": 0.05, "input_unit": "g", "input_quantity": 50}, …]
create or replace function public.save_recipe(p_item_id uuid, p_lines jsonb)
returns setof public.recipe_lines
language plpgsql security definer set search_path = public as $$
declare
  v_line jsonb;
  v_option uuid;
  v_qty numeric;
  v_pos integer := 0;
begin
  if not public.has_permission('recipes') then
    raise exception 'no_permission';
  end if;
  perform 1 from public.items where id = p_item_id for update;
  if not found then
    raise exception 'item_not_found';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'no_lines';
  end if;
  delete from public.recipe_lines where item_id = p_item_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_option := nullif(v_line ->> 'option_id', '')::uuid;
    v_qty := round((v_line ->> 'quantity')::numeric, 6);
    if v_qty is null or v_qty <= 0 then
      raise exception 'bad_quantity';
    end if;
    if v_option is not null and not exists (
      select 1 from public.options o join public.option_groups g on g.id = o.group_id where o.id = v_option and g.item_id = p_item_id) then
      raise exception 'option_not_found';
    end if;
    if not exists (select 1 from public.stock_items where id = (v_line ->> 'stock_item_id')::uuid) then
      raise exception 'stock_item_not_found';
    end if;
    begin
      insert into public.recipe_lines (item_id, option_id, stock_item_id, quantity, input_unit, input_quantity, position)
      values (p_item_id, v_option, (v_line ->> 'stock_item_id')::uuid, v_qty, trim(coalesce(v_line ->> 'input_unit', '')),
              round((v_line ->> 'input_quantity')::numeric, 4), v_pos);
    exception when unique_violation then
      raise exception 'duplicate_ingredient';
    end;
    v_pos := v_pos + 1;
  end loop;

  return query select * from public.recipe_lines where item_id = p_item_id order by position;
end $$;
revoke all on function public.save_recipe(uuid, jsonb) from public, anon;
grant execute on function public.save_recipe(uuid, jsonb) to authenticated;

alter table public.recipe_lines enable row level security;
drop policy if exists "staff read recipe_lines" on public.recipe_lines;
create policy "staff read recipe_lines" on public.recipe_lines for select to authenticated using (true);
grant select on public.recipe_lines to authenticated;

alter table public.recipe_settings enable row level security;
drop policy if exists "staff read recipe_settings" on public.recipe_settings;
create policy "staff read recipe_settings" on public.recipe_settings for select to authenticated using (true);
grant select on public.recipe_settings to authenticated;

alter table public.order_stock_consumptions enable row level security;
drop policy if exists "perm read order_stock_consumptions" on public.order_stock_consumptions;
create policy "perm read order_stock_consumptions" on public.order_stock_consumptions for select to authenticated
  using (public.has_permission('stock_state') or public.has_permission('recipes'));
grant select on public.order_stock_consumptions to authenticated;

-- ───────────── Consommation d'une commande ─────────────

-- Besoins d'une commande, par ingrédient : pour chaque ligne, (fiche de l'article + fiche de chaque option choisie :
-- taille, suppléments) × nombre de portions. Les options sont retrouvées par option_id (lignes récentes) ou par
-- groupe + nom (lignes plus anciennes). Les articles sans fiche ne donnent rien.
create or replace function public.order_consumption_needs(p_order_id uuid)
returns table (stock_item_id uuid, quantity numeric)
language sql stable security definer set search_path = public as $$
  with l as (
    select oi.id, oi.item_id, oi.quantity, case when jsonb_typeof(oi.options) = 'array' then oi.options else '[]'::jsonb end as options
      from public.order_items oi
     where oi.order_id = p_order_id and oi.item_id is not null
  ), chosen as (
    select distinct l.id as line_id, l.quantity, o.id as option_id
      from l
      cross join lateral jsonb_array_elements(l.options) c
      join public.option_groups g on g.item_id = l.item_id
      join public.options o on o.group_id = g.id
     where case when (c ->> 'option_id') is not null then o.id::text = c ->> 'option_id'
                else lower(trim(g.name)) = lower(trim(c ->> 'group')) and lower(trim(o.name)) = lower(trim(c ->> 'name')) end
  ), needs as (
    select r.stock_item_id, l.quantity * r.quantity as q
      from l join public.recipe_lines r on r.item_id = l.item_id and r.option_id is null
    union all
    select r.stock_item_id, c.quantity * r.quantity
      from chosen c join public.recipe_lines r on r.option_id = c.option_id
  )
  select n.stock_item_id, round(sum(n.q), 3)
    from needs n
   group by n.stock_item_id
  having round(sum(n.q), 3) > 0
   order by n.stock_item_id
$$;
revoke all on function public.order_consumption_needs(uuid) from public, anon, authenticated;

-- Déduit une commande payée du stock Cuisine, une seule fois. Renvoie le nombre d'ingrédients déduits.
-- Idempotent : la ligne de order_stock_consumptions est posée d'abord ; un deuxième appel (autre appareil, double clic,
-- reconnexion) la trouve et s'arrête. Les articles sont verrouillés dans l'ordre des id, comme les autres fonctions du
-- stock (pas d'interblocage). Pas de contrôle de quantité : le stock Cuisine peut devenir négatif.
create or replace function public.stock_consume_order(p_order_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_started timestamptz;
  v_need record;
  v_item public.stock_items;
  v_batch uuid := gen_random_uuid();
  v_user text := public.current_user_name();
  v_note text;
  v_n integer := 0;
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found or v_order.status <> 'paid' then
    return 0;
  end if;
  select consumption_started_at into v_started from public.recipe_settings where id;
  if v_started is null or coalesce(v_order.closed_at, now()) < v_started then
    return 0;
  end if;
  insert into public.order_stock_consumptions (order_id, status) values (p_order_id, 'done') on conflict (order_id) do nothing;
  if not found then
    return 0;
  end if;
  perform public.stock_rpc_begin();
  v_note := 'Commande' || coalesce(' n° ' || v_order.ticket_no, '');

  for v_need in select * from public.order_consumption_needs(p_order_id) loop
    select * into v_item from public.stock_items where id = v_need.stock_item_id for update;
    continue when not found;
    update public.stock_items
       set kitchen_quantity = kitchen_quantity - v_need.quantity, updated_at = now()
     where id = v_item.id;
    insert into public.stock_movements (batch_id, type, stock_item_id, item_name, unit, quantity, from_location, note, unit_cost, order_id, user_name)
    values (v_batch, 'consumption', v_item.id, v_item.name, v_item.unit, v_need.quantity, 'kitchen', v_note,
            public.last_purchase_price(v_item.id), p_order_id, v_user);
    v_n := v_n + 1;
  end loop;

  update public.order_stock_consumptions set lines = v_n where order_id = p_order_id;
  return v_n;
end $$;
revoke all on function public.stock_consume_order(uuid) from public, anon, authenticated;

-- Au passage à « payée » (add_payment, même transaction). Une erreur inattendue ne bloque jamais la vente : la
-- commande est notée « error » et peut être déduite plus tard (retry_stock_consumptions).
create or replace function public.orders_consume_stock() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.stock_consume_order(new.id);
  exception when others then
    insert into public.order_stock_consumptions (order_id, status, error) values (new.id, 'error', sqlerrm)
    on conflict (order_id) do update set status = 'error', error = excluded.error;
    raise warning 'stock consumption failed for order %: %', new.id, sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists orders_consume_stock on public.orders;
create trigger orders_consume_stock after update of status on public.orders
  for each row when (new.status = 'paid' and old.status is distinct from 'paid')
  execute function public.orders_consume_stock();

-- Relance les commandes en erreur. Renvoie le nombre de commandes déduites.
create or replace function public.retry_stock_consumptions()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_n integer := 0;
begin
  if not (public.has_permission('stock_state') or public.has_permission('recipes')) then
    raise exception 'no_permission';
  end if;
  for v_id in select order_id from public.order_stock_consumptions where status = 'error' order by created_at loop
    -- Supprimée ici : si un autre appareil relance en même temps, il ne la trouve plus.
    delete from public.order_stock_consumptions where order_id = v_id and status = 'error';
    continue when not found;
    begin
      perform public.stock_consume_order(v_id);
      v_n := v_n + 1;
    exception when others then
      insert into public.order_stock_consumptions (order_id, status, error) values (v_id, 'error', sqlerrm)
      on conflict (order_id) do update set status = 'error', error = excluded.error;
    end;
  end loop;
  return v_n;
end $$;
revoke all on function public.retry_stock_consumptions() from public, anon;
grant execute on function public.retry_stock_consumptions() to authenticated;

-- ───────────── Mouvements par période : + Consommation (ventes) ─────────────
-- Même calcul que 20260930090000_stock_state.sql :
-- initial + purchases − charges − consumption + adjustments = final (Dépôt + Cuisine).

drop function if exists public.stock_report(timestamptz, timestamptz);
create or replace function public.stock_report(p_from timestamptz, p_to timestamptz)
returns table (
  id uuid, name text, unit text,
  initial_depot numeric, initial_kitchen numeric,
  purchases numeric, transfers numeric, returns numeric, charges numeric, consumption numeric, adjustments numeric,
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
             sum(case when m.created_at < p_to and m.type = 'consumption' then m.quantity else 0 end) as consumption,
             sum(case when m.created_at < p_to and m.type = 'adjustment' then m.d_depot + m.d_kitchen else 0 end) as adjustments
        from m
       group by m.stock_item_id
    )
    select s.id, s.name, s.unit,
           s.quantity - coalesce(a.since_from_depot, 0), s.kitchen_quantity - coalesce(a.since_from_kitchen, 0),
           coalesce(a.purchases, 0), coalesce(a.transfers, 0), coalesce(a.returns, 0), coalesce(a.charges, 0),
           coalesce(a.consumption, 0), coalesce(a.adjustments, 0),
           s.quantity - coalesce(a.since_to_depot, 0), s.kitchen_quantity - coalesce(a.since_to_kitchen, 0)
      from public.stock_items s
      left join agg a on a.stock_item_id = s.id
     order by s.name;
end $$;
revoke all on function public.stock_report(timestamptz, timestamptz) from public, anon;
grant execute on function public.stock_report(timestamptz, timestamptz) to authenticated;

-- ───────────── Consommation théorique vs réelle ─────────────
-- Sur [p_from, p_to[, par article :
--   theoretical      consommation calculée par les ventes (mouvements « consumption »)
--   charges          sorties déclarées (charges cuisine : pertes, casse, repas personnel…)
--   inventory_gap    écarts d'inventaire (compté − théorique), signés : négatif = il manque du stock
--   actual           consommation réelle = theoretical + charges − inventory_gap
-- Un écart d'inventaire négatif est ce que les ventes et les charges n'expliquent pas : pertes, gaspillage, portions
-- plus grosses que la fiche. last_price valorise l'écart.

create or replace function public.consumption_report(p_from timestamptz, p_to timestamptz)
returns table (
  id uuid, name text, unit text, theoretical numeric, charges numeric, inventory_gap numeric, actual numeric, last_price numeric
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
    with agg as (
      select sm.stock_item_id,
             sum(case when sm.type = 'consumption' then sm.quantity else 0 end) as theoretical,
             sum(case when sm.type = 'charge' then sm.quantity else 0 end) as charges,
             sum(case when sm.type = 'adjustment' and sm.inventory_id is not null
                      then (case when sm.to_location is not null then sm.quantity else 0 end)
                         - (case when sm.from_location is not null then sm.quantity else 0 end)
                      else 0 end) as inventory_gap
        from public.stock_movements sm
       where sm.created_at >= p_from and sm.created_at < p_to and sm.stock_item_id is not null
         and sm.type in ('consumption', 'charge', 'adjustment')
       group by sm.stock_item_id
    )
    select s.id, s.name, s.unit, a.theoretical, a.charges, a.inventory_gap,
           a.theoretical + a.charges - a.inventory_gap, public.last_purchase_price(s.id)
      from agg a
      join public.stock_items s on s.id = a.stock_item_id
     where a.theoretical <> 0 or a.charges <> 0 or a.inventory_gap <> 0
     order by s.name;
end $$;
revoke all on function public.consumption_report(timestamptz, timestamptz) from public, anon;
grant execute on function public.consumption_report(timestamptz, timestamptz) to authenticated;

-- ───────────── Realtime : les fiches suivent sur tous les appareils (channel « stock » existant) ─────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'recipe_lines') then
    alter publication supabase_realtime add table public.recipe_lines;
  end if;
end $$;

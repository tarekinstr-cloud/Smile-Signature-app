-- Smile Signature: emplacements de stock (Dépôt / Cuisine), transferts, charges cuisine et mouvements de stock
-- Idempotent: peut être exécuté plusieurs fois sans problème.
-- À exécuter après 20260930070000_supplier_purchases.sql.
--
-- Chaque article du stock a deux quantités :
--   quantity          Qté Dépôt (la colonne existante : les quantités actuelles deviennent le stock du Dépôt)
--   kitchen_quantity  Qté Cuisine (0 au départ)
-- Les achats (Effectuer un achat) et les ajustements ± de la page Stock se font sur le Dépôt.
-- Transfert dépôt → cuisine, retour cuisine → dépôt, et charges cuisine (sortie du stock Cuisine avec un motif).
-- Chaque mouvement est tracé dans stock_movements (type, article, quantité, emplacements, utilisateur, date).
-- Les quantités ne changent que par les fonctions ci-dessous, en une seule transaction qui verrouille les lignes :
-- deux appareils qui agissent en même temps ne peuvent pas rendre un stock négatif.
-- Nouvelles permissions : « stock_transfer » (Transfert dépôt / cuisine) et « kitchen_charges » (Charges cuisine).
-- Par défaut : Admin oui, Employé non (réglable dans Fichier > Permissions).

-- ───────────── Qté Cuisine ─────────────

alter table public.stock_items add column if not exists kitchen_quantity numeric(12,3) not null default 0;
alter table public.stock_items drop constraint if exists stock_items_kitchen_quantity_check;
alter table public.stock_items add constraint stock_items_kitchen_quantity_check check (kitchen_quantity >= 0);

comment on column public.stock_items.quantity is 'Quantité au Dépôt.';
comment on column public.stock_items.kitchen_quantity is 'Quantité en Cuisine.';

-- ───────────── Mouvements de stock ─────────────

create table if not exists public.stock_movements (
  id             uuid primary key default gen_random_uuid(),
  batch_id       uuid not null,                               -- une opération (plusieurs articles transférés ensemble)
  type           text not null check (type in ('purchase', 'transfer', 'return', 'charge', 'adjustment')),
  stock_item_id  uuid references public.stock_items (id) on delete set null,
  item_name      text not null default '',                    -- gardé si l'article est supprimé du stock
  unit           text not null default '',
  quantity       numeric(12,3) not null check (quantity > 0),
  from_location  text check (from_location in ('depot', 'kitchen')),   -- null : entrée (achat, ajustement +)
  to_location    text check (to_location in ('depot', 'kitchen')),     -- null : sortie (charge, ajustement −)
  reason         text check (reason in ('consumption', 'loss', 'breakage', 'staff_meal', 'other')),  -- charges
  note           text not null default '',
  unit_cost      numeric(12,2),                               -- achat : prix unitaire ; charge : dernier prix d'achat
  invoice_id     uuid references public.supplier_invoices (id) on delete set null,
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  user_name      text not null default '',                    -- employé connecté, gardé si le compte est supprimé
  created_at     timestamptz not null default now(),
  constraint stock_movements_charge_reason check ((type = 'charge') = (reason is not null))
);

create index if not exists stock_movements_type_date on public.stock_movements (type, created_at desc);
create index if not exists stock_movements_item_date on public.stock_movements (stock_item_id, created_at desc);

comment on table public.stock_movements is 'Mouvements de stock (achat, transfert, retour, charge, ajustement), écrits seulement par les fonctions du stock.';

-- ───────────── Permissions « stock_transfer » et « kitchen_charges » ─────────────

alter table public.role_permissions drop constraint if exists role_permissions_permission_check;
alter table public.role_permissions add constraint role_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stats', 'settings', 'edit',
  'backup', 'ticket', 'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount'));
alter table public.user_permissions drop constraint if exists user_permissions_permission_check;
alter table public.user_permissions add constraint user_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stats', 'settings', 'edit',
  'backup', 'ticket', 'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount'));

insert into public.role_permissions (role, permission, allowed)
values ('admin', 'stock_transfer', true), ('employe', 'stock_transfer', false),
       ('admin', 'kitchen_charges', true), ('employe', 'kitchen_charges', false)
on conflict (role, permission) do nothing;

create or replace function public.my_permissions()
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p order by p), '{}')
  from unnest(array['staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stats',
                    'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount']) p
  where public.has_permission(p)
$$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- ───────────── Garde : les quantités ne changent que par les fonctions du stock ─────────────

-- Les fonctions du stock posent ce drapeau le temps de leur transaction.
create or replace function public.stock_rpc_begin()
returns void
language sql set search_path = public as $$
  select set_config('smile.stock_rpc', 'on', true)
$$;
revoke all on function public.stock_rpc_begin() from public, anon, authenticated;

create or replace function public.stock_items_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  -- Le SQL Editor (sans utilisateur) et les fonctions du stock passent.
  if auth.uid() is null or current_setting('smile.stock_rpc', true) = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    -- Un nouvel article commence au Dépôt (Qté initiale) ; rien en Cuisine sans transfert.
    new.kitchen_quantity := 0;
    if new.quantity < 0 then
      raise exception 'bad_quantity';
    end if;
  elsif new.quantity is distinct from old.quantity or new.kitchen_quantity is distinct from old.kitchen_quantity then
    raise exception 'stock_direct_update';
  end if;
  return new;
end $$;
drop trigger if exists stock_items_guard on public.stock_items;
create trigger stock_items_guard before insert or update on public.stock_items
  for each row execute function public.stock_items_guard();

-- Nom de l'employé connecté, gardé dans chaque mouvement.
create or replace function public.current_user_name()
returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select coalesce(nullif(trim(a.display_name), ''), a.username) from public.app_users a where a.user_id = auth.uid()), '')
$$;
revoke all on function public.current_user_name() from public, anon;
grant execute on function public.current_user_name() to authenticated;

-- La quantité initiale d'un nouvel article est tracée comme un ajustement + au Dépôt.
create or replace function public.stock_items_log_initial() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.quantity > 0 then
    insert into public.stock_movements (batch_id, type, stock_item_id, item_name, unit, quantity, to_location, note, user_name)
    values (gen_random_uuid(), 'adjustment', new.id, new.name, new.unit, new.quantity, 'depot', '', public.current_user_name());
  end if;
  return new;
end $$;
drop trigger if exists stock_items_log_initial on public.stock_items;
create trigger stock_items_log_initial after insert on public.stock_items
  for each row execute function public.stock_items_log_initial();

-- Stock insuffisant : message lisible par l'app (article, disponible, demandé, unité, emplacement).
create or replace function public.stock_insufficient(p_item public.stock_items, p_requested numeric, p_location text)
returns void
language plpgsql set search_path = public as $$
begin
  raise exception '%', 'insufficient_stock ' || json_build_object(
    'item', p_item.name, 'unit', p_item.unit, 'location', p_location, 'requested', p_requested,
    'available', case when p_location = 'kitchen' then p_item.kitchen_quantity else p_item.quantity end)::text;
end $$;
revoke all on function public.stock_insufficient(public.stock_items, numeric, text) from public, anon, authenticated;

-- Lignes d'une opération : [{"stock_item_id": "…", "quantity": 2.5}, …], le même article additionné,
-- triées par article pour verrouiller les lignes toujours dans le même ordre (pas d'interblocage entre appareils).
create or replace function public.stock_lines(p_lines jsonb)
returns table (stock_item_id uuid, quantity numeric)
language plpgsql immutable set search_path = public as $$
declare
  v_line jsonb;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'no_lines';
  end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    if (v_line ->> 'stock_item_id') is null then
      raise exception 'stock_item_not_found';
    end if;
    if (v_line ->> 'quantity') is null or (v_line ->> 'quantity')::numeric <= 0 then
      raise exception 'bad_quantity';
    end if;
  end loop;
  return query
    select (e ->> 'stock_item_id')::uuid, round(sum((e ->> 'quantity')::numeric), 3)
    from jsonb_array_elements(p_lines) e
    group by 1
    order by 1;
end $$;
revoke all on function public.stock_lines(jsonb) from public, anon, authenticated;

-- ───────────── Transfert dépôt → cuisine, retour cuisine → dépôt ─────────────
-- p_direction : 'to_kitchen' (transfert) ou 'to_depot' (retour). Tout ou rien : un article en quantité insuffisante
-- annule toute l'opération.

create or replace function public.transfer_stock(p_direction text, p_lines jsonb, p_note text)
returns setof public.stock_movements
language plpgsql security definer set search_path = public as $$
declare
  v_line record;
  v_item public.stock_items;
  v_batch uuid := gen_random_uuid();
  v_user text := public.current_user_name();
  v_from text;
  v_to text;
begin
  if not public.has_permission('stock_transfer') then
    raise exception 'no_permission';
  end if;
  if p_direction = 'to_kitchen' then
    v_from := 'depot'; v_to := 'kitchen';
  elsif p_direction = 'to_depot' then
    v_from := 'kitchen'; v_to := 'depot';
  else
    raise exception 'bad_direction';
  end if;
  perform public.stock_rpc_begin();

  for v_line in select * from public.stock_lines(p_lines) loop
    -- Verrou sur l'article, puis contrôle de la quantité disponible à la source.
    select * into v_item from public.stock_items where id = v_line.stock_item_id for update;
    if not found then
      raise exception 'stock_item_not_found';
    end if;
    if (case when v_from = 'depot' then v_item.quantity else v_item.kitchen_quantity end) < v_line.quantity then
      perform public.stock_insufficient(v_item, v_line.quantity, v_from);
    end if;
    update public.stock_items
       set quantity = quantity + case when v_to = 'depot' then v_line.quantity else -v_line.quantity end,
           kitchen_quantity = kitchen_quantity + case when v_to = 'kitchen' then v_line.quantity else -v_line.quantity end,
           updated_at = now()
     where id = v_item.id;
    return query
      insert into public.stock_movements (batch_id, type, stock_item_id, item_name, unit, quantity, from_location, to_location, note, user_name)
      values (v_batch, case when v_to = 'kitchen' then 'transfer' else 'return' end, v_item.id, v_item.name, v_item.unit,
              v_line.quantity, v_from, v_to, trim(coalesce(p_note, '')), v_user)
      returning *;
  end loop;
end $$;
revoke all on function public.transfer_stock(text, jsonb, text) from public, anon;
grant execute on function public.transfer_stock(text, jsonb, text) to authenticated;

-- ───────────── Charges cuisine ─────────────
-- Sortie du stock Cuisine avec un motif : consumption (Consommation), loss (Perte / Périmé), breakage (Casse),
-- staff_meal (Repas personnel), other (Autre). La valeur estimée utilise le dernier prix d'achat de l'article.

create or replace function public.last_purchase_price(p_item_id uuid)
returns numeric
language sql stable security definer set search_path = public as $$
  select ii.unit_price
  from public.supplier_invoice_items ii
  join public.supplier_invoices i on i.id = ii.invoice_id
  where ii.stock_item_id = p_item_id
  order by i.date desc, i.created_at desc, ii.position desc
  limit 1
$$;
revoke all on function public.last_purchase_price(uuid) from public, anon;
grant execute on function public.last_purchase_price(uuid) to authenticated;

create or replace function public.record_kitchen_charge(p_reason text, p_lines jsonb, p_note text)
returns setof public.stock_movements
language plpgsql security definer set search_path = public as $$
declare
  v_line record;
  v_item public.stock_items;
  v_batch uuid := gen_random_uuid();
  v_user text := public.current_user_name();
begin
  if not public.has_permission('kitchen_charges') then
    raise exception 'no_permission';
  end if;
  if p_reason is null or p_reason not in ('consumption', 'loss', 'breakage', 'staff_meal', 'other') then
    raise exception 'bad_reason';
  end if;
  perform public.stock_rpc_begin();

  for v_line in select * from public.stock_lines(p_lines) loop
    select * into v_item from public.stock_items where id = v_line.stock_item_id for update;
    if not found then
      raise exception 'stock_item_not_found';
    end if;
    if v_item.kitchen_quantity < v_line.quantity then
      perform public.stock_insufficient(v_item, v_line.quantity, 'kitchen');
    end if;
    update public.stock_items
       set kitchen_quantity = kitchen_quantity - v_line.quantity, updated_at = now()
     where id = v_item.id;
    return query
      insert into public.stock_movements (batch_id, type, stock_item_id, item_name, unit, quantity, from_location, reason, note, unit_cost, user_name)
      values (v_batch, 'charge', v_item.id, v_item.name, v_item.unit, v_line.quantity, 'kitchen', p_reason,
              trim(coalesce(p_note, '')), public.last_purchase_price(v_item.id), v_user)
      returning *;
  end loop;
end $$;
revoke all on function public.record_kitchen_charge(text, jsonb, text) from public, anon;
grant execute on function public.record_kitchen_charge(text, jsonb, text) to authenticated;

-- ───────────── Ajustement ± (page Stock) : sur le Dépôt, tracé, jamais en dessous de 0 ─────────────

create or replace function public.adjust_stock(p_item_id uuid, p_delta numeric)
returns public.stock_items
language plpgsql security definer set search_path = public as $$
declare
  v_row public.stock_items;
begin
  if not public.has_permission('stock') then
    raise exception 'no_permission';
  end if;
  if p_delta is null or p_delta = 0 then
    raise exception 'bad_quantity';
  end if;
  perform public.stock_rpc_begin();
  select * into v_row from public.stock_items where id = p_item_id for update;
  if not found then
    raise exception 'stock_item_not_found';
  end if;
  if p_delta < 0 and v_row.quantity < -p_delta then
    perform public.stock_insufficient(v_row, -p_delta, 'depot');
  end if;
  update public.stock_items
     set quantity = quantity + p_delta, updated_at = now()
   where id = p_item_id
  returning * into v_row;
  insert into public.stock_movements (batch_id, type, stock_item_id, item_name, unit, quantity, from_location, to_location, user_name)
  values (gen_random_uuid(), 'adjustment', v_row.id, v_row.name, v_row.unit, abs(p_delta),
          case when p_delta < 0 then 'depot' end, case when p_delta > 0 then 'depot' end, public.current_user_name());
  return v_row;
end $$;
revoke all on function public.adjust_stock(uuid, numeric) from public, anon;
grant execute on function public.adjust_stock(uuid, numeric) to authenticated;

-- ───────────── Effectuer un achat : alimente le Dépôt, tracé comme mouvement « purchase » ─────────────
-- Même fonction que 20260930070000_supplier_purchases.sql, plus le mouvement de chaque ligne.

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
    -- + quantité achetée au Dépôt ; l'unité de l'article est remplie s'il n'en avait pas.
    update public.stock_items
       set quantity = quantity + v_qty,
           unit = case when unit = '' then v_unit else unit end,
           updated_at = now()
     where id = (v_line ->> 'stock_item_id')::uuid
    returning * into v_item;
    if not found then
      raise exception 'stock_item_not_found';
    end if;
    insert into public.supplier_invoice_items (invoice_id, stock_item_id, item_name, quantity, unit, unit_price, position)
    values (v_invoice.id, v_item.id, v_item.name, v_qty, coalesce(nullif(v_unit, ''), v_item.unit), v_price, v_pos);
    insert into public.stock_movements (batch_id, type, stock_item_id, item_name, unit, quantity, to_location, unit_cost, invoice_id, user_name)
    values (v_batch, 'purchase', v_item.id, v_item.name, v_item.unit, v_qty, 'depot', v_price, v_invoice.id, v_user);
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

-- ───────────── RLS : lecture des mouvements, écriture seulement par les fonctions ci-dessus ─────────────

alter table public.stock_movements enable row level security;
drop policy if exists "perm stock read stock_movements" on public.stock_movements;
create policy "perm stock read stock_movements" on public.stock_movements for select to authenticated
  using (public.has_permission('stock') or public.has_permission('stock_transfer') or public.has_permission('kitchen_charges'));
grant select on public.stock_movements to authenticated;

-- Pour choisir les articles d'un transfert ou d'une charge sans avoir « stock ».
drop policy if exists "perm transfer read stock_items" on public.stock_items;
create policy "perm transfer read stock_items" on public.stock_items for select to authenticated
  using (public.has_permission('stock_transfer') or public.has_permission('kitchen_charges'));

-- ───────────── Realtime : mêmes mises à jour sur tous les appareils (channel « stock » existant) ─────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stock_movements') then
    alter publication supabase_realtime add table public.stock_movements;
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Factures fournisseurs : annuler, corriger, retour partiel (à exécuter après 20260930160000_salary_prorata.sql).
--
-- • Annuler la facture (motif obligatoire) : la facture n'est jamais supprimée, elle passe au statut « Annulée ».
--   Les quantités qu'elle a fait entrer sortent du Dépôt (mouvements « purchase_cancel ») ; si le Dépôt n'en a plus
--   assez (déjà transféré en cuisine ou consommé), la fonction refuse avec le détail par article
--   (insufficient_depot {json}) ; avec confirmation, elle retire ce qui reste au Dépôt puis le reste de la Cuisine
--   (la Cuisine peut devenir négative, signalée dans État du stock).
--   Si la facture a été réglée depuis la caisse (Fond de sortie lié), le montant revient dans les espèces attendues
--   de la journée ouverte (Fond d'entrée automatique « Annulation facture fournisseur ») ; il faut une journée ouverte.
--   Réglée hors caisse : aucun impact caisse. Le dernier prix d'achat ignore les factures annulées ; les coûts déjà
--   figés sur les ventes passées ne changent pas.
-- • Modifier (corriger) : l'ancienne facture est annulée et une nouvelle est créée, liée (« remplace la facture n° X ») ;
--   les règlements déjà faits passent sur la nouvelle facture (pas de mouvement de caisse).
-- • Retour fournisseur (avoir) : une partie des articles sort du stock (mouvements « supplier_return ») et le montant
--   est déduit du reste à payer de la facture.
-- • Chaque facture reçoit un numéro (n° 1, 2, 3…), les anciennes dans l'ordre de leur saisie.
-- • Nouvelle permission « purchase_cancel » (Annuler / corriger une facture fournisseur, retour fournisseur) :
--   Admin oui, Employé non.
-- • Tout se fait dans une seule transaction par opération (fonctions ci-dessous).
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- ───────────── Permission « purchase_cancel » ─────────────

alter table public.role_permissions drop constraint if exists role_permissions_permission_check;
alter table public.role_permissions add constraint role_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stock_state', 'inventory',
  'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount',
  'reset_numbers', 'cash_open', 'cash_in', 'cash_out', 'day_close', 'weekly_stats', 'expenses', 'profit',
  'cancelled_orders', 'cancelled_invoices', 'cancel_invoice', 'price_log', 'purchase_cancel'));
alter table public.user_permissions drop constraint if exists user_permissions_permission_check;
alter table public.user_permissions add constraint user_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stock_state', 'inventory',
  'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount',
  'reset_numbers', 'cash_open', 'cash_in', 'cash_out', 'day_close', 'weekly_stats', 'expenses', 'profit',
  'cancelled_orders', 'cancelled_invoices', 'cancel_invoice', 'price_log', 'purchase_cancel'));

insert into public.role_permissions (role, permission, allowed)
values ('admin', 'purchase_cancel', true), ('employe', 'purchase_cancel', false)
on conflict (role, permission) do nothing;

create or replace function public.my_permissions()
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p order by p), '{}')
  from unnest(array['staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges',
                    'stock_state', 'inventory', 'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations',
                    'delivery_zones', 'cancel_order', 'offer', 'discount',
                    'reset_numbers', 'cash_open', 'cash_in', 'cash_out', 'day_close', 'weekly_stats', 'expenses', 'profit',
                    'cancelled_orders', 'cancelled_invoices', 'cancel_invoice', 'price_log', 'purchase_cancel']) p
  where public.has_permission(p)
$$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- ───────────── Factures : numéro, statut, annulation, remplacement, avoirs ─────────────

create sequence if not exists public.supplier_invoice_number_seq;
alter table public.supplier_invoices add column if not exists number bigint;
-- Les factures déjà saisies sont numérotées dans l'ordre de leur saisie (seulement celles qui n'ont pas de numéro).
with n as (
  select id, (select coalesce(max(number), 0) from public.supplier_invoices) + row_number() over (order by created_at, id) as rn
    from public.supplier_invoices where number is null
)
update public.supplier_invoices s set number = n.rn from n where s.id = n.id;
select setval('public.supplier_invoice_number_seq', greatest((select coalesce(max(number), 0) from public.supplier_invoices), 1),
              (select max(number) is not null from public.supplier_invoices));
alter table public.supplier_invoices alter column number set default nextval('public.supplier_invoice_number_seq');
alter table public.supplier_invoices alter column number set not null;
alter sequence public.supplier_invoice_number_seq owned by public.supplier_invoices.number;
create unique index if not exists supplier_invoices_number_key on public.supplier_invoices (number);

alter table public.supplier_invoices add column if not exists status text not null default 'active';
alter table public.supplier_invoices drop constraint if exists supplier_invoices_status_check;
alter table public.supplier_invoices add constraint supplier_invoices_status_check check (status in ('active', 'cancelled'));
alter table public.supplier_invoices add column if not exists cancel_reason text;
alter table public.supplier_invoices add column if not exists cancelled_at timestamptz;
alter table public.supplier_invoices add column if not exists cancelled_by_name text;
-- Espèces rendues à la caisse par l'annulation (0 : réglée hors caisse ou non réglée).
alter table public.supplier_invoices add column if not exists cancel_cash_refund numeric(12,2) not null default 0;
alter table public.supplier_invoices add column if not exists replaces_invoice_id uuid references public.supplier_invoices (id) on delete set null;
alter table public.supplier_invoices add column if not exists replaced_by_invoice_id uuid references public.supplier_invoices (id) on delete set null;
-- Total des retours fournisseur (avoirs) : déduit du reste à payer.
alter table public.supplier_invoices add column if not exists returned_amount numeric(12,2) not null default 0;
alter table public.supplier_invoices drop constraint if exists supplier_invoices_returned_check;
alter table public.supplier_invoices add constraint supplier_invoices_returned_check check (returned_amount >= 0 and returned_amount <= total_amount);

create index if not exists supplier_invoices_status on public.supplier_invoices (status, date desc);

alter table public.supplier_invoice_items add column if not exists returned_quantity numeric(12,3) not null default 0;
alter table public.supplier_invoice_items drop constraint if exists supplier_invoice_items_returned_check;
alter table public.supplier_invoice_items add constraint supplier_invoice_items_returned_check
  check (returned_quantity >= 0 and returned_quantity <= quantity);

comment on column public.supplier_invoices.status is 'active, ou cancelled (Annulée : gardée, jamais supprimée).';
comment on column public.supplier_invoices.replaces_invoice_id is 'Facture corrigée : cette facture remplace la facture annulée.';

-- ───────────── Retours fournisseur (avoirs) ─────────────

create table if not exists public.supplier_returns (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references public.supplier_invoices (id) on delete cascade,
  date        date not null default current_date,
  reason      text not null default '',
  amount      numeric(12,2) not null check (amount >= 0),
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  user_name   text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists supplier_returns_invoice on public.supplier_returns (invoice_id, created_at);

create table if not exists public.supplier_return_items (
  id               uuid primary key default gen_random_uuid(),
  return_id        uuid not null references public.supplier_returns (id) on delete cascade,
  invoice_item_id  uuid references public.supplier_invoice_items (id) on delete set null,
  stock_item_id    uuid references public.stock_items (id) on delete set null,
  item_name        text not null default '',
  quantity         numeric(12,3) not null check (quantity > 0),    -- dans l'unité de la ligne de facture
  unit             text not null default '',
  unit_price       numeric(12,2) not null,
  factor           numeric(12,3) not null default 1
);
create index if not exists supplier_return_items_return on public.supplier_return_items (return_id);

comment on table public.supplier_returns is 'Retours fournisseur (avoirs) : articles rendus, montant déduit du reste à payer.';

alter table public.supplier_returns enable row level security;
alter table public.supplier_return_items enable row level security;
drop policy if exists "perm purchases read supplier_returns" on public.supplier_returns;
create policy "perm purchases read supplier_returns" on public.supplier_returns for select to authenticated
  using (public.has_permission('purchases'));
drop policy if exists "perm purchases read supplier_return_items" on public.supplier_return_items;
create policy "perm purchases read supplier_return_items" on public.supplier_return_items for select to authenticated
  using (public.has_permission('purchases'));
grant select on public.supplier_returns, public.supplier_return_items to authenticated;

-- ───────────── Mouvements « purchase_cancel » et « supplier_return » ─────────────

alter table public.stock_movements drop constraint if exists stock_movements_type_check;
alter table public.stock_movements add constraint stock_movements_type_check
  check (type in ('purchase', 'transfer', 'return', 'charge', 'adjustment', 'consumption', 'purchase_cancel', 'supplier_return'));
create index if not exists stock_movements_invoice on public.stock_movements (invoice_id) where invoice_id is not null;

-- ───────────── Sortie de stock d'une facture (annulation, retour) ─────────────
-- p_lines : [{"stock_item_id": "…", "quantity": 12 (unités de stock), "unit_cost": 116.6667}, …]
-- Sort d'abord du Dépôt. Si le Dépôt n'a pas assez pour un article : sans p_force, erreur
-- insufficient_depot [{"item","unit","needed","depot","kitchen"}, …] ; avec p_force, le reste sort de la Cuisine
-- (qui peut devenir négative). Rend la liste des manques (vide si le Dépôt suffisait).

create or replace function public.supplier_stock_out(p_type text, p_invoice_id uuid, p_lines jsonb, p_note text, p_force boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_line jsonb;
  v_item public.stock_items;
  v_need record;
  v_short jsonb := '[]'::jsonb;
  v_qty numeric;
  v_from_depot numeric;
  v_from_kitchen numeric;
  v_batch uuid := gen_random_uuid();
  v_user text := public.current_user_name();
begin
  perform public.stock_rpc_begin();
  -- Verrou des articles dans l'ordre des id (comme les autres fonctions du stock), puis contrôle du Dépôt.
  for v_need in
    select s.id, s.name, s.unit, s.quantity, s.kitchen_quantity, n.needed
      from (select (l ->> 'stock_item_id')::uuid as id, sum((l ->> 'quantity')::numeric) as needed
              from jsonb_array_elements(p_lines) l
             where l ->> 'stock_item_id' is not null
             group by 1) n
      join public.stock_items s on s.id = n.id
     order by s.id
       for update of s
  loop
    if v_need.needed > greatest(v_need.quantity, 0) then
      v_short := v_short || jsonb_build_object('item', v_need.name, 'unit', v_need.unit, 'needed', v_need.needed,
                                               'depot', v_need.quantity, 'kitchen', v_need.kitchen_quantity);
    end if;
  end loop;
  if jsonb_array_length(v_short) > 0 and not coalesce(p_force, false) then
    raise exception 'insufficient_depot %', v_short::text;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := round((v_line ->> 'quantity')::numeric, 3);
    if v_line ->> 'stock_item_id' is null or v_qty <= 0 then
      continue;
    end if;
    select * into v_item from public.stock_items where id = (v_line ->> 'stock_item_id')::uuid;
    if not found then
      continue;   -- article supprimé du stock : rien à retirer
    end if;
    v_from_depot := least(v_qty, greatest(v_item.quantity, 0));
    v_from_kitchen := v_qty - v_from_depot;
    update public.stock_items
       set quantity = quantity - v_from_depot, kitchen_quantity = kitchen_quantity - v_from_kitchen, updated_at = now()
     where id = v_item.id;
    if v_from_depot > 0 then
      insert into public.stock_movements (batch_id, type, stock_item_id, item_name, unit, quantity, from_location, note, unit_cost, invoice_id, user_name)
      values (v_batch, p_type, v_item.id, v_item.name, v_item.unit, v_from_depot, 'depot', left(coalesce(p_note, ''), 300),
              (v_line ->> 'unit_cost')::numeric, p_invoice_id, v_user);
    end if;
    if v_from_kitchen > 0 then
      insert into public.stock_movements (batch_id, type, stock_item_id, item_name, unit, quantity, from_location, note, unit_cost, invoice_id, user_name)
      values (v_batch, p_type, v_item.id, v_item.name, v_item.unit, v_from_kitchen, 'kitchen', left(coalesce(p_note, ''), 300),
              (v_line ->> 'unit_cost')::numeric, p_invoice_id, v_user);
    end if;
  end loop;
  return v_short;
end $$;
revoke all on function public.supplier_stock_out(text, uuid, jsonb, text, boolean) from public, anon, authenticated;

-- Espèces sorties de la caisse pour une facture (Fonds de sortie liés − ce qui est déjà revenu).
create or replace function public.supplier_cash_paid(p_invoice_id uuid)
returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case kind when 'out' then amount else -amount end), 0)
    from public.cash_movements where supplier_invoice_id = p_invoice_id
$$;
revoke all on function public.supplier_cash_paid(uuid) from public, anon, authenticated;

-- ───────────── Annuler une facture ─────────────
-- Partie commune à l'annulation et à la correction : sortie du stock restant (quantité − déjà retournée) et statut.
create or replace function public.supplier_invoice_void(p_invoice_id uuid, p_reason text, p_force boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_invoice public.supplier_invoices;
  v_lines jsonb;
  v_short jsonb;
begin
  select * into v_invoice from public.supplier_invoices where id = p_invoice_id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'stock_item_id', ii.stock_item_id,
           'quantity', round((ii.quantity - ii.returned_quantity) * ii.factor, 3),
           'unit_cost', round(ii.unit_price / ii.factor, 4)) order by ii.position), '[]'::jsonb)
    into v_lines
    from public.supplier_invoice_items ii
   where ii.invoice_id = p_invoice_id and ii.stock_item_id is not null and ii.quantity > ii.returned_quantity;
  v_short := public.supplier_stock_out('purchase_cancel', p_invoice_id, v_lines,
                                       format('Annulation facture n° %s : %s', v_invoice.number, p_reason), p_force);
  update public.supplier_invoices
     set status = 'cancelled', cancel_reason = p_reason, cancelled_at = now(), cancelled_by_name = public.current_user_name()
   where id = p_invoice_id;
  return v_short;
end $$;
revoke all on function public.supplier_invoice_void(uuid, text, boolean) from public, anon, authenticated;

-- p_force : confirmer quand le Dépôt n'a plus toutes les quantités (après l'erreur insufficient_depot).
create or replace function public.cancel_supplier_invoice(p_invoice_id uuid, p_reason text, p_force boolean default false)
returns public.supplier_invoices
language plpgsql security definer set search_path = public as $$
declare
  v_invoice public.supplier_invoices;
  v_reason text := left(trim(coalesce(p_reason, '')), 300);
  v_day public.cash_days;
  v_refund numeric;
begin
  if not public.has_permission('purchase_cancel') then
    raise exception 'no_permission';
  end if;
  if v_reason = '' then
    raise exception 'reason_required';
  end if;
  -- La journée est verrouillée avant la facture, dans le même ordre qu'un règlement depuis la caisse.
  if exists (select 1 from public.cash_movements where supplier_invoice_id = p_invoice_id) then
    select * into v_day from public.cash_days where closed_at is null for update;
  end if;
  select * into v_invoice from public.supplier_invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice_not_found';
  end if;
  if v_invoice.status = 'cancelled' then
    raise exception 'invoice_cancelled';
  end if;

  -- Réglée depuis la caisse : le montant revient dans les espèces attendues de la journée ouverte.
  v_refund := public.supplier_cash_paid(v_invoice.id);
  if v_refund > 0 then
    if v_day.id is null then
      raise exception 'no_open_day';
    end if;
    insert into public.cash_movements (day_id, kind, amount, reason, supplier_invoice_id, supplier_name, user_name)
    values (v_day.id, 'in', v_refund, format('Annulation facture fournisseur n° %s', v_invoice.number), v_invoice.id,
            v_invoice.supplier_name, public.current_user_name());
  end if;

  perform public.supplier_invoice_void(v_invoice.id, v_reason, p_force);
  update public.supplier_invoices set cancel_cash_refund = greatest(v_refund, 0) where id = v_invoice.id
  returning * into v_invoice;
  return v_invoice;
end $$;
revoke all on function public.cancel_supplier_invoice(uuid, text, boolean) from public, anon;
grant execute on function public.cancel_supplier_invoice(uuid, text, boolean) to authenticated;

-- ───────────── Corriger une facture (Modifier) ─────────────
-- Crée la nouvelle facture (mêmes règles qu'Effectuer un achat), annule l'ancienne et les lie. Les règlements déjà
-- faits (et leurs Fonds de sortie) passent sur la nouvelle facture : pas de mouvement de caisse. Refusé si le nouveau
-- total est inférieur à ce qui est déjà réglé (paid_exceeds_total:<réglé>) ou si la facture a des retours.
create or replace function public.replace_supplier_invoice(p_invoice_id uuid, p_reason text, p_supplier_id uuid, p_date date,
  p_lines jsonb, p_force boolean default false)
returns public.supplier_invoices
language plpgsql security definer set search_path = public as $$
declare
  v_old public.supplier_invoices;
  v_new public.supplier_invoices;
  v_reason text := left(trim(coalesce(p_reason, '')), 300);
begin
  if not (public.has_permission('purchase_cancel') and public.has_permission('purchases')) then
    raise exception 'no_permission';
  end if;
  if v_reason = '' then
    raise exception 'reason_required';
  end if;
  if exists (select 1 from public.cash_movements where supplier_invoice_id = p_invoice_id) then
    perform 1 from public.cash_days where closed_at is null for update;
  end if;
  select * into v_old from public.supplier_invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice_not_found';
  end if;
  if v_old.status = 'cancelled' then
    raise exception 'invoice_cancelled';
  end if;
  if v_old.returned_amount > 0 or exists (select 1 from public.supplier_returns where invoice_id = v_old.id) then
    raise exception 'invoice_has_returns';
  end if;

  -- La nouvelle facture entre d'abord en stock : une correction de quantité ne demande pas de confirmation inutile.
  v_new := public.create_supplier_purchase(p_supplier_id, p_date, p_lines, 0);
  if v_old.paid_amount > v_new.total_amount then
    raise exception 'paid_exceeds_total:%', v_old.paid_amount;
  end if;

  perform public.supplier_invoice_void(v_old.id, format('%s (remplacée par la facture n° %s)', v_reason, v_new.number), p_force);
  update public.supplier_invoice_payments set invoice_id = v_new.id where invoice_id = v_old.id;
  update public.cash_movements set supplier_invoice_id = v_new.id where supplier_invoice_id = v_old.id;
  update public.supplier_invoices
     set replaced_by_invoice_id = v_new.id, cancel_reason = v_reason, paid_amount = 0, payment_status = 'unpaid'
   where id = v_old.id;
  update public.supplier_invoices
     set replaces_invoice_id = v_old.id, paid_amount = v_old.paid_amount,
         payment_status = public.supplier_payment_status(total_amount, v_old.paid_amount)
   where id = v_new.id
  returning * into v_new;
  return v_new;
end $$;
revoke all on function public.replace_supplier_invoice(uuid, text, uuid, date, jsonb, boolean) from public, anon;
grant execute on function public.replace_supplier_invoice(uuid, text, uuid, date, jsonb, boolean) to authenticated;

-- ───────────── Retour fournisseur partiel (avoir) ─────────────
-- p_lines : [{"invoice_item_id": "…", "quantity": 2}, …] dans l'unité de la ligne de facture (au plus ce qui reste).
create or replace function public.create_supplier_return(p_invoice_id uuid, p_lines jsonb, p_reason text, p_force boolean default false)
returns public.supplier_returns
language plpgsql security definer set search_path = public as $$
declare
  v_invoice public.supplier_invoices;
  v_return public.supplier_returns;
  v_line jsonb;
  v_ii public.supplier_invoice_items;
  v_qty numeric;
  v_amount numeric := 0;
  v_stock jsonb := '[]'::jsonb;
  v_reason text := left(trim(coalesce(p_reason, '')), 300);
begin
  if not public.has_permission('purchase_cancel') then
    raise exception 'no_permission';
  end if;
  if v_reason = '' then
    raise exception 'reason_required';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'no_lines';
  end if;
  select * into v_invoice from public.supplier_invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice_not_found';
  end if;
  if v_invoice.status = 'cancelled' then
    raise exception 'invoice_cancelled';
  end if;

  insert into public.supplier_returns (invoice_id, date, reason, amount, user_name)
  values (v_invoice.id, public.local_today(), v_reason, 0, public.current_user_name())
  returning * into v_return;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := round((v_line ->> 'quantity')::numeric, 3);
    if v_qty is null or v_qty <= 0 then
      raise exception 'bad_quantity';
    end if;
    select * into v_ii from public.supplier_invoice_items
     where id = (v_line ->> 'invoice_item_id')::uuid and invoice_id = v_invoice.id for update;
    if not found then
      raise exception 'invoice_item_not_found';
    end if;
    if v_qty > v_ii.quantity - v_ii.returned_quantity then
      raise exception 'return_too_much';
    end if;
    update public.supplier_invoice_items set returned_quantity = returned_quantity + v_qty where id = v_ii.id;
    insert into public.supplier_return_items (return_id, invoice_item_id, stock_item_id, item_name, quantity, unit, unit_price, factor)
    values (v_return.id, v_ii.id, v_ii.stock_item_id, v_ii.item_name, v_qty, v_ii.unit, v_ii.unit_price, v_ii.factor);
    v_amount := v_amount + round(v_qty * v_ii.unit_price, 2);
    if v_ii.stock_item_id is not null then
      v_stock := v_stock || jsonb_build_object('stock_item_id', v_ii.stock_item_id, 'quantity', round(v_qty * v_ii.factor, 3),
                                               'unit_cost', round(v_ii.unit_price / v_ii.factor, 4));
    end if;
  end loop;

  perform public.supplier_stock_out('supplier_return', v_invoice.id, v_stock,
                                    format('Retour fournisseur, facture n° %s : %s', v_invoice.number, v_reason), p_force);
  update public.supplier_returns set amount = v_amount where id = v_return.id returning * into v_return;
  update public.supplier_invoices
     set returned_amount = returned_amount + v_amount,
         payment_status = public.supplier_payment_status(total_amount - (returned_amount + v_amount), paid_amount)
   where id = v_invoice.id;
  return v_return;
end $$;
revoke all on function public.create_supplier_return(uuid, jsonb, text, boolean) from public, anon;
grant execute on function public.create_supplier_return(uuid, jsonb, text, boolean) to authenticated;

-- ───────────── Régler : pas une facture annulée, au plus le reste à payer après avoirs ─────────────

create or replace function public.pay_supplier_invoice(p_invoice_id uuid, p_amount numeric, p_date date)
returns public.supplier_invoices
language plpgsql security definer set search_path = public as $$
declare
  v_invoice public.supplier_invoices;
  v_amount numeric := round(coalesce(p_amount, 0), 2);
begin
  if not public.has_permission('purchases') then
    raise exception 'no_permission';
  end if;
  -- Verrou : deux appareils qui règlent en même temps ne dépassent pas le total.
  select * into v_invoice from public.supplier_invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice_not_found';
  end if;
  if v_invoice.status = 'cancelled' then
    raise exception 'invoice_cancelled';
  end if;
  if v_amount <= 0 or v_amount > v_invoice.total_amount - v_invoice.returned_amount - v_invoice.paid_amount then
    raise exception 'bad_paid_amount';
  end if;
  insert into public.supplier_invoice_payments (invoice_id, amount, date) values (v_invoice.id, v_amount, coalesce(p_date, current_date));
  update public.supplier_invoices
     set paid_amount = paid_amount + v_amount,
         payment_status = public.supplier_payment_status(total_amount - returned_amount, paid_amount + v_amount)
   where id = v_invoice.id
  returning * into v_invoice;
  return v_invoice;
end $$;
revoke all on function public.pay_supplier_invoice(uuid, numeric, date) from public, anon;
grant execute on function public.pay_supplier_invoice(uuid, numeric, date) to authenticated;

-- ───────────── Dernier prix d'achat : sans les factures annulées ─────────────

create or replace function public.last_purchase_price(p_item_id uuid)
returns numeric
language sql stable security definer set search_path = public as $$
  select round(ii.unit_price / ii.factor, 4)
  from public.supplier_invoice_items ii
  join public.supplier_invoices i on i.id = ii.invoice_id
  where ii.stock_item_id = p_item_id and i.status = 'active'
  order by i.date desc, i.created_at desc, ii.position desc
  limit 1
$$;
revoke all on function public.last_purchase_price(uuid) from public, anon;
grant execute on function public.last_purchase_price(uuid) to authenticated;

-- État du stock : même fonction que 20260930100000_recipes.sql, sans les factures annulées.
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
                      where ii.stock_item_id = s.id and i.supplier_id is not null and i.status = 'active'), '[]'::jsonb),
           s.purchase_unit, s.purchase_factor
      from public.stock_items s
      left join lateral (
        select ii.unit_price, ii.factor, i.supplier_id, i.supplier_name
          from public.supplier_invoice_items ii
          join public.supplier_invoices i on i.id = ii.invoice_id
         where ii.stock_item_id = s.id and i.status = 'active'
         order by i.date desc, i.created_at desc, ii.position desc
         limit 1
      ) lp on true
     order by s.name;
end $$;
revoke all on function public.stock_state() from public, anon;
grant execute on function public.stock_state() to authenticated;

-- ───────────── Mouvements par période : colonne « Annulations / retours fournisseur » ─────────────

drop function if exists public.stock_report(timestamptz, timestamptz);
create or replace function public.stock_report(p_from timestamptz, p_to timestamptz)
returns table (
  id uuid, name text, unit text,
  initial_depot numeric, initial_kitchen numeric,
  purchases numeric, transfers numeric, returns numeric, charges numeric, consumption numeric, adjustments numeric,
  final_depot numeric, final_kitchen numeric, supplier_out numeric
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
             sum(case when m.created_at < p_to and m.type = 'adjustment' then m.d_depot + m.d_kitchen else 0 end) as adjustments,
             sum(case when m.created_at < p_to and m.type in ('purchase_cancel', 'supplier_return') then m.quantity else 0 end) as supplier_out
        from m
       group by m.stock_item_id
    )
    select s.id, s.name, s.unit,
           s.quantity - coalesce(a.since_from_depot, 0), s.kitchen_quantity - coalesce(a.since_from_kitchen, 0),
           coalesce(a.purchases, 0), coalesce(a.transfers, 0), coalesce(a.returns, 0), coalesce(a.charges, 0),
           coalesce(a.consumption, 0), coalesce(a.adjustments, 0),
           s.quantity - coalesce(a.since_to_depot, 0), s.kitchen_quantity - coalesce(a.since_to_kitchen, 0),
           coalesce(a.supplier_out, 0)
      from public.stock_items s
      left join agg a on a.stock_item_id = s.id
     order by s.name;
end $$;
revoke all on function public.stock_report(timestamptz, timestamptz) from public, anon;
grant execute on function public.stock_report(timestamptz, timestamptz) to authenticated;

notify pgrst, 'reload schema';

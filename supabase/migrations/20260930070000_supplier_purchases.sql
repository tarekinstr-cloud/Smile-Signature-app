-- Smile Signature: achats fournisseurs (menu Gestion du Stock > Effectuer un achat, Factures fournisseurs)
-- Idempotent: peut être exécuté plusieurs fois sans problème.
-- À exécuter après 20260930060000_devices.sql (nécessite 20260928060000_back_office.sql et 20260930000000_permissions.sql).
--
-- Un achat = une facture fournisseur (supplier_invoices) et ses lignes (supplier_invoice_items : article du stock,
-- quantité, unité, prix unitaire). À la validation, la quantité de chaque article du stock augmente de la quantité achetée.
-- Chaque règlement (total ou partiel) est gardé dans supplier_invoice_payments ; la facture tient le montant réglé
-- (paid_amount) et le statut : unpaid (Non payé), partial (Partiellement payé), paid (Payé).
-- Nouvelle permission « purchases » : effectuer un achat, voir et régler les factures fournisseurs.
-- Par défaut : Admin oui, Employé non (réglable dans Fichier > Permissions).

-- ───────────── Factures fournisseurs ─────────────

create table if not exists public.supplier_invoices (
  id              uuid primary key default gen_random_uuid(),
  supplier_id     uuid references public.suppliers (id) on delete set null,
  supplier_name   text not null default '',                  -- gardé si le fournisseur est supprimé
  date            date not null default current_date,
  total_amount    numeric(12,2) not null check (total_amount >= 0),
  payment_status  text not null default 'unpaid' check (payment_status in ('unpaid', 'partial', 'paid')),
  paid_amount     numeric(12,2) not null default 0,
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint supplier_invoices_paid_check check (paid_amount >= 0 and paid_amount <= total_amount)
);

create index if not exists supplier_invoices_supplier_date on public.supplier_invoices (supplier_id, date desc);
create index if not exists supplier_invoices_status_date on public.supplier_invoices (payment_status, date desc);

create table if not exists public.supplier_invoice_items (
  id             uuid primary key default gen_random_uuid(),
  invoice_id     uuid not null references public.supplier_invoices (id) on delete cascade,
  stock_item_id  uuid references public.stock_items (id) on delete set null,
  item_name      text not null default '',                   -- gardé si l'article est supprimé du stock
  quantity       numeric(12,3) not null check (quantity > 0),
  unit           text not null default '',
  unit_price     numeric(12,2) not null check (unit_price >= 0),
  position       integer not null default 0
);

create index if not exists supplier_invoice_items_invoice on public.supplier_invoice_items (invoice_id, position);

create table if not exists public.supplier_invoice_payments (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references public.supplier_invoices (id) on delete cascade,
  amount      numeric(12,2) not null check (amount > 0),
  date        date not null default current_date,
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists supplier_invoice_payments_invoice on public.supplier_invoice_payments (invoice_id, date);

comment on table public.supplier_invoices is 'Factures fournisseurs (achats) : total, montant réglé, statut de paiement.';
comment on table public.supplier_invoice_items is 'Lignes d''une facture fournisseur ; chaque ligne a ajouté sa quantité au stock.';
comment on table public.supplier_invoice_payments is 'Règlements (totaux ou partiels) des factures fournisseurs.';

-- ───────────── Permission « purchases » ─────────────

alter table public.role_permissions drop constraint if exists role_permissions_permission_check;
alter table public.role_permissions add constraint role_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations',
  'delivery_zones', 'cancel_order', 'offer', 'discount'));
alter table public.user_permissions drop constraint if exists user_permissions_permission_check;
alter table public.user_permissions add constraint user_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations',
  'delivery_zones', 'cancel_order', 'offer', 'discount'));

insert into public.role_permissions (role, permission, allowed)
values ('admin', 'purchases', true), ('employe', 'purchases', false)
on conflict (role, permission) do nothing;

create or replace function public.my_permissions()
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p order by p), '{}')
  from unnest(array['staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stats', 'settings', 'edit', 'backup', 'ticket',
                    'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount']) p
  where public.has_permission(p)
$$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- Statut d'après le montant réglé.
create or replace function public.supplier_payment_status(p_total numeric, p_paid numeric)
returns text
language sql immutable set search_path = public as $$
  select case when p_paid >= p_total then 'paid' when p_paid > 0 then 'partial' else 'unpaid' end
$$;

-- ───────────── Effectuer un achat ─────────────
-- p_lines : [{"stock_item_id": "…", "quantity": 5, "unit": "kg", "unit_price": 120}, …]
-- p_paid : montant déjà réglé à l'achat (0 = Non payé, le total = Payé, entre les deux = Partiellement payé).
-- En une seule transaction : facture, lignes, règlement éventuel, et + quantité achetée sur chaque article du stock.

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
    -- + quantité achetée ; l'unité de l'article est remplie s'il n'en avait pas.
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

-- ───────────── Régler une facture (total ou partiel) ─────────────

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
  if v_amount <= 0 or v_amount > v_invoice.total_amount - v_invoice.paid_amount then
    raise exception 'bad_paid_amount';
  end if;
  insert into public.supplier_invoice_payments (invoice_id, amount, date) values (v_invoice.id, v_amount, coalesce(p_date, current_date));
  update public.supplier_invoices
     set paid_amount = paid_amount + v_amount,
         payment_status = public.supplier_payment_status(total_amount, paid_amount + v_amount)
   where id = v_invoice.id
  returning * into v_invoice;
  return v_invoice;
end $$;
revoke all on function public.pay_supplier_invoice(uuid, numeric, date) from public, anon;
grant execute on function public.pay_supplier_invoice(uuid, numeric, date) to authenticated;

-- ───────────── RLS : lecture avec « purchases », écriture seulement par les deux fonctions ci-dessus ─────────────

alter table public.supplier_invoices enable row level security;
alter table public.supplier_invoice_items enable row level security;
alter table public.supplier_invoice_payments enable row level security;

drop policy if exists "perm purchases read supplier_invoices" on public.supplier_invoices;
create policy "perm purchases read supplier_invoices" on public.supplier_invoices for select to authenticated
  using (public.has_permission('purchases'));
drop policy if exists "perm purchases read supplier_invoice_items" on public.supplier_invoice_items;
create policy "perm purchases read supplier_invoice_items" on public.supplier_invoice_items for select to authenticated
  using (public.has_permission('purchases'));
drop policy if exists "perm purchases read supplier_invoice_payments" on public.supplier_invoice_payments;
create policy "perm purchases read supplier_invoice_payments" on public.supplier_invoice_payments for select to authenticated
  using (public.has_permission('purchases'));

grant select on public.supplier_invoices, public.supplier_invoice_items, public.supplier_invoice_payments to authenticated;

-- Pour choisir le fournisseur et les articles d'un achat sans avoir « stock » ni « suppliers ».
drop policy if exists "perm purchases read stock_items" on public.stock_items;
create policy "perm purchases read stock_items" on public.stock_items for select to authenticated
  using (public.has_permission('purchases'));
drop policy if exists "perm purchases read suppliers" on public.suppliers;
create policy "perm purchases read suppliers" on public.suppliers for select to authenticated
  using (public.has_permission('purchases'));

-- ───────────── Realtime : la liste des factures se met à jour sur tous les appareils ─────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'supplier_invoices') then
    alter publication supabase_realtime add table public.supplier_invoices;
  end if;
end $$;

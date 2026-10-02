-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Menu Clients : fiches clients, vente à crédit (compte client), règlements, toutes les factures
-- (à exécuter après 20261008000000_settings_printers_halls_payments.sql).
-- À exécuter à la main dans Supabase > SQL Editor.
--
-- • customers : nom, téléphone (unique, comparé sur ses chiffres), adresse, zone de livraison, note, plafond de
--   crédit (null : sans plafond), actif. orders.customer_id relie une commande à son client.
-- • Livraison : quand une livraison a un téléphone, le client est retrouvé par ce téléphone, ou créé (trigger).
-- • Vente à crédit : mode de paiement « credit » (Compte client). pay_on_credit() enregistre un paiement « credit »
--   (la commande est clôturée : stock, statistiques, CA compté à la vente) et la relie au client ; refusé au-delà du
--   plafond, sauf pour l'Admin. Le crédit ne passe pas par la caisse.
-- • Règlement : settle_customer() répartit un montant sur les factures dues, de la plus ancienne à la plus récente
--   (ou sur celles choisies). En espèces : journée ouverte obligatoire, fond d'entrée automatique « Règlement crédit
--   client » (dans les espèces attendues) ; ce fond d'entrée ne peut pas être supprimé à la main.
-- • customer_invoices (vue) : factures à crédit avec leur montant réglé et leur reste dû.
-- • Permissions : « customers » (menu Clients : fiches, factures), « credit_sale » (vendre sur le compte d'un
--   client), « credit_settle » (régler une facture client). Admin oui, Employé non.
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- ───────────── Permissions ─────────────

alter table public.role_permissions drop constraint if exists role_permissions_permission_check;
alter table public.role_permissions add constraint role_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stock_state', 'inventory',
  'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount',
  'reset_numbers', 'cash_open', 'cash_in', 'cash_out', 'day_close', 'weekly_stats', 'expenses', 'profit',
  'cancelled_orders', 'cancelled_invoices', 'cancel_invoice', 'price_log', 'purchase_cancel',
  'customers', 'credit_sale', 'credit_settle'));
alter table public.user_permissions drop constraint if exists user_permissions_permission_check;
alter table public.user_permissions add constraint user_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stock_state', 'inventory',
  'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount',
  'reset_numbers', 'cash_open', 'cash_in', 'cash_out', 'day_close', 'weekly_stats', 'expenses', 'profit',
  'cancelled_orders', 'cancelled_invoices', 'cancel_invoice', 'price_log', 'purchase_cancel',
  'customers', 'credit_sale', 'credit_settle'));

insert into public.role_permissions (role, permission, allowed) values
  ('admin', 'customers', true), ('employe', 'customers', false),
  ('admin', 'credit_sale', true), ('employe', 'credit_sale', false),
  ('admin', 'credit_settle', true), ('employe', 'credit_settle', false)
on conflict (role, permission) do nothing;

create or replace function public.my_permissions()
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p order by p), '{}')
  from unnest(array['staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges',
                    'stock_state', 'inventory', 'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations',
                    'delivery_zones', 'cancel_order', 'offer', 'discount',
                    'reset_numbers', 'cash_open', 'cash_in', 'cash_out', 'day_close', 'weekly_stats', 'expenses', 'profit',
                    'cancelled_orders', 'cancelled_invoices', 'cancel_invoice', 'price_log', 'purchase_cancel',
                    'customers', 'credit_sale', 'credit_settle']) p
  where public.has_permission(p)
$$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- ───────────── Clients ─────────────

create table if not exists public.customers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(trim(name)) between 1 and 80),
  phone         text not null default '' check (length(phone) <= 30),
  -- Chiffres du téléphone : « 0550 12 34 56 » et « 0550123456 » sont le même client.
  phone_key     text generated always as (regexp_replace(phone, '\D', '', 'g')) stored,
  address       text not null default '' check (length(address) <= 300),
  zone_id       uuid references public.delivery_zones (id) on delete set null,
  note          text not null default '' check (length(note) <= 300),
  credit_limit  numeric(12,2) check (credit_limit is null or credit_limit >= 0),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists customers_phone_key on public.customers (phone_key) where phone_key <> '';
create index if not exists customers_name on public.customers (lower(name));

alter table public.customers enable row level security;
drop policy if exists "read customers" on public.customers;
create policy "read customers" on public.customers for select to authenticated using (true);
-- Créer : menu Clients, ou la caisse au moment d'une vente à crédit.
drop policy if exists "write customers" on public.customers;
create policy "write customers" on public.customers for insert to authenticated
  with check (public.has_permission('customers') or public.has_permission('credit_sale'));
drop policy if exists "update customers" on public.customers;
create policy "update customers" on public.customers for update to authenticated
  using (public.has_permission('customers')) with check (public.has_permission('customers'));
grant select, insert, update on public.customers to authenticated;

alter table public.orders add column if not exists customer_id uuid references public.customers (id) on delete set null;
create index if not exists orders_customer on public.orders (customer_id) where customer_id is not null;

-- Livraison : le client est retrouvé par son téléphone, ou créé, et relié à la commande. Ses champs vides sont
-- complétés (adresse, zone) ; ce qui est déjà sur la fiche n'est pas écrasé.
create or replace function public.orders_link_customer() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_key text := regexp_replace(coalesce(new.customer_phone, ''), '\D', '', 'g');
  v_id uuid;
begin
  if new.order_type <> 'delivery' or v_key = '' then
    return new;
  end if;
  -- « update of customer_phone » se déclenche même si la valeur ne change pas (vente à crédit) : rien à refaire.
  if tg_op = 'UPDATE' and new.customer_phone is not distinct from old.customer_phone and new.customer_id is not null then
    return new;
  end if;
  select id into v_id from public.customers where phone_key = v_key;
  if v_id is null then
    insert into public.customers (name, phone, address, zone_id)
    values (left(coalesce(nullif(trim(new.customer_name), ''), trim(new.customer_phone)), 80), left(trim(new.customer_phone), 30),
            left(coalesce(trim(new.customer_address), ''), 300), new.delivery_zone_id)
    on conflict (phone_key) where phone_key <> '' do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.customers where phone_key = v_key;
    end if;
  else
    update public.customers
       set address = case when address = '' then left(coalesce(trim(new.customer_address), ''), 300) else address end,
           zone_id = coalesce(zone_id, new.delivery_zone_id),
           updated_at = now()
     where id = v_id and (address = '' or zone_id is null);
  end if;
  new.customer_id := v_id;
  return new;
end $$;
revoke all on function public.orders_link_customer() from public, anon, authenticated;
drop trigger if exists orders_link_customer on public.orders;
create trigger orders_link_customer
  before insert or update of customer_phone on public.orders
  for each row execute function public.orders_link_customer();

-- ───────────── Vente à crédit ─────────────

insert into public.payment_modes (code, label, active, sort_order) values ('credit', null, true, 90)
on conflict (code) do nothing;

create or replace function public.payment_modes_guard_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.code in ('cash', 'card', 'credit') then
    raise exception 'payment_mode_builtin';
  end if;
  if exists (select 1 from public.payments where method = old.code) then
    raise exception 'payment_mode_used';
  end if;
  return old;
end $$;

create table if not exists public.customer_settlements (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references public.customers (id) on delete restrict,
  customer_name     text not null default '',
  amount            numeric(12,2) not null check (amount > 0),
  method            text not null,
  -- Règlement en espèces : son fond d'entrée (ne peut pas être supprimé tant que le règlement existe).
  cash_movement_id  uuid references public.cash_movements (id) on delete restrict,
  note              text not null default '' check (length(note) <= 300),
  user_name         text not null default '',
  created_at        timestamptz not null default now()
);
create index if not exists customer_settlements_customer on public.customer_settlements (customer_id, created_at);
create index if not exists customer_settlements_date on public.customer_settlements (created_at);

create table if not exists public.customer_settlement_items (
  settlement_id  uuid not null references public.customer_settlements (id) on delete cascade,
  order_id       uuid not null references public.orders (id) on delete restrict,
  amount         numeric(12,2) not null check (amount > 0),
  primary key (settlement_id, order_id)
);
create index if not exists customer_settlement_items_order on public.customer_settlement_items (order_id);

alter table public.customer_settlements enable row level security;
alter table public.customer_settlement_items enable row level security;
drop policy if exists "read customer_settlements" on public.customer_settlements;
create policy "read customer_settlements" on public.customer_settlements for select to authenticated
  using (public.has_permission('customers') or public.has_permission('credit_settle') or public.has_permission('stats'));
drop policy if exists "read customer_settlement_items" on public.customer_settlement_items;
create policy "read customer_settlement_items" on public.customer_settlement_items for select to authenticated
  using (public.has_permission('customers') or public.has_permission('credit_settle') or public.has_permission('stats'));
-- Écriture seulement par settle_customer().
revoke insert, update, delete on public.customer_settlements, public.customer_settlement_items from anon, authenticated;
grant select on public.customer_settlements, public.customer_settlement_items to authenticated;

-- Factures à crédit : ce qui a été mis sur le compte du client, ce qui est réglé, ce qui reste dû.
create or replace view public.customer_invoices with (security_invoker = true) as
  select o.id as order_id, o.customer_id, o.ticket_no, o.order_type, o.table_id, o.takeaway_no, o.delivery_no,
         o.closed_at, o.total,
         p.credit, coalesce(s.settled, 0)::numeric(12,2) as settled,
         (p.credit - coalesce(s.settled, 0))::numeric(12,2) as due
    from public.orders o
    join (select order_id, sum(amount)::numeric(12,2) as credit from public.payments where method = 'credit' group by order_id) p
      on p.order_id = o.id
    left join (select order_id, sum(amount) as settled from public.customer_settlement_items group by order_id) s
      on s.order_id = o.id
   where o.status = 'paid';
grant select on public.customer_invoices to authenticated;

-- Reste dû d'un client.
create or replace function public.customer_due(p_customer_id uuid)
returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(due), 0)::numeric(12,2) from public.customer_invoices where customer_id = p_customer_id and due > 0
$$;
revoke all on function public.customer_due(uuid) from public, anon;
grant execute on function public.customer_due(uuid) to authenticated;

-- Encaisse tout ou partie d'une commande sur le compte d'un client. Renvoie la commande (payée si plus rien n'est dû).
create or replace function public.pay_on_credit(p_order_id uuid, p_customer_id uuid, p_amount numeric)
returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  c public.customers;
  v_amount numeric(12,2) := round(coalesce(p_amount, 0), 0);
  v_due numeric(12,2);
begin
  if not public.has_permission('credit_sale') then
    raise exception 'permission_denied:credit_sale';
  end if;
  select * into c from public.customers where id = p_customer_id for update;
  if not found or not c.active then
    raise exception 'customer_not_found';
  end if;
  if v_amount <= 0 then
    raise exception 'amount_invalid';
  end if;
  if c.credit_limit is not null and not public.is_app_admin() then
    v_due := public.customer_due(c.id);
    if v_due + v_amount > c.credit_limit then
      raise exception 'credit_limit:%', greatest(c.credit_limit - v_due, 0);
    end if;
  end if;
  update public.orders
     set customer_id = c.id,
         customer_name = coalesce(nullif(trim(customer_name), ''), c.name),
         customer_phone = coalesce(nullif(trim(customer_phone), ''), nullif(c.phone, ''))
   where id = p_order_id and status = 'open';
  if not found then
    raise exception 'order_not_open';
  end if;
  return public.add_payment(p_order_id, 'credit', v_amount, null);
end $$;
revoke all on function public.pay_on_credit(uuid, uuid, numeric) from public, anon;
grant execute on function public.pay_on_credit(uuid, uuid, numeric) to authenticated;

-- Règle des factures d'un client : p_order_ids null = toutes, de la plus ancienne à la plus récente.
create or replace function public.settle_customer(p_customer_id uuid, p_amount numeric, p_method text,
  p_order_ids uuid[] default null, p_note text default '')
returns public.customer_settlements
language plpgsql security definer set search_path = public as $$
declare
  c public.customers;
  v_amount numeric(12,2) := round(coalesce(p_amount, 0), 0);
  v_left numeric(12,2);
  v_total numeric(12,2);
  v_day public.cash_days;
  v_movement uuid;
  v_row public.customer_settlements;
  v_part numeric(12,2);
  inv record;
begin
  if not public.has_permission('credit_settle') then
    raise exception 'permission_denied:credit_settle';
  end if;
  if p_method = 'credit' or not exists (select 1 from public.payment_modes where code = p_method and active) then
    raise exception 'payment_mode_inactive';
  end if;
  select * into c from public.customers where id = p_customer_id for update;
  if not found then
    raise exception 'customer_not_found';
  end if;
  if v_amount <= 0 then
    raise exception 'amount_invalid';
  end if;
  select coalesce(sum(due), 0) into v_total from public.customer_invoices
   where customer_id = c.id and due > 0 and (p_order_ids is null or order_id = any (p_order_ids));
  if v_total <= 0 then
    raise exception 'nothing_due';
  end if;
  if v_amount > v_total then
    raise exception 'settle_too_much:%', v_total;
  end if;
  if p_method = 'cash' then
    -- Même verrou que les fonds d'entrée : une clôture en cours attend.
    select * into v_day from public.cash_days where closed_at is null for update;
    if not found then
      raise exception 'no_open_day';
    end if;
    insert into public.cash_movements (day_id, kind, amount, reason, user_name)
    values (v_day.id, 'in', v_amount, left('Règlement crédit client — ' || c.name, 300), public.current_user_name())
    returning id into v_movement;
  end if;
  insert into public.customer_settlements (customer_id, customer_name, amount, method, cash_movement_id, note, user_name)
  values (c.id, c.name, v_amount, p_method, v_movement, left(trim(coalesce(p_note, '')), 300), public.current_user_name())
  returning * into v_row;
  v_left := v_amount;
  for inv in
    select order_id, due from public.customer_invoices
     where customer_id = c.id and due > 0 and (p_order_ids is null or order_id = any (p_order_ids))
     order by closed_at, ticket_no nulls last, order_id
  loop
    exit when v_left <= 0;
    v_part := least(inv.due, v_left);
    insert into public.customer_settlement_items (settlement_id, order_id, amount) values (v_row.id, inv.order_id, v_part);
    v_left := v_left - v_part;
  end loop;
  return v_row;
end $$;
revoke all on function public.settle_customer(uuid, numeric, text, uuid[], text) from public, anon;
grant execute on function public.settle_customer(uuid, numeric, text, uuid[], text) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'customers') then
      alter publication supabase_realtime add table public.customers;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'customer_settlements') then
      alter publication supabase_realtime add table public.customer_settlements;
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';

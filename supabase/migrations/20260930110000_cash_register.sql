-- Smile Signature: menu Statistiques / bénéfice, partie 1 :
--   Re-Initialiser le N° des Commandes, Caisse (Fond de caisse, Fond d'entrée, Fond de sortie),
--   Statistique Journalier avec clôture de la journée (rapport Z).
-- Idempotent: peut être exécuté plusieurs fois sans problème.
-- À exécuter après 20260930100000_recipes.sql.
--
--   cash_days                Journées de travail : de l'ouverture (fond de caisse) à la clôture (espèces comptées).
--                            Une seule journée ouverte à la fois ; une journée clôturée ne se rouvre pas.
--                            Les ventes d'une journée : tout ce qui est payé depuis la clôture précédente
--                            (period_start) jusqu'à sa clôture, pour qu'aucune vente ne soit oubliée.
--   cash_movements           Fonds d'entrée et de sortie de la journée ouverte (montant, motif, employé, heure).
--                            Une sortie peut régler une facture fournisseur (pay_supplier_invoice).
--   order_number_resets      Historique des remises à 1 de la numérotation (tickets, à emporter, livraisons).
--                            Les commandes gardent leur identifiant unique interne (orders.id) ; les factures gardent
--                            leur numérotation continue.
--   orders.created_by(_name) Employé qui a ouvert la commande (ventes par employé).
--
--   open_cash_day(float)                    Fond de caisse : ouvre la journée et remet les numéros à 1.
--   set_opening_float(float)                Corrige le fond de caisse de la journée ouverte.
--   add_cash_movement(kind, amount, reason, invoice)   Fond d'entrée / de sortie.
--   delete_cash_movement(id)                Supprime une entrée/sortie saisie par erreur (journée ouverte, sans facture).
--   close_cash_day(day, counted, report, note)   Clôture : espèces attendues calculées ici, écart, rapport Z gardé.
--   reset_order_numbers()                   Re-Initialiser le N° des Commandes.
--
-- Nouvelles permissions (Admin oui, Employé non ; réglables dans Fichier > Permissions) :
--   reset_numbers  Re-Initialiser le N°      cash_open  Fond de caisse       cash_in  Fond d'entrée
--   cash_out       Fond de sortie            day_close  Clôturer la journée
--   (« stats » existant = Statistique Journalier.)

-- ───────────── Numérotation par journée ─────────────

-- Le n° de ticket repart à 1 : il n'est plus unique dans l'historique (orders.id reste l'identifiant unique).
alter table public.orders drop constraint if exists orders_ticket_no_key;
create index if not exists orders_ticket_no on public.orders (ticket_no);
create index if not exists orders_closed_at on public.orders (closed_at) where closed_at is not null;
create index if not exists payments_created_at on public.payments (created_at);

create table if not exists public.order_number_resets (
  id                uuid primary key default gen_random_uuid(),
  reason            text not null check (reason in ('manual', 'day_open')),
  last_ticket_no    bigint,     -- derniers numéros donnés avant la remise à 1
  last_takeaway_no  bigint,
  last_delivery_no  bigint,
  created_by        uuid default auth.uid() references auth.users (id) on delete set null,
  user_name         text not null default '',
  created_at        timestamptz not null default now()
);
create index if not exists order_number_resets_date on public.order_number_resets (created_at desc);

-- ───────────── Employé de la commande ─────────────

-- orders.created_by existe depuis le début (auth.uid()) ; on garde aussi le nom, qui reste si le compte est supprimé.
alter table public.orders add column if not exists created_by uuid default auth.uid();
alter table public.orders add column if not exists created_by_name text;
update public.orders o set created_by_name = coalesce(nullif(trim(a.display_name), ''), a.username)
  from public.app_users a where a.user_id = o.created_by and o.created_by_name is null;

create or replace function public.orders_created_by() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_by := coalesce(new.created_by, auth.uid());
  if new.created_by_name is null or new.created_by_name = '' then
    new.created_by_name := nullif(public.current_user_name(), '');
  end if;
  return new;
end $$;
drop trigger if exists orders_created_by on public.orders;
create trigger orders_created_by before insert on public.orders
  for each row execute function public.orders_created_by();

-- ───────────── Journées de caisse ─────────────

create sequence if not exists public.cash_day_no_seq;

create table if not exists public.cash_days (
  id                     uuid primary key default gen_random_uuid(),
  day_no                 bigint not null default nextval('public.cash_day_no_seq'),
  period_start           timestamptz not null,           -- ventes comptées à partir d'ici (clôture précédente)
  opened_at              timestamptz not null default now(),
  opened_by              uuid default auth.uid() references auth.users (id) on delete set null,
  opened_by_name         text not null default '',
  opening_float          numeric(12,2) not null check (opening_float >= 0),
  float_updated_at       timestamptz,                    -- dernière correction du fond de caisse
  float_updated_by_name  text,
  closed_at              timestamptz,
  closed_by              uuid references auth.users (id) on delete set null,
  closed_by_name         text,
  cash_sales             numeric(12,2),                  -- figés à la clôture
  cash_in                numeric(12,2),
  cash_out               numeric(12,2),
  expected_cash          numeric(12,2),
  counted_cash           numeric(12,2) check (counted_cash is null or counted_cash >= 0),
  difference             numeric(12,2),                  -- compté − attendu
  report                 jsonb,                          -- rapport Z (chiffres de la journée au moment de la clôture)
  note                   text not null default ''
);
-- Une seule journée ouverte.
create unique index if not exists cash_days_one_open on public.cash_days ((true)) where closed_at is null;
create index if not exists cash_days_opened on public.cash_days (opened_at desc);
comment on table public.cash_days is 'Journées de travail (caisse), écrites seulement par les fonctions open_cash_day / close_cash_day.';

create table if not exists public.cash_movements (
  id                   uuid primary key default gen_random_uuid(),
  day_id               uuid not null references public.cash_days (id) on delete restrict,
  kind                 text not null check (kind in ('in', 'out')),
  amount               numeric(12,2) not null check (amount > 0),
  reason               text not null default '',
  supplier_invoice_id  uuid references public.supplier_invoices (id) on delete set null,
  supplier_name        text,                            -- fournisseur de la facture réglée, gardé
  created_by           uuid default auth.uid() references auth.users (id) on delete set null,
  user_name            text not null default '',
  created_at           timestamptz not null default now()
);
create index if not exists cash_movements_day on public.cash_movements (day_id, created_at);
create index if not exists cash_movements_date on public.cash_movements (created_at);

-- ───────────── Permissions ─────────────

alter table public.role_permissions drop constraint if exists role_permissions_permission_check;
alter table public.role_permissions add constraint role_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stock_state', 'inventory',
  'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount',
  'reset_numbers', 'cash_open', 'cash_in', 'cash_out', 'day_close'));
alter table public.user_permissions drop constraint if exists user_permissions_permission_check;
alter table public.user_permissions add constraint user_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stock_state', 'inventory',
  'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount',
  'reset_numbers', 'cash_open', 'cash_in', 'cash_out', 'day_close'));

insert into public.role_permissions (role, permission, allowed)
select r, p, r = 'admin'
from unnest(array['admin', 'employe']) r, unnest(array['reset_numbers', 'cash_open', 'cash_in', 'cash_out', 'day_close']) p
on conflict (role, permission) do nothing;

create or replace function public.my_permissions()
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p order by p), '{}')
  from unnest(array['staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges',
                    'stock_state', 'inventory', 'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations',
                    'delivery_zones', 'cancel_order', 'offer', 'discount',
                    'reset_numbers', 'cash_open', 'cash_in', 'cash_out', 'day_close']) p
  where public.has_permission(p)
$$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- ───────────── Remise à 1 des numéros ─────────────

create or replace function public.do_reset_order_numbers(p_reason text)
returns public.order_number_resets
language plpgsql security definer set search_path = public as $$
declare
  v_row public.order_number_resets;
  v_ticket bigint; v_takeaway bigint; v_delivery bigint;
begin
  select case when is_called then last_value end into v_ticket from public.ticket_no_seq;
  select case when is_called then last_value end into v_takeaway from public.takeaway_no_seq;
  select case when is_called then last_value end into v_delivery from public.delivery_no_seq;
  perform setval('public.ticket_no_seq', 1, false);
  perform setval('public.takeaway_no_seq', 1, false);
  perform setval('public.delivery_no_seq', 1, false);
  insert into public.order_number_resets (reason, last_ticket_no, last_takeaway_no, last_delivery_no, user_name)
  values (p_reason, v_ticket, v_takeaway, v_delivery, public.current_user_name())
  returning * into v_row;
  return v_row;
end $$;
revoke all on function public.do_reset_order_numbers(text) from public, anon, authenticated;

create or replace function public.reset_order_numbers()
returns public.order_number_resets
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_permission('reset_numbers') then
    raise exception 'no_permission';
  end if;
  return public.do_reset_order_numbers('manual');
end $$;
revoke all on function public.reset_order_numbers() from public, anon;
grant execute on function public.reset_order_numbers() to authenticated;

-- ───────────── Ouverture, fond de caisse ─────────────

create or replace function public.open_cash_day(p_float numeric)
returns public.cash_days
language plpgsql security definer set search_path = public as $$
declare
  v_day public.cash_days;
  v_float numeric := round(coalesce(p_float, -1), 2);
begin
  if not public.has_permission('cash_open') then
    raise exception 'no_permission';
  end if;
  if v_float < 0 or v_float > 1e9 then
    raise exception 'bad_amount';
  end if;
  -- Deux appareils qui ouvrent en même temps : un seul passe.
  lock table public.cash_days in share row exclusive mode;
  if exists (select 1 from public.cash_days where closed_at is null) then
    raise exception 'day_already_open';
  end if;
  insert into public.cash_days (period_start, opening_float, opened_by_name)
  values (coalesce((select max(closed_at) from public.cash_days), now()), v_float, public.current_user_name())
  returning * into v_day;
  -- Numérotation par journée de travail.
  perform public.do_reset_order_numbers('day_open');
  return v_day;
end $$;
revoke all on function public.open_cash_day(numeric) from public, anon;
grant execute on function public.open_cash_day(numeric) to authenticated;

create or replace function public.set_opening_float(p_float numeric)
returns public.cash_days
language plpgsql security definer set search_path = public as $$
declare
  v_day public.cash_days;
  v_float numeric := round(coalesce(p_float, -1), 2);
begin
  if not public.has_permission('cash_open') then
    raise exception 'no_permission';
  end if;
  if v_float < 0 or v_float > 1e9 then
    raise exception 'bad_amount';
  end if;
  update public.cash_days
     set opening_float = v_float, float_updated_at = now(), float_updated_by_name = public.current_user_name()
   where closed_at is null
  returning * into v_day;
  if not found then
    raise exception 'no_open_day';
  end if;
  return v_day;
end $$;
revoke all on function public.set_opening_float(numeric) from public, anon;
grant execute on function public.set_opening_float(numeric) to authenticated;

-- ───────────── Fonds d'entrée et de sortie ─────────────

create or replace function public.add_cash_movement(p_kind text, p_amount numeric, p_reason text, p_supplier_invoice_id uuid default null)
returns public.cash_movements
language plpgsql security definer set search_path = public as $$
declare
  v_day public.cash_days;
  v_row public.cash_movements;
  v_amount numeric := round(coalesce(p_amount, 0), 2);
  v_supplier text;
begin
  if p_kind not in ('in', 'out') then
    raise exception 'bad_kind';
  end if;
  if not public.has_permission(case p_kind when 'in' then 'cash_in' else 'cash_out' end) then
    raise exception 'no_permission';
  end if;
  if v_amount <= 0 or v_amount > 1e9 then
    raise exception 'bad_amount';
  end if;
  -- Verrou sur la journée : une clôture en cours attend, puis la sortie est refusée.
  select * into v_day from public.cash_days where closed_at is null for update;
  if not found then
    raise exception 'no_open_day';
  end if;
  if p_supplier_invoice_id is not null then
    if p_kind <> 'out' then
      raise exception 'bad_kind';
    end if;
    -- Règlement de la facture (vérifie la permission « purchases » et le reste à payer), dans la même transaction.
    perform public.pay_supplier_invoice(p_supplier_invoice_id, v_amount, current_date);
    select supplier_name into v_supplier from public.supplier_invoices where id = p_supplier_invoice_id;
  end if;
  insert into public.cash_movements (day_id, kind, amount, reason, supplier_invoice_id, supplier_name, user_name)
  values (v_day.id, p_kind, v_amount, left(trim(coalesce(p_reason, '')), 300), p_supplier_invoice_id, v_supplier, public.current_user_name())
  returning * into v_row;
  return v_row;
end $$;
revoke all on function public.add_cash_movement(text, numeric, text, uuid) from public, anon;
grant execute on function public.add_cash_movement(text, numeric, text, uuid) to authenticated;

create or replace function public.delete_cash_movement(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_row public.cash_movements;
begin
  select m.* into v_row from public.cash_movements m where m.id = p_id;
  if not found then
    raise exception 'movement_not_found';
  end if;
  if not public.has_permission(case v_row.kind when 'in' then 'cash_in' else 'cash_out' end) then
    raise exception 'no_permission';
  end if;
  -- Ligne de la journée ouverte seulement (verrou : pas pendant une clôture).
  perform 1 from public.cash_days where id = v_row.day_id and closed_at is null for update;
  if not found then
    raise exception 'day_closed';
  end if;
  if v_row.supplier_invoice_id is not null then
    raise exception 'movement_has_invoice';
  end if;
  delete from public.cash_movements where id = p_id;
end $$;
revoke all on function public.delete_cash_movement(uuid) from public, anon;
grant execute on function public.delete_cash_movement(uuid) to authenticated;

-- ───────────── Clôture ─────────────

-- Espèces de la journée : ventes en espèces (paiements, monnaie rendue déjà déduite), entrées, sorties.
create or replace function public.cash_day_totals(p_day_id uuid, p_until timestamptz)
returns table (cash_sales numeric, cash_in numeric, cash_out numeric)
language sql stable security definer set search_path = public as $$
  select
    (select coalesce(sum(p.amount), 0) from public.payments p, public.cash_days d
      where d.id = p_day_id and p.method = 'cash' and p.created_at >= d.period_start and p.created_at < p_until),
    (select coalesce(sum(amount), 0) from public.cash_movements where day_id = p_day_id and kind = 'in'),
    (select coalesce(sum(amount), 0) from public.cash_movements where day_id = p_day_id and kind = 'out')
$$;
revoke all on function public.cash_day_totals(uuid, timestamptz) from public, anon, authenticated;

create or replace function public.close_cash_day(p_day_id uuid, p_counted numeric, p_report jsonb default null, p_note text default '')
returns public.cash_days
language plpgsql security definer set search_path = public as $$
declare
  v_day public.cash_days;
  v_counted numeric := round(coalesce(p_counted, -1), 2);
  v_now timestamptz := clock_timestamp();
  v_tot record;
  v_expected numeric;
begin
  if not public.has_permission('day_close') then
    raise exception 'no_permission';
  end if;
  if v_counted < 0 or v_counted > 1e9 then
    raise exception 'bad_amount';
  end if;
  -- Verrou : deux clôtures en même temps, la seconde voit la journée déjà clôturée.
  select * into v_day from public.cash_days where id = p_day_id for update;
  if not found then
    raise exception 'day_not_found';
  end if;
  if v_day.closed_at is not null then
    raise exception 'day_already_closed';
  end if;
  select * into v_tot from public.cash_day_totals(v_day.id, v_now);
  v_expected := v_day.opening_float + v_tot.cash_sales + v_tot.cash_in - v_tot.cash_out;
  update public.cash_days set
    closed_at      = v_now,
    closed_by      = auth.uid(),
    closed_by_name = public.current_user_name(),
    cash_sales     = v_tot.cash_sales,
    cash_in        = v_tot.cash_in,
    cash_out       = v_tot.cash_out,
    expected_cash  = v_expected,
    counted_cash   = v_counted,
    difference     = v_counted - v_expected,
    report         = p_report,
    note           = left(trim(coalesce(p_note, '')), 500)
  where id = v_day.id
  returning * into v_day;
  return v_day;
end $$;
revoke all on function public.close_cash_day(uuid, numeric, jsonb, text) from public, anon;
grant execute on function public.close_cash_day(uuid, numeric, jsonb, text) to authenticated;

-- ───────────── RLS : lecture selon les permissions, écriture seulement par les fonctions ─────────────

alter table public.cash_days enable row level security;
alter table public.cash_movements enable row level security;
alter table public.order_number_resets enable row level security;

drop policy if exists "perm read cash_days" on public.cash_days;
create policy "perm read cash_days" on public.cash_days for select to authenticated using (
  public.has_permission('stats') or public.has_permission('cash_open') or public.has_permission('cash_in')
  or public.has_permission('cash_out') or public.has_permission('day_close'));
drop policy if exists "perm read cash_movements" on public.cash_movements;
create policy "perm read cash_movements" on public.cash_movements for select to authenticated using (
  public.has_permission('stats') or public.has_permission('cash_open') or public.has_permission('cash_in')
  or public.has_permission('cash_out') or public.has_permission('day_close'));
drop policy if exists "perm read order_number_resets" on public.order_number_resets;
create policy "perm read order_number_resets" on public.order_number_resets for select to authenticated using (
  public.has_permission('reset_numbers') or public.has_permission('stats'));
grant select on public.cash_days, public.cash_movements, public.order_number_resets to authenticated;
revoke insert, update, delete on public.cash_days, public.cash_movements, public.order_number_resets from authenticated, anon;

-- ───────────── Realtime : caisse suivie sur tous les appareils ─────────────

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['cash_days', 'cash_movements'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

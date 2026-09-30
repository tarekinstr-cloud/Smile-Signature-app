-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Statistiques / bénéfice › Contrôle (à exécuter après 20260930130000_payments_need_open_day.sql).
--
-- • Commandes annulées : motif obligatoire (code de la liste + texte libre, obligatoire pour « autre ») dès qu'une
--   commande a des articles ; date, auteur et montant figés par la base.
-- • Factures annulées : une commande dont l'addition ou la facture a été imprimée, ou un ticket déjà encaissé
--   (void_paid_order), ne s'annule qu'avec la permission cancel_invoice. Un ticket encaissé annulé rend ses espèces :
--   elles sortent des espèces attendues de la journée ouverte (cash_day_totals).
-- • Liste des modifications des prix : journal automatique, non modifiable (articles, tailles, suppléments).
-- • Permissions : cancelled_orders, cancelled_invoices, cancel_invoice, price_log (Admin oui, Employé non).
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- ───────────── Permissions ─────────────

alter table public.role_permissions drop constraint if exists role_permissions_permission_check;
alter table public.role_permissions add constraint role_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stock_state', 'inventory',
  'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount',
  'reset_numbers', 'cash_open', 'cash_in', 'cash_out', 'day_close', 'weekly_stats', 'expenses', 'profit',
  'cancelled_orders', 'cancelled_invoices', 'cancel_invoice', 'price_log'));
alter table public.user_permissions drop constraint if exists user_permissions_permission_check;
alter table public.user_permissions add constraint user_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stock_state', 'inventory',
  'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount',
  'reset_numbers', 'cash_open', 'cash_in', 'cash_out', 'day_close', 'weekly_stats', 'expenses', 'profit',
  'cancelled_orders', 'cancelled_invoices', 'cancel_invoice', 'price_log'));

insert into public.role_permissions (role, permission, allowed)
select r, p, r = 'admin'
from unnest(array['admin', 'employe']) r, unnest(array['cancelled_orders', 'cancelled_invoices', 'cancel_invoice', 'price_log']) p
on conflict (role, permission) do nothing;

create or replace function public.my_permissions()
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p order by p), '{}')
  from unnest(array['staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges',
                    'stock_state', 'inventory', 'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations',
                    'delivery_zones', 'cancel_order', 'offer', 'discount',
                    'reset_numbers', 'cash_open', 'cash_in', 'cash_out', 'day_close', 'weekly_stats', 'expenses', 'profit',
                    'cancelled_orders', 'cancelled_invoices', 'cancel_invoice', 'price_log']) p
  where public.has_permission(p)
$$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- ───────────── Annulation : motif obligatoire, impression, ticket encaissé ─────────────

alter table public.orders add column if not exists cancel_reason     text;
alter table public.orders add column if not exists cancel_note       text;
alter table public.orders add column if not exists cancelled_at      timestamptz;
alter table public.orders add column if not exists cancelled_by_name text;
alter table public.orders add column if not exists cancelled_total   numeric(10,2);
-- Addition (ticket caisse) imprimée pour cette commande.
alter table public.orders add column if not exists printed_at        timestamptz;
-- Ticket encaissé puis annulé : journée de caisse qui a rendu l'argent, et part rendue en espèces.
alter table public.orders add column if not exists voided            boolean not null default false;
alter table public.orders add column if not exists voided_day_id     uuid references public.cash_days (id) on delete set null;
alter table public.orders add column if not exists void_cash         numeric(10,2) not null default 0;
create index if not exists orders_cancelled_at on public.orders (cancelled_at) where status = 'cancelled';
create index if not exists orders_voided_day on public.orders (voided_day_id) where voided;

create or replace function public.orders_cancel_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_void boolean := coalesce(current_setting('smile.void', true), '') = 'on';
begin
  -- Colonnes écrites seulement par la base.
  if not v_void and (new.voided is distinct from old.voided or new.voided_day_id is distinct from old.voided_day_id
                     or new.void_cash is distinct from old.void_cash) then
    raise exception 'void_by_rpc_only';
  end if;
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    -- Un ticket encaissé ne s'annule que par void_paid_order (l'argent rendu sort de la caisse).
    if old.status = 'paid' and not v_void then
      raise exception 'void_by_rpc_only';
    end if;
    if exists (select 1 from public.order_items i where i.order_id = new.id) then
      if coalesce(trim(new.cancel_reason), '') = '' then
        raise exception 'cancel_reason_required';
      end if;
      if new.cancel_reason = 'other' and coalesce(trim(new.cancel_note), '') = '' then
        raise exception 'cancel_note_required';
      end if;
      if (old.status = 'paid' or old.printed_at is not null or old.invoice_no is not null)
         and not public.permission_ok('cancel_invoice') then
        raise exception 'permission_denied:cancel_invoice';
      end if;
    end if;
    new.cancel_reason     := left(trim(coalesce(new.cancel_reason, '')), 40);
    new.cancel_note       := left(trim(coalesce(new.cancel_note, '')), 300);
    new.cancelled_at      := now();
    new.cancelled_by_name := public.current_user_name();
    new.cancelled_total   := case when old.status = 'paid' then old.total else public.order_total(new.id) end;
  elsif new.status is not distinct from old.status then
    -- Pas de réécriture du motif après coup.
    new.cancel_reason     := old.cancel_reason;
    new.cancel_note       := old.cancel_note;
    new.cancelled_at      := old.cancelled_at;
    new.cancelled_by_name := old.cancelled_by_name;
    new.cancelled_total   := old.cancelled_total;
  end if;
  return new;
end $$;
revoke all on function public.orders_cancel_guard() from public, anon, authenticated;

drop trigger if exists orders_cancel_guard on public.orders;
create trigger orders_cancel_guard
  before update on public.orders
  for each row execute function public.orders_cancel_guard();

-- Annuler un ticket déjà encaissé (facture / ticket annulé après paiement).
create or replace function public.void_paid_order(p_order_id uuid, p_reason text, p_note text default '')
returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  o public.orders;
  v_day uuid;
  v_cash numeric(10,2);
  v_available numeric;
begin
  if not public.has_permission('cancel_invoice') then
    raise exception 'no_permission';
  end if;
  select * into o from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found';
  end if;
  if o.status <> 'paid' then
    raise exception 'order_not_paid';
  end if;
  -- L'argent rendu sort de la caisse de la journée ouverte : verrou comme un Fond de sortie, jamais au-delà des
  -- espèces attendues.
  select id into v_day from public.cash_days where closed_at is null for update;
  if not found then
    raise exception 'no_open_day';
  end if;
  select coalesce(sum(amount), 0) into v_cash from public.payments where order_id = p_order_id and method = 'cash';
  select round(d.opening_float + t.cash_sales + t.cash_in - t.cash_out, 2) into v_available
    from public.cash_days d, public.cash_day_totals(d.id, now()) t where d.id = v_day;
  if v_cash > v_available then
    raise exception 'insufficient_cash:%', v_available;
  end if;
  perform set_config('smile.void', 'on', true);
  update public.orders set
    status        = 'cancelled',
    cancel_reason = p_reason,
    cancel_note   = p_note,
    voided        = true,
    voided_day_id = v_day,
    void_cash     = v_cash
  where id = p_order_id
  returning * into o;
  perform set_config('smile.void', 'off', true);
  return o;
end $$;
revoke all on function public.void_paid_order(uuid, text, text) from public, anon;
grant execute on function public.void_paid_order(uuid, text, text) to authenticated;

-- Espèces de la journée : les tickets annulés dans la journée rendent leur part en espèces.
create or replace function public.cash_day_totals(p_day_id uuid, p_until timestamptz)
returns table (cash_sales numeric, cash_in numeric, cash_out numeric)
language sql stable security definer set search_path = public as $$
  select
    (select coalesce(sum(p.amount), 0) from public.payments p, public.cash_days d
      where d.id = p_day_id and p.method = 'cash' and p.created_at >= d.period_start and p.created_at < p_until)
    - (select coalesce(sum(o.void_cash), 0) from public.orders o where o.voided and o.voided_day_id = p_day_id),
    (select coalesce(sum(amount), 0) from public.cash_movements where day_id = p_day_id and kind = 'in'),
    (select coalesce(sum(amount), 0) from public.cash_movements where day_id = p_day_id and kind = 'out')
$$;
revoke all on function public.cash_day_totals(uuid, timestamptz) from public, anon, authenticated;

-- ───────────── Journal des prix ─────────────

create table if not exists public.price_changes (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('item', 'size', 'supplement')),
  item_id     uuid,
  option_id   uuid,
  item_name   text not null default '',
  group_name  text not null default '',
  option_name text not null default '',
  old_price   numeric(10,2) not null,
  new_price   numeric(10,2) not null,
  user_name   text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists price_changes_created_at on public.price_changes (created_at desc);
comment on table public.price_changes is 'Liste des modifications des prix : écrite par les triggers, jamais modifiée.';

create or replace function public.items_log_price() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.price is distinct from old.price then
    insert into public.price_changes (kind, item_id, item_name, old_price, new_price, user_name)
    values ('item', new.id, new.name, old.price, new.price, public.current_user_name());
  end if;
  return new;
end $$;
revoke all on function public.items_log_price() from public, anon, authenticated;
drop trigger if exists items_log_price on public.items;
create trigger items_log_price after update of price on public.items
  for each row execute function public.items_log_price();

-- Option d'un groupe « un seul choix obligatoire » = taille ; sinon supplément.
create or replace function public.options_log_price() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  g public.option_groups;
  v_item text;
begin
  if new.price_delta is distinct from old.price_delta then
    select * into g from public.option_groups where id = new.group_id;
    select name into v_item from public.items where id = g.item_id;
    insert into public.price_changes (kind, item_id, option_id, item_name, group_name, option_name, old_price, new_price, user_name)
    values (case when g.min_select >= 1 and g.max_select = 1 then 'size' else 'supplement' end,
            g.item_id, new.id, coalesce(v_item, ''), coalesce(g.name, ''), new.name, old.price_delta, new.price_delta,
            public.current_user_name());
  end if;
  return new;
end $$;
revoke all on function public.options_log_price() from public, anon, authenticated;
drop trigger if exists options_log_price on public.options;
create trigger options_log_price after update of price_delta on public.options
  for each row execute function public.options_log_price();

-- Lecture avec la permission ; aucune écriture possible depuis l'application.
alter table public.price_changes enable row level security;
drop policy if exists "perm read price_changes" on public.price_changes;
create policy "perm read price_changes" on public.price_changes for select to authenticated using (public.has_permission('price_log'));
revoke insert, update, delete, truncate on public.price_changes from anon, authenticated;
grant select on public.price_changes to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'price_changes') then
    alter publication supabase_realtime add table public.price_changes;
  end if;
end $$;

notify pgrst, 'reload schema';

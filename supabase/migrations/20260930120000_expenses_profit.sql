-- Smile Signature: menu Statistiques / bénéfice, partie 2 :
--   Récapitulatif Hebdomadaire, Liste des dépenses, Bénéfice (coût de revient figé à la clôture des commandes).
-- Idempotent: peut être exécuté plusieurs fois sans problème.
-- À exécuter après 20260930110000_cash_register.sql.
--
--   order_items.unit_cost / cost_status   Coût de revient d'une portion (fiche technique × dernier prix d'achat),
--                            enregistré quand la commande passe « payée » et jamais recalculé ensuite : les bénéfices
--                            passés ne changent pas quand les prix d'achat évoluent.
--                            cost_status : ok | no_recipe (article sans fiche : coût 0, « coût inconnu »)
--                                          | no_price (un ingrédient n'a jamais été acheté : compté 0).
--                            Les commandes déjà payées avant cette migration reçoivent une fois le coût actuel.
--   expense_categories       Catégories de dépenses modifiables (Loyer, Électricité, Gaz, Eau, Internet, Entretien, Divers).
--   expenses                 Dépenses générales : catégorie, montant, date, mode (espèces caisse / autre), note.
--                            Mode « espèces caisse » = un Fond de sortie de la journée ouverte, lié (cash_movement_id) :
--                            une sortie liée à une dépense n'apparaît qu'une fois.
--   add_cash_movement(…, expense_category)   Fond de sortie lié à une dépense (crée la dépense).
--   save_expense / delete_expense            Dépenses (la sortie de caisse liée suit).
--   profit_summary(from, to, first, last)    Charges cuisine, écarts d'inventaire négatifs, salaires au prorata,
--                                            dépenses de la période (lu par la page Bénéfice).
--
-- Nouvelles permissions (Admin oui, Employé non ; réglables dans Fichier > Permissions) :
--   weekly_stats  Récapitulatif Hebdomadaire     expenses  Liste des dépenses     profit  Bénéfice
-- Les dates « du jour » calculées dans la base utilisent le fuseau Africa/Algiers.

-- ───────────── Permissions ─────────────

alter table public.role_permissions drop constraint if exists role_permissions_permission_check;
alter table public.role_permissions add constraint role_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stock_state', 'inventory',
  'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount',
  'reset_numbers', 'cash_open', 'cash_in', 'cash_out', 'day_close', 'weekly_stats', 'expenses', 'profit'));
alter table public.user_permissions drop constraint if exists user_permissions_permission_check;
alter table public.user_permissions add constraint user_permissions_permission_check check (permission in (
  'staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges', 'stock_state', 'inventory',
  'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones', 'cancel_order', 'offer', 'discount',
  'reset_numbers', 'cash_open', 'cash_in', 'cash_out', 'day_close', 'weekly_stats', 'expenses', 'profit'));

insert into public.role_permissions (role, permission, allowed)
select r, p, r = 'admin'
from unnest(array['admin', 'employe']) r, unnest(array['weekly_stats', 'expenses', 'profit']) p
on conflict (role, permission) do nothing;

create or replace function public.my_permissions()
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p order by p), '{}')
  from unnest(array['staff', 'payroll', 'devices', 'stock', 'suppliers', 'purchases', 'stock_transfer', 'kitchen_charges',
                    'stock_state', 'inventory', 'recipes', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations',
                    'delivery_zones', 'cancel_order', 'offer', 'discount',
                    'reset_numbers', 'cash_open', 'cash_in', 'cash_out', 'day_close', 'weekly_stats', 'expenses', 'profit']) p
  where public.has_permission(p)
$$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- Le Récapitulatif Hebdomadaire montre l'écart de caisse des journées.
drop policy if exists "perm read cash_days" on public.cash_days;
create policy "perm read cash_days" on public.cash_days for select to authenticated using (
  public.has_permission('stats') or public.has_permission('cash_open') or public.has_permission('cash_in')
  or public.has_permission('cash_out') or public.has_permission('day_close') or public.has_permission('weekly_stats'));

-- ───────────── Coût de revient figé des lignes ─────────────

alter table public.order_items add column if not exists unit_cost numeric(14,4);
alter table public.order_items add column if not exists cost_status text;
alter table public.order_items drop constraint if exists order_items_cost_status_check;
alter table public.order_items add constraint order_items_cost_status_check check (cost_status is null or cost_status in ('ok', 'no_recipe', 'no_price'));

-- Coût d'une portion d'une ligne : fiche de l'article (base) + fiche de chaque option choisie (taille, suppléments),
-- au dernier prix d'achat. Mêmes règles que order_consumption_needs() (options par id, sinon groupe + nom).
create or replace function public.order_line_cost(p_line_id uuid, out cost numeric, out status text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_n integer;
  v_missing integer;
begin
  with l as (
    select oi.item_id, case when jsonb_typeof(oi.options) = 'array' then oi.options else '[]'::jsonb end as options
      from public.order_items oi
     where oi.id = p_line_id and oi.item_id is not null
  ), chosen as (
    select distinct o.id as option_id
      from l
      cross join lateral jsonb_array_elements(l.options) c
      join public.option_groups g on g.item_id = l.item_id
      join public.options o on o.group_id = g.id
     where case when (c ->> 'option_id') is not null then o.id::text = c ->> 'option_id'
                else lower(trim(g.name)) = lower(trim(c ->> 'group')) and lower(trim(o.name)) = lower(trim(c ->> 'name')) end
  ), needs as (
    select r.stock_item_id, r.quantity as q from l join public.recipe_lines r on r.item_id = l.item_id and r.option_id is null
    union all
    select r.stock_item_id, r.quantity from chosen c join public.recipe_lines r on r.option_id = c.option_id
  ), priced as (
    select n.stock_item_id, sum(n.q) as q, public.last_purchase_price(n.stock_item_id) as p from needs n group by n.stock_item_id
  )
  select count(*), count(*) filter (where p is null), coalesce(sum(q * coalesce(p, 0)), 0)
    into v_n, v_missing, cost
    from priced;
  status := case when v_n = 0 then 'no_recipe' when v_missing > 0 then 'no_price' else 'ok' end;
  cost := round(cost, 4);
end $$;
revoke all on function public.order_line_cost(uuid) from public, anon, authenticated;

-- Fige le coût des lignes d'une commande qui n'en ont pas encore (une seule fois).
create or replace function public.snapshot_order_costs(p_order_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_n integer;
begin
  perform set_config('smile.cost_snapshot', 'on', true);
  update public.order_items oi
     set unit_cost = c.cost, cost_status = c.status
    from public.order_items x
    cross join lateral public.order_line_cost(x.id) c
   where x.id = oi.id and oi.order_id = p_order_id and oi.unit_cost is null;
  get diagnostics v_n = row_count;
  perform set_config('smile.cost_snapshot', 'off', true);
  return v_n;
end $$;
revoke all on function public.snapshot_order_costs(uuid) from public, anon, authenticated;

-- Le coût figé ne s'écrit que par snapshot_order_costs() (l'app ne peut ni le poser ni le changer).
create or replace function public.order_items_guard_cost() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('smile.cost_snapshot', true), 'off') <> 'on' then
    if tg_op = 'INSERT' then
      new.unit_cost := null;
      new.cost_status := null;
    else
      new.unit_cost := old.unit_cost;
      new.cost_status := old.cost_status;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists order_items_guard_cost on public.order_items;
create trigger order_items_guard_cost before insert or update on public.order_items
  for each row execute function public.order_items_guard_cost();

-- Au passage à « payée » (même transaction que le paiement). Une erreur ne bloque jamais la vente.
create or replace function public.orders_snapshot_costs() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.snapshot_order_costs(new.id);
  exception when others then
    raise warning 'cost snapshot failed for order %: %', new.id, sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists orders_snapshot_costs on public.orders;
create trigger orders_snapshot_costs after update of status on public.orders
  for each row when (new.status = 'paid' and old.status is distinct from 'paid')
  execute function public.orders_snapshot_costs();

-- Commandes déjà payées : coût actuel, une fois.
do $$
declare v_id uuid;
begin
  for v_id in select distinct o.id from public.orders o join public.order_items i on i.order_id = o.id
               where o.status = 'paid' and i.unit_cost is null loop
    perform public.snapshot_order_costs(v_id);
  end loop;
end $$;

-- ───────────── Dépenses ─────────────

create table if not exists public.expense_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 60),
  sort_order  integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists expense_categories_name on public.expense_categories (lower(trim(name)));

insert into public.expense_categories (name, sort_order)
select n, i from unnest(array['Loyer', 'Électricité', 'Gaz', 'Eau', 'Internet', 'Entretien', 'Divers']) with ordinality as t(n, i)
where not exists (select 1 from public.expense_categories)
on conflict do nothing;

create table if not exists public.expenses (
  id                uuid primary key default gen_random_uuid(),
  category_id       uuid references public.expense_categories (id) on delete set null,
  category_name     text not null default '',           -- gardé si la catégorie est supprimée
  amount            numeric(12,2) not null check (amount > 0),
  date              date not null,
  mode              text not null check (mode in ('cash', 'other')),   -- espèces caisse / autre
  note              text not null default '',
  cash_movement_id  uuid unique references public.cash_movements (id) on delete cascade,
  created_by        uuid default auth.uid() references auth.users (id) on delete set null,
  user_name         text not null default '',
  created_at        timestamptz not null default now()
);
create index if not exists expenses_date on public.expenses (date desc);

create or replace function public.local_today() returns date
language sql stable as $$ select (now() at time zone 'Africa/Algiers')::date $$;

-- Fond de sortie : peut aussi être lié à une dépense (catégorie) ; les deux dans la même transaction.
drop function if exists public.add_cash_movement(text, numeric, text, uuid);
create or replace function public.add_cash_movement(p_kind text, p_amount numeric, p_reason text,
  p_supplier_invoice_id uuid default null, p_expense_category_id uuid default null)
returns public.cash_movements
language plpgsql security definer set search_path = public as $$
declare
  v_day public.cash_days;
  v_row public.cash_movements;
  v_amount numeric := round(coalesce(p_amount, 0), 2);
  v_supplier text;
  v_category public.expense_categories;
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
  if (p_supplier_invoice_id is not null or p_expense_category_id is not null) and p_kind <> 'out' then
    raise exception 'bad_kind';
  end if;
  if p_supplier_invoice_id is not null and p_expense_category_id is not null then
    raise exception 'bad_kind';
  end if;
  if p_expense_category_id is not null then
    select * into v_category from public.expense_categories where id = p_expense_category_id;
    if not found then
      raise exception 'category_not_found';
    end if;
  end if;
  -- Verrou sur la journée : une clôture en cours attend, puis la sortie est refusée.
  select * into v_day from public.cash_days where closed_at is null for update;
  if not found then
    raise exception 'no_open_day';
  end if;
  if p_supplier_invoice_id is not null then
    perform public.pay_supplier_invoice(p_supplier_invoice_id, v_amount, public.local_today());
    select supplier_name into v_supplier from public.supplier_invoices where id = p_supplier_invoice_id;
  end if;
  insert into public.cash_movements (day_id, kind, amount, reason, supplier_invoice_id, supplier_name, user_name)
  values (v_day.id, p_kind, v_amount, left(trim(coalesce(p_reason, '')), 300), p_supplier_invoice_id, v_supplier, public.current_user_name())
  returning * into v_row;
  if p_expense_category_id is not null then
    insert into public.expenses (category_id, category_name, amount, date, mode, note, cash_movement_id, user_name)
    values (v_category.id, v_category.name, v_amount, public.local_today(), 'cash', v_row.reason, v_row.id, v_row.user_name);
  end if;
  return v_row;
end $$;
revoke all on function public.add_cash_movement(text, numeric, text, uuid, uuid) from public, anon;
grant execute on function public.add_cash_movement(text, numeric, text, uuid, uuid) to authenticated;

-- Crée ou modifie une dépense. « Espèces caisse » : une sortie de la journée ouverte est créée (ou suit le montant).
-- Une dépense liée à une journée clôturée garde son montant.
create or replace function public.save_expense(p_id uuid, p_category_id uuid, p_amount numeric, p_date date, p_mode text, p_note text)
returns public.expenses
language plpgsql security definer set search_path = public as $$
declare
  v_row public.expenses;
  v_old public.expenses;
  v_category public.expense_categories;
  v_day public.cash_days;
  v_move public.cash_movements;
  v_amount numeric := round(coalesce(p_amount, 0), 2);
  v_note text := left(trim(coalesce(p_note, '')), 300);
begin
  if not public.has_permission('expenses') then
    raise exception 'no_permission';
  end if;
  if v_amount <= 0 or v_amount > 1e9 then
    raise exception 'bad_amount';
  end if;
  if p_mode not in ('cash', 'other') or p_date is null then
    raise exception 'bad_expense';
  end if;
  select * into v_category from public.expense_categories where id = p_category_id;
  if not found then
    raise exception 'category_not_found';
  end if;

  if p_id is null then
    if p_mode = 'cash' then
      select * into v_day from public.cash_days where closed_at is null for update;
      if not found then
        raise exception 'no_open_day';
      end if;
      insert into public.cash_movements (day_id, kind, amount, reason, user_name)
      values (v_day.id, 'out', v_amount, coalesce(nullif(v_note, ''), v_category.name), public.current_user_name())
      returning * into v_move;
    end if;
    insert into public.expenses (category_id, category_name, amount, date, mode, note, cash_movement_id, user_name)
    values (v_category.id, v_category.name, v_amount, case when p_mode = 'cash' then public.local_today() else p_date end,
            p_mode, v_note, v_move.id, public.current_user_name())
    returning * into v_row;
    return v_row;
  end if;

  select * into v_old from public.expenses where id = p_id for update;
  if not found then
    raise exception 'expense_not_found';
  end if;
  if p_mode <> v_old.mode then
    raise exception 'expense_mode_locked';
  end if;
  if v_old.cash_movement_id is not null and v_amount <> v_old.amount then
    select d.* into v_day from public.cash_days d join public.cash_movements m on m.day_id = d.id
     where m.id = v_old.cash_movement_id and d.closed_at is null for update of d;
    if not found then
      raise exception 'day_closed';
    end if;
    update public.cash_movements set amount = v_amount where id = v_old.cash_movement_id;
  end if;
  update public.expenses set
    category_id = v_category.id, category_name = v_category.name, amount = v_amount,
    date = case when v_old.cash_movement_id is null then p_date else v_old.date end, note = v_note
  where id = p_id
  returning * into v_row;
  return v_row;
end $$;
revoke all on function public.save_expense(uuid, uuid, numeric, date, text, text) from public, anon;
grant execute on function public.save_expense(uuid, uuid, numeric, date, text, text) to authenticated;

-- Supprime une dépense ; liée à la caisse : seulement pendant sa journée (la sortie est supprimée avec).
create or replace function public.delete_expense(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_old public.expenses;
begin
  if not public.has_permission('expenses') then
    raise exception 'no_permission';
  end if;
  select * into v_old from public.expenses where id = p_id for update;
  if not found then
    return;
  end if;
  if v_old.cash_movement_id is not null then
    perform 1 from public.cash_days d join public.cash_movements m on m.day_id = d.id
     where m.id = v_old.cash_movement_id and d.closed_at is null for update of d;
    if not found then
      raise exception 'day_closed';
    end if;
    delete from public.cash_movements where id = v_old.cash_movement_id;   -- la dépense suit (cascade)
  else
    delete from public.expenses where id = p_id;
  end if;
end $$;
revoke all on function public.delete_expense(uuid) from public, anon;
grant execute on function public.delete_expense(uuid) to authenticated;

alter table public.expense_categories enable row level security;
alter table public.expenses enable row level security;
drop policy if exists "staff read expense_categories" on public.expense_categories;
create policy "staff read expense_categories" on public.expense_categories for select to authenticated using (true);
drop policy if exists "perm expenses write expense_categories" on public.expense_categories;
create policy "perm expenses write expense_categories" on public.expense_categories for all to authenticated
  using (public.has_permission('expenses')) with check (public.has_permission('expenses'));
drop policy if exists "perm read expenses" on public.expenses;
create policy "perm read expenses" on public.expenses for select to authenticated using (
  public.has_permission('expenses') or public.has_permission('profit') or public.has_permission('weekly_stats'));
grant select, insert, update, delete on public.expense_categories to authenticated;
grant select on public.expenses to authenticated;
revoke insert, update, delete on public.expenses from authenticated, anon;

-- ───────────── Bénéfice : charges, écarts, salaires, dépenses d'une période ─────────────

-- p_from / p_to : instants (charges cuisine, inventaires) ; p_first / p_last : jours inclus (salaires, dépenses).
create or replace function public.profit_summary(p_from timestamptz, p_to timestamptz, p_first date, p_last date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  if not public.has_permission('profit') then
    raise exception 'no_permission';
  end if;
  if p_to <= p_from or p_last < p_first then
    raise exception 'bad_period';
  end if;
  select jsonb_build_object(
    'charges', (select coalesce(round(sum(m.quantity * coalesce(m.unit_cost, public.last_purchase_price(m.stock_item_id), 0)), 2), 0)
                  from public.stock_movements m where m.type = 'charge' and m.created_at >= p_from and m.created_at < p_to),
    'charges_by_reason', (select coalesce(jsonb_object_agg(x.r, x.v), '{}') from (
                  select coalesce(m.reason, 'other') r, round(sum(m.quantity * coalesce(m.unit_cost, public.last_purchase_price(m.stock_item_id), 0)), 2) v
                    from public.stock_movements m where m.type = 'charge' and m.created_at >= p_from and m.created_at < p_to
                   group by 1) x),
    'inventory_loss', (select coalesce(round(sum(-l.gap * coalesce(l.unit_cost, 0)), 2), 0)
                  from public.stock_inventory_lines l join public.stock_inventories i on i.id = l.inventory_id
                 where l.gap < 0 and i.created_at >= p_from and i.created_at < p_to),
    'salaries', (select coalesce(round(sum(a.monthly_salary / extract(day from (date_trunc('month', d) + interval '1 month - 1 day'))), 2), 0)
                  from public.app_users a cross join generate_series(p_first, p_last, interval '1 day') d
                 where a.active and a.monthly_salary > 0),
    'expenses', (select coalesce(sum(e.amount), 0) from public.expenses e where e.date between p_first and p_last),
    'expenses_by_category', (select coalesce(jsonb_object_agg(x.c, x.v), '{}') from (
                  select coalesce(ec.name, e.category_name) c, sum(e.amount) v
                    from public.expenses e left join public.expense_categories ec on ec.id = e.category_id
                   where e.date between p_first and p_last group by 1) x)
  ) into v_result;
  return v_result;
end $$;
revoke all on function public.profit_summary(timestamptz, timestamptz, date, date) from public, anon;
grant execute on function public.profit_summary(timestamptz, timestamptz, date, date) to authenticated;

-- ───────────── Realtime ─────────────

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['expenses', 'expense_categories'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- Smile Signature: barre d'actions de la commande — à emporter, changement de table (journal table_moves), facture.
-- Idempotent: peut être exécuté plusieurs fois. Nécessite 20260928010000_payments.sql.

-- ───────────── Type de commande, n° à emporter, client et n° de facture ─────────────
-- order_type: 'dine_in' (sur une table) ou 'takeaway' (à emporter, sans table)

alter table public.orders
  add column if not exists order_type        text not null default 'dine_in',
  add column if not exists takeaway_no       integer,
  add column if not exists customer_name     text,
  add column if not exists customer_address  text,
  add column if not exists invoice_no        bigint;

-- Une commande à emporter n'a pas de table (la colonne est déjà nullable, on s'en assure).
alter table public.orders alter column table_id drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_order_type_check') then
    alter table public.orders add constraint orders_order_type_check check (order_type in ('dine_in', 'takeaway'));
  end if;
end $$;

create unique index if not exists orders_invoice_no_key on public.orders (invoice_no) where invoice_no is not null;
create index if not exists orders_open_takeaway_idx on public.orders (created_at) where status = 'open' and order_type = 'takeaway';

create sequence if not exists public.takeaway_no_seq;
create sequence if not exists public.invoice_no_seq;

-- À emporter: pas de table, et un numéro court pour l'appeler (« À emporter n° 12 »).
create or replace function public.orders_takeaway_no() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.order_type = 'takeaway' then
    new.table_id := null;
    if new.takeaway_no is null then
      new.takeaway_no := nextval('public.takeaway_no_seq');
    end if;
  end if;
  return new;
end $$;

drop trigger if exists orders_takeaway_no on public.orders;
create trigger orders_takeaway_no
  before insert or update of order_type, table_id on public.orders
  for each row execute function public.orders_takeaway_no();

-- Commande ouverte qui change de table (ou passe à emporter): l'ancienne table est libérée, la nouvelle occupée.
create or replace function public.sync_table_status_on_move() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'open' and new.table_id is distinct from old.table_id then
    if old.table_id is not null and not exists (
      select 1 from public.orders where table_id = old.table_id and status = 'open' and id <> new.id
    ) then
      update public.tables set status = 'free' where id = old.table_id;
    end if;
    if new.table_id is not null then
      update public.tables set status = 'occupied' where id = new.table_id and status <> 'occupied';
    end if;
  end if;
  return null;
end $$;

drop trigger if exists orders_sync_table_on_move on public.orders;
create trigger orders_sync_table_on_move
  after update of table_id on public.orders
  for each row execute function public.sync_table_status_on_move();

-- ───────────── Journal des changements de table ─────────────
-- to_table_id / to_label null = passée « à emporter » ; from_* null = venait d'une commande à emporter.

create table if not exists public.table_moves (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.orders(id) on delete cascade,
  from_table_id  uuid references public.tables(id) on delete set null,
  to_table_id    uuid references public.tables(id) on delete set null,
  from_label     text,
  to_label       text,
  moved_by       uuid default auth.uid(),
  moved_by_name  text,
  moved_at       timestamptz not null default now()
);
create index if not exists table_moves_order_id_idx on public.table_moves (order_id);
create index if not exists table_moves_moved_at_idx on public.table_moves (moved_at);

alter table public.table_moves enable row level security;
drop policy if exists "staff all table_moves" on public.table_moves;
create policy "staff all table_moves" on public.table_moves for all to authenticated using (true) with check (true);

-- Déplace une commande ouverte vers une table libre (p_table_id), ou la passe à emporter (p_table_id null).
-- Les articles, leur envoi cuisine, les remises et les paiements restent attachés à la commande.
-- Refuse une table qui a déjà une commande ouverte ('table_occupied').
create or replace function public.move_order(p_order_id uuid, p_table_id uuid, p_user_name text default null)
returns public.orders
language plpgsql set search_path = public as $$
declare
  o       public.orders;
  v_from  text;
  v_to    text;
  v_from_id uuid;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found';
  end if;
  if o.status <> 'open' then
    raise exception 'order_not_open';
  end if;
  if p_table_id is not distinct from o.table_id then
    return o;
  end if;

  if p_table_id is not null then
    select label into v_to from public.tables where id = p_table_id for update;
    if not found then
      raise exception 'table_not_found';
    end if;
    if exists (select 1 from public.orders where table_id = p_table_id and status = 'open') then
      raise exception 'table_occupied';
    end if;
  end if;
  v_from_id := o.table_id;
  select label into v_from from public.tables where id = v_from_id;

  update public.orders set
    table_id   = p_table_id,
    order_type = case when p_table_id is null then 'takeaway' else 'dine_in' end
  where id = p_order_id
  returning * into o;

  insert into public.table_moves (order_id, from_table_id, to_table_id, from_label, to_label, moved_by_name)
  values (p_order_id, v_from_id, p_table_id, v_from, v_to, nullif(trim(p_user_name), ''));

  return o;
end $$;

-- Facture: enregistre le client (facultatif) et donne un numéro de facture la première fois.
create or replace function public.issue_invoice(p_order_id uuid, p_name text default null, p_address text default null)
returns public.orders
language plpgsql set search_path = public as $$
declare
  o public.orders;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found';
  end if;
  if o.status = 'cancelled' then
    raise exception 'order_not_open';
  end if;
  if not exists (select 1 from public.order_items where order_id = p_order_id) then
    raise exception 'order_empty';
  end if;

  update public.orders set
    customer_name    = nullif(trim(p_name), ''),
    customer_address = nullif(trim(p_address), ''),
    invoice_no       = coalesce(invoice_no, nextval('public.invoice_no_seq'))
  where id = p_order_id
  returning * into o;
  return o;
end $$;

grant execute on function public.move_order(uuid, uuid, text) to authenticated;
grant execute on function public.issue_invoice(uuid, text, text) to authenticated;

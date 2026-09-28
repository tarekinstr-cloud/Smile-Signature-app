-- Smile Signature: une commande ouverte sur une table garde sa table.
-- Elle ne peut la quitter que par « Changement de Table » (vers une autre table), le paiement ou l'annulation.
-- Idempotent: peut être exécuté plusieurs fois. Nécessite 20260928020000_order_actions.sql.

-- Garde-fou: une commande ouverte liée à une table ne peut pas perdre son table_id
-- (ni par un update, ni par un passage « à emporter », ni par la suppression de la table ou de la salle).
-- Nommé « zz » pour passer après les autres triggers BEFORE (orders_takeaway_no met table_id à null).
create or replace function public.orders_keep_table() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.status = 'open' and new.status = 'open' and old.table_id is not null and new.table_id is null then
    raise exception 'table_link_required';
  end if;
  return new;
end $$;

drop trigger if exists orders_zz_keep_table on public.orders;
create trigger orders_zz_keep_table
  before update on public.orders
  for each row execute function public.orders_keep_table();

-- Changement de Table: seulement vers une autre table (plus de passage « à emporter »).
create or replace function public.move_order(p_order_id uuid, p_table_id uuid, p_user_name text default null)
returns public.orders
language plpgsql set search_path = public as $$
declare
  o         public.orders;
  v_from    text;
  v_to      text;
  v_from_id uuid;
begin
  if p_table_id is null then
    raise exception 'table_link_required';
  end if;
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

  select label into v_to from public.tables where id = p_table_id for update;
  if not found then
    raise exception 'table_not_found';
  end if;
  if exists (select 1 from public.orders where table_id = p_table_id and status = 'open') then
    raise exception 'table_occupied';
  end if;
  v_from_id := o.table_id;
  select label into v_from from public.tables where id = v_from_id;

  update public.orders set table_id = p_table_id, order_type = 'dine_in'
  where id = p_order_id
  returning * into o;

  insert into public.table_moves (order_id, from_table_id, to_table_id, from_label, to_label, moved_by_name)
  values (p_order_id, v_from_id, p_table_id, v_from, v_to, nullif(trim(p_user_name), ''));

  return o;
end $$;

grant execute on function public.move_order(uuid, uuid, text) to authenticated;

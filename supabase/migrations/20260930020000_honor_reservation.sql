-- Smile Signature: « Honorée » ouvre une vraie commande sur la table de la réservation
-- Idempotent: peut être exécuté plusieurs fois sans problème.
-- À exécuter après 20260930010000_reservations.sql.
--
-- La réservation garde le lien vers sa commande (order_id). La commande est créée tout de suite, donc la table passe
-- occupée (trigger orders_sync_table_status) avant même le premier article : le client est installé.

alter table public.reservations add column if not exists order_id uuid references public.orders (id) on delete set null;
create index if not exists reservations_order_id_idx on public.reservations (order_id);

-- En une seule transaction : vérifie la permission et que la table est libre, ouvre la commande, marque la réservation.
create or replace function public.honor_reservation(p_reservation_id uuid, p_table_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_hall uuid;
  v_order uuid;
begin
  if not public.permission_ok('reservations') then
    raise exception 'permission_denied:reservations';
  end if;
  select hall_id into v_hall from public.tables where id = p_table_id;
  if v_hall is null then
    raise exception 'table_not_found';
  end if;
  perform 1 from public.reservations where id = p_reservation_id and status = 'confirmed' for update;
  if not found then
    raise exception 'reservation_not_confirmed';
  end if;
  if exists (select 1 from public.orders where table_id = p_table_id and status = 'open') then
    raise exception 'table_has_order';
  end if;
  insert into public.orders (table_id) values (p_table_id) returning id into v_order;
  update public.reservations
     set status = 'honored', hall_id = v_hall, table_id = p_table_id, order_id = v_order
   where id = p_reservation_id;
  return v_order;
end $$;
revoke all on function public.honor_reservation(uuid, uuid) from public, anon;
grant execute on function public.honor_reservation(uuid, uuid) to authenticated;

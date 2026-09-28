-- Smile Signature: commandes « Livraison », troisième type de commande (en plus de « sur table » et « à emporter »).
-- Une livraison n'a pas de table; elle a un numéro court (« Livraison n° 3 »), un client (nom, téléphone, adresse)
-- et un statut: En préparation → En route → Livrée.
-- Le nom et l'adresse réutilisent customer_name / customer_address (déjà imprimés sur la facture).
-- Idempotent: peut être exécuté plusieurs fois. Nécessite 20260928020000_order_actions.sql.

alter table public.orders
  add column if not exists delivery_no      integer,
  add column if not exists customer_phone   text,
  add column if not exists delivery_status  text;

-- order_type: 'dine_in', 'takeaway' ou 'delivery'.
alter table public.orders drop constraint if exists orders_order_type_check;
alter table public.orders add constraint orders_order_type_check check (order_type in ('dine_in', 'takeaway', 'delivery'));

alter table public.orders drop constraint if exists orders_delivery_status_check;
alter table public.orders add constraint orders_delivery_status_check
  check (delivery_status is null or delivery_status in ('preparing', 'on_the_way', 'delivered'));

create index if not exists orders_open_delivery_idx on public.orders (created_at) where status = 'open' and order_type = 'delivery';

create sequence if not exists public.delivery_no_seq;

-- À emporter et livraison: pas de table, et un numéro court pour chacun.
-- Une livraison commence « En préparation ».
create or replace function public.orders_takeaway_no() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.order_type = 'takeaway' then
    new.table_id := null;
    if new.takeaway_no is null then
      new.takeaway_no := nextval('public.takeaway_no_seq');
    end if;
  elsif new.order_type = 'delivery' then
    new.table_id := null;
    if new.delivery_no is null then
      new.delivery_no := nextval('public.delivery_no_seq');
    end if;
    if new.delivery_status is null then
      new.delivery_status := 'preparing';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists orders_takeaway_no on public.orders;
create trigger orders_takeaway_no
  before insert or update of order_type, table_id on public.orders
  for each row execute function public.orders_takeaway_no();

comment on column public.orders.customer_phone is 'Téléphone du client (livraison).';
comment on column public.orders.delivery_status is 'Livraison: preparing (En préparation), on_the_way (En route), delivered (Livrée); null pour les autres types.';

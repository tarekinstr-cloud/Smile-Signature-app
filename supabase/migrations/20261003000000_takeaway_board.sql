-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- À emporter et Livraison en cartes (à exécuter après 20261002000000_floor_visual.sql).
-- À exécuter à la main dans Supabase > SQL Editor.
--
-- • Numérotation par journée de travail : les n° À emporter et Livraison repartent à 1 à chaque journée (depuis la
--   clôture précédente, ou le dernier « Re-Initialiser le N° » manuel : même période que les tickets de caisse,
--   ticket_period_start()). Le n° est donné par la base sous verrou (pg_advisory_xact_lock) : deux appareils qui
--   créent une commande en même temps reçoivent deux numéros qui se suivent, et un index unique refuse tout doublon.
--   Le n° de ticket de caisse reste indépendant.
-- • Statut À emporter (orders.pickup_status) : preparing (En préparation) → ready (Prête) → handed (Remise au client).
--   Une commande payée mais pas encore remise reste dans la grille jusqu'à « Remise ».
-- • Les commandes déjà créées gardent leur numéro.
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

alter table public.orders add column if not exists number_period timestamptz;
comment on column public.orders.number_period is
  'Début de la période de numérotation (journée) du n° À emporter / Livraison ; (number_period, n°) est unique.';

alter table public.orders add column if not exists pickup_status text;
alter table public.orders drop constraint if exists orders_pickup_status_check;
alter table public.orders add constraint orders_pickup_status_check
  check (pickup_status is null or pickup_status in ('preparing', 'ready', 'handed'));
comment on column public.orders.pickup_status is 'À emporter : preparing (En préparation), ready (Prête), handed (Remise au client) ; null pour les autres types.';

create unique index if not exists orders_takeaway_no_per_period
  on public.orders (number_period, takeaway_no) where number_period is not null and takeaway_no is not null;
create unique index if not exists orders_delivery_no_per_period
  on public.orders (number_period, delivery_no) where number_period is not null and delivery_no is not null;
-- Grille À emporter : commandes payées pas encore remises.
create index if not exists orders_pickup_waiting on public.orders (closed_at)
  where order_type = 'takeaway' and pickup_status in ('preparing', 'ready');

-- Prochain n° À emporter / Livraison de la période (anciennes commandes sans période : créées depuis son début).
create or replace function public.next_order_number(p_type text, p_start timestamptz)
returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(max(case when p_type = 'takeaway' then takeaway_no else delivery_no end), 0)::int + 1
    from public.orders
   where order_type = p_type
     and (case when p_type = 'takeaway' then takeaway_no else delivery_no end) is not null
     and (number_period = p_start or (number_period is null and created_at >= p_start))
$$;
revoke all on function public.next_order_number(text, timestamptz) from public, anon, authenticated;

-- À emporter et livraison : pas de table, et un numéro court par journée.
create or replace function public.orders_takeaway_no() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_start timestamptz;
begin
  if new.order_type = 'takeaway' then
    new.table_id := null;
    if new.pickup_status is null then
      new.pickup_status := 'preparing';
    end if;
    if new.takeaway_no is null then
      perform pg_advisory_xact_lock(hashtext('smile.takeaway_no'));
      v_start := public.ticket_period_start();
      new.takeaway_no := public.next_order_number('takeaway', v_start);
      new.number_period := v_start;
    end if;
  elsif new.order_type = 'delivery' then
    new.table_id := null;
    if new.delivery_no is null then
      perform pg_advisory_xact_lock(hashtext('smile.delivery_no'));
      v_start := public.ticket_period_start();
      new.delivery_no := public.next_order_number('delivery', v_start);
      new.number_period := v_start;
    end if;
    if new.delivery_status is null then
      new.delivery_status := 'preparing';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.orders_takeaway_no() from public, anon, authenticated;

drop trigger if exists orders_takeaway_no on public.orders;
create trigger orders_takeaway_no
  before insert or update of order_type, table_id on public.orders
  for each row execute function public.orders_takeaway_no();

-- Un n° déjà donné ne change plus (ni par l'écran, ni par une autre fonction).
create or replace function public.orders_keep_number() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.takeaway_no is not null then new.takeaway_no := old.takeaway_no; end if;
  if old.delivery_no is not null then new.delivery_no := old.delivery_no; end if;
  if old.number_period is not null then new.number_period := old.number_period; end if;
  return new;
end $$;
revoke all on function public.orders_keep_number() from public, anon, authenticated;

drop trigger if exists orders_keep_number on public.orders;
create trigger orders_keep_number
  before update of takeaway_no, delivery_no, number_period on public.orders
  for each row execute function public.orders_keep_number();

notify pgrst, 'reload schema';

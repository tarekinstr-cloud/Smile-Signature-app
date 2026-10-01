-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- N° de ticket unique et séquentiel dans une journée de travail (à exécuter après 20260930160000_salary_prorata.sql).
--
-- Problème : open_cash_day remettait les numéros à 1. Une vente encaissée caisse fermée juste avant l'ouverture
-- (rattachée à la journée, qui compte les ventes depuis la clôture précédente) gardait son « Ticket N° 1 », et la
-- première vente après l'ouverture recevait aussi le n° 1.
--
-- • Période de numérotation : depuis la clôture précédente (= period_start de la journée ouverte, ou la dernière
--   clôture tant qu'aucune journée n'est ouverte), ou depuis le dernier « Re-Initialiser le N° » manuel s'il est plus
--   récent. Les ventes encaissées caisse fermée sont donc numérotées avec la journée à laquelle elles sont rattachées.
-- • Le n° est attribué par la base (trigger) au passage à « payée » : plus grand n° de la période + 1, sous un verrou
--   (pg_advisory_xact_lock) : deux appareils qui encaissent en même temps reçoivent deux numéros qui se suivent.
-- • Index unique (période, n°) : un doublon est refusé par la base, quel que soit le chemin d'écriture.
-- • Un ticket payé garde son n° (annulation de facture comprise).
-- • open_cash_day ne remet plus à 1 les numéros déjà donnés dans la journée (tickets, à emporter, livraisons) :
--   ils continuent après la plus grande valeur depuis la clôture précédente.
-- • Les tickets déjà émis ne sont pas renumérotés (ils ont pu être imprimés).
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

alter table public.orders add column if not exists ticket_period timestamptz;
comment on column public.orders.ticket_period is
  'Début de la période de numérotation du ticket (clôture précédente ou remise à 1 manuelle) ; (ticket_period, ticket_no) est unique.';

create unique index if not exists orders_ticket_no_per_period
  on public.orders (ticket_period, ticket_no) where ticket_period is not null and ticket_no is not null;

-- Début de la période de numérotation en cours.
create or replace function public.ticket_period_start()
returns timestamptz
language sql stable security definer set search_path = public as $$
  select greatest(
    coalesce((select period_start from public.cash_days where closed_at is null limit 1),
             (select max(closed_at) from public.cash_days),
             '-infinity'::timestamptz),
    coalesce((select max(created_at) from public.order_number_resets where reason = 'manual'), '-infinity'::timestamptz))
$$;
revoke all on function public.ticket_period_start() from public, anon, authenticated;

-- Plus grand n° de ticket de la période (tickets d'avant cette migration : payés depuis le début de la période).
create or replace function public.max_ticket_no(p_start timestamptz, p_except uuid default null)
returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(max(ticket_no), 0) from public.orders
   where ticket_no is not null
     and (p_except is null or id <> p_except)
     and (ticket_period = p_start or (ticket_period is null and closed_at >= p_start))
$$;
revoke all on function public.max_ticket_no(timestamptz, uuid) from public, anon, authenticated;

create or replace function public.orders_ticket_no() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_start timestamptz;
  v_no bigint;
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
    -- Un seul encaissement à la fois choisit son n° ; le suivant attend la fin de la transaction et voit ce n°.
    perform pg_advisory_xact_lock(hashtext('smile.ticket_no'));
    v_start := public.ticket_period_start();
    v_no := public.max_ticket_no(v_start, new.id) + 1;
    new.ticket_no := v_no;
    new.ticket_period := v_start;
    -- Garde la séquence à jour pour l'historique des remises à 1 (order_number_resets.last_ticket_no).
    perform setval('public.ticket_no_seq', v_no, true);
  elsif old.status = 'paid' then
    -- Le n° d'un ticket encaissé ne change plus.
    new.ticket_no := old.ticket_no;
    new.ticket_period := old.ticket_period;
  end if;
  return new;
end $$;
revoke all on function public.orders_ticket_no() from public, anon, authenticated;

drop trigger if exists orders_ticket_no on public.orders;
create trigger orders_ticket_no
  before update on public.orders
  for each row execute function public.orders_ticket_no();

-- ───────────── Ouverture : les numéros continuent dans la journée ─────────────

create or replace function public.open_cash_day(p_float numeric)
returns public.cash_days
language plpgsql security definer set search_path = public as $$
declare
  v_day public.cash_days;
  v_float numeric := round(coalesce(p_float, -1), 2);
  v_takeaway bigint;
  v_delivery bigint;
  v_ticket bigint;
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
  -- Numérotation par journée de travail : remise à 1 (historique gardé)…
  perform public.do_reset_order_numbers('day_open');
  -- … sauf pour les numéros déjà donnés depuis la clôture précédente (commandes prises ou encaissées caisse fermée).
  select max(takeaway_no), max(delivery_no) into v_takeaway, v_delivery
    from public.orders where created_at >= v_day.period_start;
  if v_takeaway > 0 then
    perform setval('public.takeaway_no_seq', v_takeaway, true);
  end if;
  if v_delivery > 0 then
    perform setval('public.delivery_no_seq', v_delivery, true);
  end if;
  v_ticket := public.max_ticket_no(public.ticket_period_start());
  if v_ticket > 0 then
    perform setval('public.ticket_no_seq', v_ticket, true);
  end if;
  return v_day;
end $$;
revoke all on function public.open_cash_day(numeric) from public, anon;
grant execute on function public.open_cash_day(numeric) to authenticated;

notify pgrst, 'reload schema';

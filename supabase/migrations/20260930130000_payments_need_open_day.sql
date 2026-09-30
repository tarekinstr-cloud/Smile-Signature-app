-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Encaissement seulement caisse ouverte (à exécuter après 20260930110000_cash_register.sql).
--
-- • Un paiement (table payments) ou une commande passée à « payée » (commande entièrement offerte, sans paiement)
--   est refusé s'il n'y a pas de journée de caisse ouverte : erreur « no_open_day ».
-- • Verrou partagé sur la journée ouverte : si un appareil clôture pendant qu'un autre encaisse, soit le paiement
--   passe avant la clôture (et compte dans ses espèces attendues), soit il attend la fin de la clôture puis il est refusé.
-- • cash_day_is_open() : lisible par tous les comptes (les employés ne voient pas cash_days).
-- • Ventes déjà encaissées caisse fermée : rien à déplacer. Une journée compte les ventes depuis la clôture
--   précédente (period_start), donc elles tombent dans la prochaine journée ouverte ; le rapport les signale
--   (payées avant opened_at).
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.cash_day_is_open()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.cash_days where closed_at is null)
$$;
revoke all on function public.cash_day_is_open() from public, anon;
grant execute on function public.cash_day_is_open() to authenticated;

create or replace function public.require_open_cash_day()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- FOR SHARE : close_cash_day (FOR UPDATE) attend la fin de ce paiement ; un paiement arrivé pendant la
  -- clôture attend, puis ne trouve plus de journée ouverte.
  perform 1 from public.cash_days where closed_at is null for share;
  if not found then
    raise exception 'no_open_day' using hint = 'Ouvrez la caisse (fond de caisse) avant d''encaisser.';
  end if;
  return new;
end $$;
revoke all on function public.require_open_cash_day() from public, anon, authenticated;

drop trigger if exists payments_require_open_day on public.payments;
create trigger payments_require_open_day
  before insert on public.payments
  for each row execute function public.require_open_cash_day();

drop trigger if exists orders_paid_require_open_day on public.orders;
create trigger orders_paid_require_open_day
  before update of status on public.orders
  for each row when (new.status = 'paid' and old.status is distinct from 'paid')
  execute function public.require_open_cash_day();

notify pgrst, 'reload schema';

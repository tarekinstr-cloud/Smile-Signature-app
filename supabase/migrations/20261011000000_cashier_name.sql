-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Caissier toujours enregistré (à exécuter après 20261010000000_dashboard.sql).
-- À exécuter à la main dans Supabase > SQL Editor.
--
-- • cashier_name() : nom de l'employé connecté, jamais vide — nom affiché ou nom d'utilisateur (app_users), sinon le
--   nom ou l'adresse du compte Supabase (compte sans profil), sinon « Non enregistré ».
-- • payments.created_by (compte) et payments.created_by_name (nom) : écrits par la base à chaque encaissement
--   (paiement total, partiel, compte client) ; la colonne n'est jamais vide.
-- • orders.closed_by_name : l'employé qui a clôturé la commande (dernier encaissement, ou commande entièrement offerte
--   clôturée sans paiement).
-- • Règlements crédit (customer_settlements.user_name) et mouvements de caisse (cash_movements.user_name, dont le fond
--   d'entrée « Règlement crédit client ») : même nom, jamais vide.
-- • Les encaissements faits avant ce script gardent un caissier vide : l'app affiche « Non enregistré ».
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.cashier_name()
returns text
language sql stable security definer set search_path = public, auth as $$
  select left(coalesce(
    nullif(public.current_user_name(), ''),
    (select nullif(trim(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', u.email, '')), '')
       from auth.users u where u.id = auth.uid()),
    'Non enregistré'), 80)
$$;
revoke all on function public.cashier_name() from public, anon;
grant execute on function public.cashier_name() to authenticated;

-- ───────────── Paiements ─────────────

alter table public.payments add column if not exists created_by_name text not null default '';
alter table public.payments add column if not exists created_by uuid references auth.users (id) on delete set null;

create or replace function public.payments_cashier() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.created_by_name := public.cashier_name();
  return new;
end $$;
revoke all on function public.payments_cashier() from public, anon, authenticated;
drop trigger if exists payments_cashier on public.payments;
create trigger payments_cashier before insert on public.payments
  for each row execute function public.payments_cashier();

-- ───────────── Commande clôturée par ─────────────

alter table public.orders add column if not exists closed_by_name text;

create or replace function public.orders_closed_by() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
    new.closed_by_name := public.cashier_name();
  end if;
  return new;
end $$;
revoke all on function public.orders_closed_by() from public, anon, authenticated;
drop trigger if exists orders_closed_by on public.orders;
create trigger orders_closed_by
  before update of status on public.orders
  for each row execute function public.orders_closed_by();

-- ───────────── Règlements crédit et mouvements de caisse ─────────────

create or replace function public.fill_user_name() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(trim(new.user_name), '') = '' then
    new.user_name := public.cashier_name();
  end if;
  return new;
end $$;
revoke all on function public.fill_user_name() from public, anon, authenticated;

drop trigger if exists customer_settlements_user_name on public.customer_settlements;
create trigger customer_settlements_user_name before insert on public.customer_settlements
  for each row execute function public.fill_user_name();
drop trigger if exists cash_movements_user_name on public.cash_movements;
create trigger cash_movements_user_name before insert on public.cash_movements
  for each row execute function public.fill_user_name();

notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Tableau de bord : caissier des paiements, vidange de caisse, TVA, seuil d'alerte des annulations
-- (à exécuter après 20261009000000_customers_credit.sql).
-- À exécuter à la main dans Supabase > SQL Editor.
--
-- • payments.created_by_name : l'employé qui a encaissé (« Encaissée par », Rapport Caissier), écrit par la base.
-- • Vidange (coffre) : cash_movements.is_drop. Un Fond de sortie « Vidange » sort l'argent du tiroir (espèces
--   attendues) mais n'est pas une dépense : jamais lié à une catégorie de dépense ni à une facture, donc ni dans
--   Dépenses ni dans le Bénéfice. add_cash_movement() prend p_is_drop (false par défaut).
-- • TVA (facultative, désactivée par défaut) : receipt_settings.tva_enabled / tva_rate. Les prix sont TTC ; le ticket et
--   le tableau de bord affichent HT, TVA et TTC quand elle est activée.
-- • app_config.cancel_alert_amount : montant des annulations de la période au-delà duquel la tuile « Annulations »
--   du tableau de bord passe en alerte (null : pas d'alerte).
-- • Annulation : refusée sans employé connecté (en plus du motif déjà obligatoire).
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- ───────────── Caissier des paiements ─────────────

alter table public.payments add column if not exists created_by_name text not null default '';

create or replace function public.payments_cashier() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_by_name := left(coalesce(nullif(public.current_user_name(), ''), new.created_by_name, ''), 80);
  return new;
end $$;
revoke all on function public.payments_cashier() from public, anon, authenticated;
drop trigger if exists payments_cashier on public.payments;
create trigger payments_cashier before insert on public.payments
  for each row execute function public.payments_cashier();

-- ───────────── Vidange de caisse ─────────────

alter table public.cash_movements add column if not exists is_drop boolean not null default false;
alter table public.cash_movements drop constraint if exists cash_movements_drop_check;
alter table public.cash_movements add constraint cash_movements_drop_check
  check (not is_drop or (kind = 'out' and supplier_invoice_id is null));

drop function if exists public.add_cash_movement(text, numeric, text, uuid, uuid);
create or replace function public.add_cash_movement(p_kind text, p_amount numeric, p_reason text,
  p_supplier_invoice_id uuid default null, p_expense_category_id uuid default null, p_is_drop boolean default false)
returns public.cash_movements
language plpgsql security definer set search_path = public as $$
declare
  v_day public.cash_days;
  v_row public.cash_movements;
  v_amount numeric := round(coalesce(p_amount, 0), 2);
  v_supplier text;
  v_category public.expense_categories;
  v_drop boolean := coalesce(p_is_drop, false);
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
  -- Une vidange n'est ni une dépense ni le règlement d'une facture.
  if v_drop and (p_kind <> 'out' or p_supplier_invoice_id is not null or p_expense_category_id is not null) then
    raise exception 'drop_not_expense';
  end if;
  if p_expense_category_id is not null then
    select * into v_category from public.expense_categories where id = p_expense_category_id;
    if not found then
      raise exception 'category_not_found';
    end if;
  end if;
  -- Verrou sur la journée : une clôture ou une autre sortie en cours attend.
  select * into v_day from public.cash_days where closed_at is null for update;
  if not found then
    raise exception 'no_open_day';
  end if;
  if p_kind = 'out' then
    perform public.require_cash(v_day.id, v_amount);
  end if;
  if p_supplier_invoice_id is not null then
    perform public.pay_supplier_invoice(p_supplier_invoice_id, v_amount, public.local_today());
    select supplier_name into v_supplier from public.supplier_invoices where id = p_supplier_invoice_id;
  end if;
  insert into public.cash_movements (day_id, kind, amount, reason, supplier_invoice_id, supplier_name, user_name, is_drop)
  values (v_day.id, p_kind, v_amount, left(trim(coalesce(nullif(trim(p_reason), ''), case when v_drop then 'Vidange (coffre)' else '' end)), 300),
          p_supplier_invoice_id, v_supplier, public.current_user_name(), v_drop)
  returning * into v_row;
  if p_expense_category_id is not null then
    insert into public.expenses (category_id, category_name, amount, date, mode, note, cash_movement_id, user_name)
    values (v_category.id, v_category.name, v_amount, public.local_today(), 'cash', v_row.reason, v_row.id, v_row.user_name);
  end if;
  return v_row;
end $$;
revoke all on function public.add_cash_movement(text, numeric, text, uuid, uuid, boolean) from public, anon;
grant execute on function public.add_cash_movement(text, numeric, text, uuid, uuid, boolean) to authenticated;

-- ───────────── TVA (facultative) ─────────────

alter table public.receipt_settings add column if not exists tva_enabled boolean not null default false;
alter table public.receipt_settings add column if not exists tva_rate numeric(5,2) not null default 19;
alter table public.receipt_settings drop constraint if exists receipt_settings_tva_check;
alter table public.receipt_settings add constraint receipt_settings_tva_check check (tva_rate >= 0 and tva_rate <= 100);

-- ───────────── Seuil d'alerte des annulations ─────────────

alter table public.app_config add column if not exists cancel_alert_amount int;
alter table public.app_config drop constraint if exists app_config_cancel_alert_check;
alter table public.app_config add constraint app_config_cancel_alert_check check (cancel_alert_amount is null or cancel_alert_amount >= 0);

-- ───────────── Annulation : employé connecté obligatoire ─────────────

create or replace function public.orders_cancel_needs_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled'
     and exists (select 1 from public.order_items i where i.order_id = new.id)
     and (auth.uid() is null or coalesce(public.current_user_name(), '') = '') then
    raise exception 'cancel_needs_user';
  end if;
  return new;
end $$;
revoke all on function public.orders_cancel_needs_user() from public, anon, authenticated;
drop trigger if exists orders_cancel_needs_user on public.orders;
create trigger orders_cancel_needs_user
  before update of status on public.orders
  for each row execute function public.orders_cancel_needs_user();

notify pgrst, 'reload schema';

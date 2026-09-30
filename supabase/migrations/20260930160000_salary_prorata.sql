-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Bénéfice : prorata des salaires sur les jours écoulés (à exécuter après 20260930120000_expenses_profit.sql).
--
-- • Les salaires d'une période sont comptés jour par jour (salaire mensuel / nombre de jours du mois) jusqu'à
--   aujourd'hui inclus (heure d'Alger) : le 1er octobre, « Ce mois » compte 1/31 du salaire mensuel.
-- • Une période entièrement passée (Mois dernier, Personnalisé) compte tous ses jours, comme avant.
-- • Nouveaux champs renvoyés : salary_days (jours comptés) et period_days (jours de la période).
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- p_from / p_to : instants (charges cuisine, inventaires) ; p_first / p_last : jours inclus (salaires, dépenses).
create or replace function public.profit_summary(p_from timestamptz, p_to timestamptz, p_first date, p_last date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_result jsonb;
  -- Salaires : seulement les jours écoulés (jusqu'à aujourd'hui inclus) ; une période passée compte tous ses jours.
  v_last date := least(p_last, public.local_today());
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
                  from public.app_users a cross join generate_series(p_first, v_last, interval '1 day') d
                 where a.active and a.monthly_salary > 0),
    'salary_days', greatest(v_last - p_first + 1, 0),
    'period_days', p_last - p_first + 1,
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

notify pgrst, 'reload schema';

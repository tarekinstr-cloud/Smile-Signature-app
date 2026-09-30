-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- La caisse ne peut pas devenir négative (à exécuter après 20260930120000_expenses_profit.sql).
--
-- • Toute sortie d'espèces est refusée si elle dépasse les espèces attendues du moment
--   (fond de caisse + ventes en espèces + fonds d'entrée − fonds de sortie) : erreur « insufficient_cash:<disponible> ».
--   Concerne : Fond de sortie (y compris règlement fournisseur), dépense « Espèces caisse » (création, montant augmenté,
--   passage de « Autre » à « Espèces caisse »), suppression d'un Fond d'entrée, baisse du fond de caisse.
-- • Vérifié sous verrou sur la journée ouverte (FOR UPDATE) : deux sorties simultanées depuis deux appareils passent
--   l'une après l'autre, la seconde voit la première.
-- • Une dépense peut maintenant changer de mode pendant sa journée : « Espèces caisse » → « Autre » supprime son
--   Fond de sortie, « Autre » → « Espèces caisse » en crée un (si les espèces suffisent).
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- Espèces attendues maintenant dans le tiroir d'une journée.
create or replace function public.cash_available(p_day_id uuid)
returns numeric
language sql stable security definer set search_path = public as $$
  select round(d.opening_float + t.cash_sales + t.cash_in - t.cash_out, 2)
    from public.cash_days d, public.cash_day_totals(d.id, now()) t
   where d.id = p_day_id
$$;
revoke all on function public.cash_available(uuid) from public, anon, authenticated;

-- À appeler avec la journée déjà verrouillée (FOR UPDATE).
create or replace function public.require_cash(p_day_id uuid, p_amount numeric)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_available numeric := coalesce(public.cash_available(p_day_id), 0);
begin
  if p_amount > v_available then
    raise exception 'insufficient_cash:%', v_available
      using hint = 'Choisissez le mode Autre (banque, chèque...) si la dépense n''est pas payée depuis le tiroir.';
  end if;
end $$;
revoke all on function public.require_cash(uuid, numeric) from public, anon, authenticated;

-- ───────────── Fond de sortie ─────────────

create or replace function public.add_cash_movement(p_kind text, p_amount numeric, p_reason text,
  p_supplier_invoice_id uuid default null, p_expense_category_id uuid default null)
returns public.cash_movements
language plpgsql security definer set search_path = public as $$
declare
  v_day public.cash_days;
  v_row public.cash_movements;
  v_amount numeric := round(coalesce(p_amount, 0), 2);
  v_supplier text;
  v_category public.expense_categories;
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
  insert into public.cash_movements (day_id, kind, amount, reason, supplier_invoice_id, supplier_name, user_name)
  values (v_day.id, p_kind, v_amount, left(trim(coalesce(p_reason, '')), 300), p_supplier_invoice_id, v_supplier, public.current_user_name())
  returning * into v_row;
  if p_expense_category_id is not null then
    insert into public.expenses (category_id, category_name, amount, date, mode, note, cash_movement_id, user_name)
    values (v_category.id, v_category.name, v_amount, public.local_today(), 'cash', v_row.reason, v_row.id, v_row.user_name);
  end if;
  return v_row;
end $$;
revoke all on function public.add_cash_movement(text, numeric, text, uuid, uuid) from public, anon;
grant execute on function public.add_cash_movement(text, numeric, text, uuid, uuid) to authenticated;

-- Supprimer un Fond d'entrée retire des espèces : même contrôle.
create or replace function public.delete_cash_movement(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_row public.cash_movements;
begin
  select m.* into v_row from public.cash_movements m where m.id = p_id;
  if not found then
    raise exception 'movement_not_found';
  end if;
  if not public.has_permission(case v_row.kind when 'in' then 'cash_in' else 'cash_out' end) then
    raise exception 'no_permission';
  end if;
  perform 1 from public.cash_days where id = v_row.day_id and closed_at is null for update;
  if not found then
    raise exception 'day_closed';
  end if;
  if v_row.supplier_invoice_id is not null then
    raise exception 'movement_has_invoice';
  end if;
  if v_row.kind = 'in' then
    perform public.require_cash(v_row.day_id, v_row.amount);
  end if;
  delete from public.cash_movements where id = p_id;
end $$;
revoke all on function public.delete_cash_movement(uuid) from public, anon;
grant execute on function public.delete_cash_movement(uuid) to authenticated;

-- Baisser le fond de caisse retire des espèces : même contrôle.
create or replace function public.set_opening_float(p_float numeric)
returns public.cash_days
language plpgsql security definer set search_path = public as $$
declare
  v_day public.cash_days;
  v_float numeric := round(coalesce(p_float, -1), 2);
begin
  if not public.has_permission('cash_open') then
    raise exception 'no_permission';
  end if;
  if v_float < 0 or v_float > 1e9 then
    raise exception 'bad_amount';
  end if;
  select * into v_day from public.cash_days where closed_at is null for update;
  if not found then
    raise exception 'no_open_day';
  end if;
  if v_float < v_day.opening_float then
    perform public.require_cash(v_day.id, v_day.opening_float - v_float);
  end if;
  update public.cash_days
     set opening_float = v_float, float_updated_at = now(), float_updated_by_name = public.current_user_name()
   where id = v_day.id
  returning * into v_day;
  return v_day;
end $$;
revoke all on function public.set_opening_float(numeric) from public, anon;
grant execute on function public.set_opening_float(numeric) to authenticated;

-- ───────────── Dépenses ─────────────

-- Crée ou modifie une dépense. « Espèces caisse » : une sortie de la journée ouverte est créée (ou suit le montant),
-- jamais au-delà des espèces attendues. Le mode peut changer tant que la sortie est dans la journée ouverte.
create or replace function public.save_expense(p_id uuid, p_category_id uuid, p_amount numeric, p_date date, p_mode text, p_note text)
returns public.expenses
language plpgsql security definer set search_path = public as $$
declare
  v_row public.expenses;
  v_old public.expenses;
  v_category public.expense_categories;
  v_day public.cash_days;
  v_move public.cash_movements;
  v_move_id uuid;
  v_amount numeric := round(coalesce(p_amount, 0), 2);
  v_note text := left(trim(coalesce(p_note, '')), 300);
begin
  if not public.has_permission('expenses') then
    raise exception 'no_permission';
  end if;
  if v_amount <= 0 or v_amount > 1e9 then
    raise exception 'bad_amount';
  end if;
  if p_mode not in ('cash', 'other') or p_date is null then
    raise exception 'bad_expense';
  end if;
  select * into v_category from public.expense_categories where id = p_category_id;
  if not found then
    raise exception 'category_not_found';
  end if;

  if p_id is null then
    if p_mode = 'cash' then
      select * into v_day from public.cash_days where closed_at is null for update;
      if not found then
        raise exception 'no_open_day';
      end if;
      perform public.require_cash(v_day.id, v_amount);
      insert into public.cash_movements (day_id, kind, amount, reason, user_name)
      values (v_day.id, 'out', v_amount, coalesce(nullif(v_note, ''), v_category.name), public.current_user_name())
      returning * into v_move;
    end if;
    insert into public.expenses (category_id, category_name, amount, date, mode, note, cash_movement_id, user_name)
    values (v_category.id, v_category.name, v_amount, case when p_mode = 'cash' then public.local_today() else p_date end,
            p_mode, v_note, v_move.id, public.current_user_name())
    returning * into v_row;
    return v_row;
  end if;

  select * into v_old from public.expenses where id = p_id for update;
  if not found then
    raise exception 'expense_not_found';
  end if;
  v_move_id := v_old.cash_movement_id;

  if v_old.cash_movement_id is not null and (p_mode = 'other' or v_amount <> v_old.amount) then
    -- Sa sortie doit être dans la journée ouverte.
    select d.* into v_day from public.cash_days d join public.cash_movements m on m.day_id = d.id
     where m.id = v_old.cash_movement_id and d.closed_at is null for update of d;
    if not found then
      raise exception 'day_closed';
    end if;
    if p_mode = 'other' then
      -- Espèces caisse → Autre : la sortie est annulée (la dépense est détachée d'abord, sinon elle suivrait en cascade).
      update public.expenses set cash_movement_id = null where id = p_id;
      delete from public.cash_movements where id = v_old.cash_movement_id;
      v_move_id := null;
    else
      if v_amount > v_old.amount then
        perform public.require_cash(v_day.id, v_amount - v_old.amount);
      end if;
      update public.cash_movements set amount = v_amount where id = v_old.cash_movement_id;
    end if;
  elsif v_old.cash_movement_id is null and p_mode = 'cash' then
    -- Autre → Espèces caisse : une sortie est créée dans la journée ouverte.
    select * into v_day from public.cash_days where closed_at is null for update;
    if not found then
      raise exception 'no_open_day';
    end if;
    perform public.require_cash(v_day.id, v_amount);
    insert into public.cash_movements (day_id, kind, amount, reason, user_name)
    values (v_day.id, 'out', v_amount, coalesce(nullif(v_note, ''), v_category.name), public.current_user_name())
    returning id into v_move_id;
  end if;

  update public.expenses set
    category_id = v_category.id, category_name = v_category.name, amount = v_amount, mode = p_mode, note = v_note,
    cash_movement_id = v_move_id,
    date = case
      when v_move_id is null then p_date
      when v_old.cash_movement_id is null then public.local_today()
      else v_old.date end
  where id = p_id
  returning * into v_row;
  return v_row;
end $$;
revoke all on function public.save_expense(uuid, uuid, numeric, date, text, text) from public, anon;
grant execute on function public.save_expense(uuid, uuid, numeric, date, text, text) to authenticated;

notify pgrst, 'reload schema';

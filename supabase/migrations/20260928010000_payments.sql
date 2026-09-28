-- Smile Signature: شاشة الدفع (Paiement) — دفع جزئي، تخفيض (Remise)، مجاني (Offert)
-- يمكن تشغيله أكثر من مرة بدون مشكل. يلزم تكون 20260927020000_checkout.sql متشغّلة قبلو.

-- ───────────── التخفيض والمجاني: على الطلب كامل وعلى كل سطر ─────────────
-- discount_type: 'percent' (نسبة 0–100) أو 'amount' (مبلغ ثابت بالدينار)، null = بلا تخفيض
-- offered: مجاني (السعر 0 على التذكرة، لكن السطر يبقى بسعرو الأصلي في الإحصائيات)

alter table public.orders
  add column if not exists discount_type   text,
  add column if not exists discount_value  numeric(10,2) not null default 0,
  add column if not exists offered         boolean not null default false;

alter table public.order_items
  add column if not exists discount_type   text,
  add column if not exists discount_value  numeric(10,2) not null default 0,
  add column if not exists offered         boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_discount_check') then
    alter table public.orders add constraint orders_discount_check check (
      discount_value >= 0
      and (discount_type is null or discount_type in ('percent', 'amount'))
      and (discount_type is distinct from 'percent' or discount_value <= 100));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_items_discount_check') then
    alter table public.order_items add constraint order_items_discount_check check (
      discount_value >= 0
      and (discount_type is null or discount_type in ('percent', 'amount'))
      and (discount_type is distinct from 'percent' or discount_value <= 100));
  end if;
end $$;

-- ───────────── الدفعات (كل دفعة جزئية سطر) ─────────────
-- method نص عادي (cash، card…) باش نزيدو طرق دفع جديدة بلا ما نبدلو القاعدة

create table if not exists public.payments (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.orders(id) on delete cascade,
  method         text not null check (length(trim(method)) > 0),
  amount         numeric(10,2) not null check (amount > 0),      -- الجزء من المجموع اللي تخلّص
  received       numeric(10,2) not null check (received >= amount), -- واش عطى الزبون (نقدي)
  change_amount  numeric(10,2) not null default 0 check (change_amount >= 0), -- الباقي اللي ترجع
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid()
);
create index if not exists payments_order_id_idx on public.payments (order_id);

alter table public.payments enable row level security;
drop policy if exists "staff all payments" on public.payments;
create policy "staff all payments" on public.payments for all to authenticated using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'payments') then
    alter publication supabase_realtime add table public.payments;
  end if;
end $$;

-- ───────────── الحساب (نفس القواعد تاع src/lib/billing.ts) ─────────────

-- قيمة التخفيض بالدينار: النسبة تتقرّب للدينار، والمبلغ ما يفوتش القاعدة
create or replace function public.discount_amount(p_base numeric, p_type text, p_value numeric)
returns numeric
language sql immutable as $$
  select case
    when p_type is null or coalesce(p_value, 0) <= 0 or p_base <= 0 then 0::numeric
    else least(p_base, case p_type when 'percent' then round(p_base * least(p_value, 100) / 100) else p_value end)
  end
$$;

-- المجموع اللي يخلّصو الزبون: الأسطر بعد تخفيضها (المجانية = 0)، ثم تخفيض الطلب
create or replace function public.order_total(p_order_id uuid)
returns numeric
language sql stable set search_path = public as $$
  with o as (
    select * from public.orders where id = p_order_id
  ),
  l as (
    select case
      when i.offered or o.offered then 0
      else round(i.unit_price * i.quantity, 2) - public.discount_amount(round(i.unit_price * i.quantity, 2), i.discount_type, i.discount_value)
    end as net
    from public.order_items i join o on i.order_id = o.id
  ),
  s as (
    select coalesce(sum(net), 0) as sub from l
  )
  select case when o.offered then 0 else s.sub - public.discount_amount(s.sub, o.discount_type, o.discount_value) end
  from o, s
$$;

-- دفعة (كاملة أو جزئية). كي يولّي الباقي 0: الطلب "مدفوع"، رقم تذكرة، والطاولة تتحرر (التريغر).
-- p_amount = 0 مسموح غير إذا ما بقى والو (مثلاً الطلب كامل مجاني) باش نسكّرو الطلب.
create or replace function public.add_payment(p_order_id uuid, p_method text, p_amount numeric, p_received numeric default null)
returns public.orders
language plpgsql set search_path = public as $$
declare
  o public.orders;
  v_total     numeric(10,2);
  v_paid      numeric(10,2);
  v_remaining numeric(10,2);
  v_received  numeric(10,2);
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found';
  end if;
  if o.status <> 'open' then
    raise exception 'order_not_open';
  end if;
  if not exists (select 1 from public.order_items where order_id = p_order_id) then
    raise exception 'order_empty';
  end if;

  v_total := public.order_total(p_order_id);
  select coalesce(sum(amount), 0) into v_paid from public.payments where order_id = p_order_id;
  v_remaining := greatest(v_total - v_paid, 0);

  p_amount := coalesce(p_amount, 0);
  if p_amount < 0 or p_amount > v_remaining or (p_amount = 0 and v_remaining > 0) then
    raise exception 'amount_invalid';
  end if;

  if p_amount > 0 then
    v_received := case when p_method = 'cash' then coalesce(p_received, p_amount) else p_amount end;
    if v_received < p_amount then
      raise exception 'amount_too_low';
    end if;
    insert into public.payments (order_id, method, amount, received, change_amount)
    values (p_order_id, p_method, p_amount, v_received, v_received - p_amount);
    v_remaining := v_remaining - p_amount;
  end if;

  if v_remaining = 0 then
    update public.orders set
      status          = 'paid',
      total           = v_total,
      payment_method  = (select method::public.payment_method from public.payments
                         where order_id = p_order_id and method in ('cash', 'card') order by created_at desc limit 1),
      amount_received = (select coalesce(sum(received), 0) from public.payments where order_id = p_order_id),
      ticket_no       = nextval('public.ticket_no_seq')
    where id = p_order_id
    returning * into o;
  end if;
  return o;
end $$;

-- التحصيل القديم (مرة وحدة) يبقى يخدم: يخلّص الباقي كامل عبر add_payment
create or replace function public.checkout_order(p_order_id uuid, p_method public.payment_method, p_received numeric default null)
returns public.orders
language plpgsql set search_path = public as $$
declare
  v_remaining numeric(10,2);
begin
  perform 1 from public.orders where id = p_order_id for update;
  v_remaining := greatest(coalesce(public.order_total(p_order_id), 0)
    - (select coalesce(sum(amount), 0) from public.payments where order_id = p_order_id), 0);
  return public.add_payment(p_order_id, p_method::text, v_remaining, p_received);
end $$;

grant execute on function public.discount_amount(numeric, text, numeric) to authenticated;
grant execute on function public.order_total(uuid) to authenticated;
grant execute on function public.add_payment(uuid, text, numeric, numeric) to authenticated;
grant execute on function public.checkout_order(uuid, public.payment_method, numeric) to authenticated;

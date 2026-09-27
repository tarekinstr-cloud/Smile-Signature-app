-- Smile Signature: التحصيل (الكاسيير) والتذكرة (المرحلة 1، الجزء 3)
-- يمكن تنفيذ هذا الملف أكثر من مرة بدون أخطاء "already exists".

do $$
begin
  create type public.payment_method as enum ('cash', 'card');
exception
  when duplicate_object then null;
end $$;

create sequence if not exists public.ticket_no_seq;

alter table public.orders
  add column if not exists ticket_no        bigint,
  add column if not exists total            numeric(10,2),
  add column if not exists payment_method   public.payment_method,
  add column if not exists amount_received  numeric(10,2);

create unique index if not exists orders_ticket_no_key on public.orders (ticket_no);

-- تحصيل طلب مفتوح: يحسب المجموع من سطور الطلب، يعطي رقم تذكرة، ويغلق الطلب.
-- التريغر orders_sync_table_status يرجّع الطاولة "حرة" ويملأ closed_at.
create or replace function public.checkout_order(p_order_id uuid, p_method public.payment_method, p_received numeric default null)
returns public.orders
language plpgsql set search_path = public as $$
declare
  o public.orders;
  v_total numeric(10,2);
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

  select coalesce(sum(unit_price * quantity), 0) into v_total from public.order_items where order_id = p_order_id;
  if p_method = 'cash' and p_received is not null and p_received < v_total then
    raise exception 'amount_too_low';
  end if;

  update public.orders set
    status          = 'paid',
    total           = v_total,
    payment_method  = p_method,
    amount_received = case when p_method = 'cash' then coalesce(p_received, v_total) else v_total end,
    ticket_no       = nextval('public.ticket_no_seq')
  where id = p_order_id
  returning * into o;
  return o;
end $$;

grant execute on function public.checkout_order(uuid, public.payment_method, numeric) to authenticated;

-- نصوص التذكرة القابلة للتعديل (سطر واحد فقط)
create table if not exists public.receipt_settings (
  id      smallint primary key default 1 check (id = 1),
  name    text not null default 'Smile Signature',
  header  text not null default '',
  footer  text not null default 'Merci de votre visite — Bon Appétit !'
);
insert into public.receipt_settings (id) values (1) on conflict (id) do nothing;

alter table public.receipt_settings enable row level security;
drop policy if exists "staff all receipt_settings" on public.receipt_settings;
create policy "staff all receipt_settings" on public.receipt_settings for all to authenticated using (true) with check (true);

-- يخلي Supabase يشوف الدالة الجديدة مباشرة
notify pgrst, 'reload schema';

-- Smile Signature: تحضير الطلبات للمطبخ (الطابعات، ربط الفئات، Valider، تذاكر المطبخ)
-- يمكن تشغيله أكثر من مرة بدون مشكل.

-- ───────────── الطابعات ─────────────

create table if not exists public.printers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),   -- CUISINE، PIZZA، CAISSE…
  ip          text,                                           -- اختياري الآن، يلزم للطباعة الفعلية
  port        integer not null default 9100 check (port between 1 and 65535),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create unique index if not exists printers_name_key on public.printers (lower(trim(name)));

-- كل فئة تتربط بطابعة أو أكثر؛ المفتاح الأساسي يمنع نفس الطابعة مرتين لنفس الفئة
create table if not exists public.category_printers (
  category_id  uuid not null references public.categories(id) on delete cascade,
  printer_id   uuid not null references public.printers(id) on delete cascade,
  primary key (category_id, printer_id)
);
create index if not exists category_printers_printer_id_idx on public.category_printers (printer_id);

-- ───────────── Valider ─────────────

-- وقت إرسال السطر للمطبخ؛ null = سطر جديد ما تبعثش
alter table public.order_items add column if not exists sent_at timestamptz;

-- تذكرة لكل طابعة عند كل Valider. printed_at تبقى فارغة حتى تتطبع فعلياً (لاحقاً)
create table if not exists public.kitchen_tickets (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  printer_id    uuid references public.printers(id) on delete set null,
  printer_name  text not null,
  table_label   text,
  waiter        text not null default '',
  lines         jsonb not null default '[]'::jsonb,   -- [{ "name": "برغر", "quantity": 2, "options": ["بيض"], "note": null }]
  created_at    timestamptz not null default now(),
  printed_at    timestamptz
);
create index if not exists kitchen_tickets_order_id_idx on public.kitchen_tickets (order_id);
create index if not exists kitchen_tickets_waiting_idx on public.kitchen_tickets (created_at) where printed_at is null;

-- يعلّم الأسطر الجديدة "مبعوثة" ويرجّعها، في عملية وحدة: جهازين يضغطو Valider في نفس الوقت ما يبعثوش نفس السطر مرتين
create or replace function public.send_order_lines(p_order_id uuid)
returns setof public.order_items
language plpgsql set search_path = public as $$
begin
  perform 1 from public.orders where id = p_order_id and status = 'open' for update;
  if not found then
    raise exception 'order_not_open';
  end if;
  return query
    with sent as (
      update public.order_items set sent_at = now()
      where order_id = p_order_id and sent_at is null
      returning *
    )
    select * from sent;
end $$;

grant execute on function public.send_order_lines(uuid) to authenticated;

-- ───────────── الصلاحيات ─────────────

alter table public.printers          enable row level security;
alter table public.category_printers enable row level security;
alter table public.kitchen_tickets   enable row level security;

drop policy if exists "staff all printers" on public.printers;
create policy "staff all printers" on public.printers for all to authenticated using (true) with check (true);
drop policy if exists "staff all category_printers" on public.category_printers;
create policy "staff all category_printers" on public.category_printers for all to authenticated using (true) with check (true);
drop policy if exists "staff all kitchen_tickets" on public.kitchen_tickets;
create policy "staff all kitchen_tickets" on public.kitchen_tickets for all to authenticated using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'kitchen_tickets') then
    alter publication supabase_realtime add table public.kitchen_tickets;
  end if;
end $$;

-- ───────────── طابعات تجريبية (فقط إذا الجدول فارغ) ─────────────

do $$
declare
  v_cuisine uuid;
  v_caisse  uuid;
begin
  if exists (select 1 from public.printers) then
    return;
  end if;
  insert into public.printers (name, sort_order) values ('CUISINE', 0) returning id into v_cuisine;
  insert into public.printers (name, sort_order) values ('PIZZA', 1);
  insert into public.printers (name, sort_order) values ('CAISSE', 2) returning id into v_caisse;
  -- فئات القائمة التجريبية إذا مازالت موجودة: المشروبات → CAISSE، الباقي → CUISINE
  insert into public.category_printers (category_id, printer_id)
  select c.id, case when c.id in ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002') then v_caisse else v_cuisine end
  from public.categories c
  where c.id in ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003',
                 '10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000005');
end $$;

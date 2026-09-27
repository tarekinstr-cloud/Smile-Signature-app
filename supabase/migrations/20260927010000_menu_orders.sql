-- Smile Signature: القائمة (فئات، أصناف، خيارات) والطلبات (المرحلة 1، الجزء 2)

-- ───────────── القائمة ─────────────

create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  color       text not null default '#f59e0b',
  sort_order  integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.items (
  id           uuid primary key default gen_random_uuid(),
  category_id  uuid not null references public.categories(id) on delete cascade,
  name         text not null check (length(trim(name)) > 0),
  price        numeric(10,2) not null default 0 check (price >= 0),
  sort_order   integer not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index items_category_id_idx on public.items (category_id);

-- مجموعة خيارات لصنف، مثلاً "الحجم" (اختيار واحد إجباري) أو "إضافات" (اختياري، عدة اختيارات)
create table public.option_groups (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.items(id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  min_select  integer not null default 0 check (min_select >= 0),
  max_select  integer not null default 1 check (max_select >= 1),
  sort_order  integer not null default 0,
  check (min_select <= max_select)
);
create index option_groups_item_id_idx on public.option_groups (item_id);

create table public.options (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references public.option_groups(id) on delete cascade,
  name         text not null check (length(trim(name)) > 0),
  price_delta  numeric(10,2) not null default 0,
  sort_order   integer not null default 0
);
create index options_group_id_idx on public.options (group_id);

-- ───────────── الطلبات ─────────────

create type public.order_status as enum ('open', 'paid', 'cancelled');

create table public.orders (
  id          uuid primary key default gen_random_uuid(),
  table_id    uuid references public.tables(id) on delete set null,  -- يبقى الطلب في السجل حتى لو حُذفت الطاولة
  status      public.order_status not null default 'open',
  note        text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);
-- طلب مفتوح واحد فقط لكل طاولة
create unique index orders_one_open_per_table on public.orders (table_id) where status = 'open';
create index orders_table_id_idx on public.orders (table_id);

-- سطور الطلب: الاسم والسعر والخيارات تُنسخ وقت الإضافة، حتى لا يتغيّر طلب قديم إذا تغيّرت القائمة
create table public.order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders(id) on delete cascade,
  item_id     uuid references public.items(id) on delete set null,
  name        text not null,
  unit_price  numeric(10,2) not null check (unit_price >= 0),  -- سعر الوحدة شامل الخيارات
  quantity    integer not null default 1 check (quantity > 0),
  options     jsonb not null default '[]'::jsonb,              -- [{ "group": "الحجم", "name": "كبير", "price_delta": 5 }]
  note        text,
  created_at  timestamptz not null default now()
);
create index order_items_order_id_idx on public.order_items (order_id);

-- فتح طلب يجعل الطاولة مشغولة، وإغلاقه (دفع أو إلغاء) يحرّرها
create function public.sync_table_status_from_order() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'open' then
    update public.tables set status = 'occupied' where id = new.table_id and status <> 'occupied';
  elsif tg_op = 'UPDATE' and old.status = 'open' then
    new.closed_at := coalesce(new.closed_at, now());
    update public.tables set status = 'free' where id = new.table_id;
  end if;
  return new;
end $$;

create trigger orders_sync_table_status
  before insert or update of status on public.orders
  for each row execute function public.sync_table_status_from_order();

-- RLS: الطاقم المسجّل فقط
alter table public.categories    enable row level security;
alter table public.items         enable row level security;
alter table public.option_groups enable row level security;
alter table public.options       enable row level security;
alter table public.orders        enable row level security;
alter table public.order_items   enable row level security;

create policy "staff all categories"    on public.categories    for all to authenticated using (true) with check (true);
create policy "staff all items"         on public.items         for all to authenticated using (true) with check (true);
create policy "staff all option_groups" on public.option_groups for all to authenticated using (true) with check (true);
create policy "staff all options"       on public.options       for all to authenticated using (true) with check (true);
create policy "staff all orders"        on public.orders        for all to authenticated using (true) with check (true);
create policy "staff all order_items"   on public.order_items   for all to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.orders, public.order_items;

-- ───────────── قائمة تجريبية (يمكن تعديلها أو حذفها من Table Editor) ─────────────

insert into public.categories (id, name, color, sort_order) values
  ('10000000-0000-0000-0000-000000000001', 'مشروبات ساخنة', '#b45309', 0),
  ('10000000-0000-0000-0000-000000000002', 'عصائر',          '#16a34a', 1),
  ('10000000-0000-0000-0000-000000000003', 'فطور',           '#f59e0b', 2),
  ('10000000-0000-0000-0000-000000000004', 'أطباق',          '#dc2626', 3),
  ('10000000-0000-0000-0000-000000000005', 'حلويات',         '#db2777', 4);

insert into public.items (id, category_id, name, price, sort_order) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'قهوة سوداء',  12, 0),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'قهوة بالحليب', 15, 1),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'أتاي بالنعناع', 10, 2),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'كابوتشينو',   20, 3),
  ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000002', 'عصير برتقال', 15, 0),
  ('20000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000002', 'عصير أفوكا',  25, 1),
  ('20000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000002', 'بانافي',      20, 2),
  ('20000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000003', 'فطور مغربي',  45, 0),
  ('20000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000003', 'أومليت',      30, 1),
  ('20000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000004', 'طاجين دجاج',  70, 0),
  ('20000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000004', 'برغر',        55, 1),
  ('20000000-0000-0000-0000-000000000012', '10000000-0000-0000-0000-000000000004', 'سلطة سيزر',   45, 2),
  ('20000000-0000-0000-0000-000000000013', '10000000-0000-0000-0000-000000000005', 'تشيز كيك',    35, 0),
  ('20000000-0000-0000-0000-000000000014', '10000000-0000-0000-0000-000000000005', 'كريب شوكولا', 30, 1);

insert into public.option_groups (id, item_id, name, min_select, max_select, sort_order) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'الحجم',  1, 1, 0),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'السكر',  0, 1, 1),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000011', 'الطهي',  1, 1, 0),
  ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000011', 'إضافات', 0, 3, 1),
  ('30000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000005', 'الحجم',  1, 1, 0);

insert into public.options (group_id, name, price_delta, sort_order) values
  ('30000000-0000-0000-0000-000000000001', 'عادي', 0, 0),
  ('30000000-0000-0000-0000-000000000001', 'كبير', 5, 1),
  ('30000000-0000-0000-0000-000000000002', 'بدون سكر', 0, 0),
  ('30000000-0000-0000-0000-000000000002', 'سكر قليل', 0, 1),
  ('30000000-0000-0000-0000-000000000003', 'متوسط', 0, 0),
  ('30000000-0000-0000-0000-000000000003', 'مطهو جيداً', 0, 1),
  ('30000000-0000-0000-0000-000000000004', 'جبن إضافي', 5, 0),
  ('30000000-0000-0000-0000-000000000004', 'بيض', 5, 1),
  ('30000000-0000-0000-0000-000000000004', 'بطاطس', 10, 2),
  ('30000000-0000-0000-0000-000000000005', 'عادي', 0, 0),
  ('30000000-0000-0000-0000-000000000005', 'كبير', 7, 1);

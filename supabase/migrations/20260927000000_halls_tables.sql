-- Smile Signature: الصالات والطاولات (المرحلة 1، الجزء 1)

create table public.halls (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  width       integer not null default 1000 check (width between 200 and 5000),
  height      integer not null default 640 check (height between 200 and 5000),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create type public.table_status as enum ('free', 'occupied');
create type public.table_shape  as enum ('square', 'round', 'rect');

create table public.tables (
  id          uuid primary key default gen_random_uuid(),
  hall_id     uuid not null references public.halls(id) on delete cascade,
  label       text not null check (length(trim(label)) > 0),
  seats       integer not null default 4 check (seats between 1 and 40),
  shape       public.table_shape not null default 'square',
  x           integer not null default 40 check (x >= 0),
  y           integer not null default 40 check (y >= 0),
  width       integer not null default 90 check (width between 30 and 600),
  height      integer not null default 90 check (height between 30 and 600),
  status      public.table_status not null default 'free',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (hall_id, label)
);

create index tables_hall_id_idx on public.tables (hall_id);

create function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger tables_touch_updated_at
  before update on public.tables
  for each row execute function public.touch_updated_at();

-- RLS: فقط المستخدمون المسجّلون (الطاقم) يقرؤون ويعدّلون.
-- الأدوار (مدير / نادل / كاسيير) تأتي في مرحلة لاحقة.
alter table public.halls  enable row level security;
alter table public.tables enable row level security;

create policy "staff read halls"   on public.halls  for select to authenticated using (true);
create policy "staff write halls"  on public.halls  for all    to authenticated using (true) with check (true);
create policy "staff read tables"  on public.tables for select to authenticated using (true);
create policy "staff write tables" on public.tables for all    to authenticated using (true) with check (true);

-- Realtime: تحديث حالة الطاولات مباشرة على كل الأجهزة
alter publication supabase_realtime add table public.halls, public.tables;

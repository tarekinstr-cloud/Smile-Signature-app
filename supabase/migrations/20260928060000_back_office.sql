-- Smile Signature: back-office (Statistiques, Gestion du Stock, Fournisseurs, Employés)
-- Idempotent: peut être exécuté plusieurs fois sans problème.

-- ───────────── Stock ─────────────

create table if not exists public.stock_items (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  quantity    numeric(12,3) not null default 0,
  unit        text not null default '',                      -- kg, L, pièce…
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create unique index if not exists stock_items_name_key on public.stock_items (lower(trim(name)));

-- Ajustement manuel en une seule opération (deux appareils qui ajustent en même temps ne s'écrasent pas).
-- Pas de liaison avec les ventes pour l'instant.
create or replace function public.adjust_stock(p_item_id uuid, p_delta numeric)
returns public.stock_items
language plpgsql set search_path = public as $$
declare
  v_row public.stock_items;
begin
  update public.stock_items
     set quantity = quantity + p_delta, updated_at = now()
   where id = p_item_id
  returning * into v_row;
  if not found then
    raise exception 'stock_item_not_found';
  end if;
  return v_row;
end $$;

grant execute on function public.adjust_stock(uuid, numeric) to authenticated;

-- ───────────── Fournisseurs ─────────────

create table if not exists public.suppliers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  phone       text not null default '',
  products    text not null default '',                      -- produits fournis, texte libre
  created_at  timestamptz not null default now()
);

-- ───────────── Employés (lecture seule) ─────────────

-- Les comptes qui se connectent à l'app (auth.users), sans exposer la table auth au client.
-- Pas encore de rôles : chaque compte connecté a les mêmes droits (« staff »).
create or replace function public.list_staff()
returns table (id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz)
language sql stable security definer set search_path = public, auth as $$
  select u.id, u.email::text, u.created_at, u.last_sign_in_at
  from auth.users u
  where auth.uid() is not null
  order by u.created_at
$$;

revoke all on function public.list_staff() from public, anon;
grant execute on function public.list_staff() to authenticated;

-- ───────────── Permissions ─────────────

alter table public.stock_items enable row level security;
alter table public.suppliers   enable row level security;

drop policy if exists "staff all stock_items" on public.stock_items;
create policy "staff all stock_items" on public.stock_items for all to authenticated using (true) with check (true);
drop policy if exists "staff all suppliers" on public.suppliers;
create policy "staff all suppliers" on public.suppliers for all to authenticated using (true) with check (true);

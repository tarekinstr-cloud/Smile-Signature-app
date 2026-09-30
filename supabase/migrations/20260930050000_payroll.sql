-- Smile Signature: salaires et acomptes (menu Gestion des employés > Salaires et acomptes)
-- Idempotent: peut être exécuté plusieurs fois sans problème.
-- À exécuter après 20260930040000_reservation_no_show.sql (nécessite 20260930000000_permissions.sql).
--
-- Chaque employé (compte de Fichier > Utilisateurs) a un salaire mensuel fixe en DA (app_users.monthly_salary).
-- Un acompte = une avance sur salaire (montant, date, note optionnelle) dans salary_advances.
-- Le récapitulatif d'un mois = salaire mensuel, somme des acomptes datés de ce mois, reste à payer (salaire - acomptes).
-- Nouvelle permission « payroll » : voir les salaires, changer un salaire, ajouter ou supprimer un acompte.
-- Par défaut : Admin oui, Employé non (réglable dans Fichier > Permissions).

-- ───────────── Salaire mensuel ─────────────

alter table public.app_users add column if not exists monthly_salary numeric(12,2) not null default 0;
alter table public.app_users drop constraint if exists app_users_monthly_salary_check;
alter table public.app_users add constraint app_users_monthly_salary_check check (monthly_salary >= 0);

comment on column public.app_users.monthly_salary is 'Salaire mensuel fixe en DA (0: non renseigné).';

-- ───────────── Acomptes ─────────────

create table if not exists public.salary_advances (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.app_users (user_id) on delete cascade,
  amount      numeric(12,2) not null check (amount > 0),
  date        date not null default current_date,
  note        text,
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists salary_advances_user_date on public.salary_advances (user_id, date);

comment on table public.salary_advances is 'Acomptes (avances sur salaire) versés aux employés.';

-- ───────────── Permission « payroll » ─────────────

alter table public.role_permissions drop constraint if exists role_permissions_permission_check;
alter table public.role_permissions add constraint role_permissions_permission_check check (permission in (
  'staff', 'payroll', 'stock', 'suppliers', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones',
  'cancel_order', 'offer', 'discount'));
alter table public.user_permissions drop constraint if exists user_permissions_permission_check;
alter table public.user_permissions add constraint user_permissions_permission_check check (permission in (
  'staff', 'payroll', 'stock', 'suppliers', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones',
  'cancel_order', 'offer', 'discount'));

insert into public.role_permissions (role, permission, allowed)
values ('admin', 'payroll', true), ('employe', 'payroll', false)
on conflict (role, permission) do nothing;

create or replace function public.my_permissions()
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p order by p), '{}')
  from unnest(array['staff', 'payroll', 'stock', 'suppliers', 'stats', 'settings', 'edit', 'backup', 'ticket', 'reservations', 'delivery_zones',
                    'cancel_order', 'offer', 'discount']) p
  where public.has_permission(p)
$$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- ───────────── Récapitulatif d'un mois ─────────────
-- Tous les comptes de Fichier > Utilisateurs (les inactifs aussi, après les actifs), avec les acomptes du mois de p_month.

create or replace function public.payroll_summary(p_month date)
returns table (user_id uuid, username text, display_name text, role text, active boolean,
               monthly_salary numeric, advances numeric, advances_count integer, remaining numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := date_trunc('month', coalesce(p_month, current_date))::date;
  v_to date := (date_trunc('month', coalesce(p_month, current_date)) + interval '1 month')::date;
begin
  if not public.has_permission('payroll') then
    raise exception 'no_permission';
  end if;
  return query
    select a.user_id, a.username, a.display_name, a.role, a.active, a.monthly_salary,
           coalesce(s.total, 0), coalesce(s.n, 0)::integer, a.monthly_salary - coalesce(s.total, 0)
    from public.app_users a
    left join lateral (
      select sum(v.amount) as total, count(*) as n from public.salary_advances v
      where v.user_id = a.user_id and v.date >= v_from and v.date < v_to
    ) s on true
    order by a.active desc, lower(coalesce(nullif(a.display_name, ''), a.username));
end $$;
revoke all on function public.payroll_summary(date) from public, anon;
grant execute on function public.payroll_summary(date) to authenticated;

-- Changer le salaire mensuel d'un employé (app_users n'est modifiable directement que par l'admin via save_user).
create or replace function public.set_monthly_salary(p_user_id uuid, p_amount numeric)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_permission('payroll') then
    raise exception 'no_permission';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'bad_amount';
  end if;
  update public.app_users set monthly_salary = round(p_amount, 2) where user_id = p_user_id;
  if not found then
    raise exception 'user_not_found';
  end if;
end $$;
revoke all on function public.set_monthly_salary(uuid, numeric) from public, anon;
grant execute on function public.set_monthly_salary(uuid, numeric) to authenticated;

-- ───────────── RLS : acomptes réservés à la permission « payroll » ─────────────

alter table public.salary_advances enable row level security;
drop policy if exists "perm payroll salary_advances" on public.salary_advances;
create policy "perm payroll salary_advances" on public.salary_advances for all to authenticated
  using (public.has_permission('payroll')) with check (public.has_permission('payroll'));

grant select, insert, update, delete on public.salary_advances to authenticated;

-- ───────────── Realtime : le récapitulatif se met à jour sur tous les appareils ─────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'salary_advances') then
    alter publication supabase_realtime add table public.salary_advances;
  end if;
end $$;

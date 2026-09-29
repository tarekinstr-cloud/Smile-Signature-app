-- Smile Signature: permissions configurables (par rôle, avec exceptions par utilisateur)
-- Idempotent: peut être exécuté plusieurs fois sans problème.
-- À exécuter après 20260929030000_login_repair.sql.
--
-- Permissions (clé → section ou action):
--   staff      Gestion des employés          stock     Gestion du Stock
--   suppliers  Fournisseurs                   stats     Statistiques / bénéfice
--   settings   Paramètres (et imprimantes)    edit      Édition (plan de salle, salles, menu)
--   backup     Fichier > Sauvegarder la base  ticket    Fichier > Modifier le Ticket
--   cancel_order  Annuler la CMD              offer     Offrir            discount  Remise
-- L'écran de service (plan de salle, commandes, encaissement, à emporter, livraison) est ouvert à tous.
-- Fichier > Utilisateurs et Permissions restent réservés au rôle admin (sinon un compte pourrait s'accorder des droits).

-- ───────────── Tables ─────────────

create table if not exists public.role_permissions (
  role        text not null check (role in ('admin', 'employe')),
  permission  text not null,
  allowed     boolean not null,
  primary key (role, permission)
);

-- Exception pour un utilisateur : remplace la valeur de son rôle pour cette permission.
create table if not exists public.user_permissions (
  user_id     uuid not null references auth.users (id) on delete cascade,
  permission  text not null,
  allowed     boolean not null,
  primary key (user_id, permission)
);

alter table public.role_permissions drop constraint if exists role_permissions_permission_check;
alter table public.role_permissions add constraint role_permissions_permission_check check (permission in (
  'staff', 'stock', 'suppliers', 'stats', 'settings', 'edit', 'backup', 'ticket', 'cancel_order', 'offer', 'discount'));
alter table public.user_permissions drop constraint if exists user_permissions_permission_check;
alter table public.user_permissions add constraint user_permissions_permission_check check (permission in (
  'staff', 'stock', 'suppliers', 'stats', 'settings', 'edit', 'backup', 'ticket', 'cancel_order', 'offer', 'discount'));

-- Valeurs par défaut (comme avant) : admin tout, employé rien en dehors du service. Les choix déjà faits sont gardés.
insert into public.role_permissions (role, permission, allowed)
select r, p, r = 'admin'
from unnest(array['admin', 'employe']) r,
     unnest(array['staff', 'stock', 'suppliers', 'stats', 'settings', 'edit', 'backup', 'ticket', 'cancel_order', 'offer', 'discount']) p
on conflict (role, permission) do nothing;

-- ───────────── Fonctions ─────────────

-- Droit de l'utilisateur connecté : son exception s'il en a une, sinon la valeur de son rôle.
create or replace function public.has_permission(p_permission text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select up.allowed from public.user_permissions up
      join public.app_users a on a.user_id = up.user_id and a.active
      where up.user_id = auth.uid() and up.permission = p_permission),
    (select rp.allowed from public.role_permissions rp
      join public.app_users a on a.role = rp.role and a.active
      where a.user_id = auth.uid() and rp.permission = p_permission),
    false)
$$;
revoke all on function public.has_permission(text) from public, anon;
grant execute on function public.has_permission(text) to authenticated;

-- Toutes les permissions accordées à l'utilisateur connecté (lues par l'app pour la navigation et les boutons).
create or replace function public.my_permissions()
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p order by p), '{}')
  from unnest(array['staff', 'stock', 'suppliers', 'stats', 'settings', 'edit', 'backup', 'ticket', 'cancel_order', 'offer', 'discount']) p
  where public.has_permission(p)
$$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- Pour les triggers : une opération sans utilisateur (SQL Editor, fonctions internes) passe.
create or replace function public.permission_ok(p_permission text)
returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is null or public.has_permission(p_permission)
$$;
revoke all on function public.permission_ok(text) from public, anon;
grant execute on function public.permission_ok(text) to authenticated;

-- ───────────── Qui peut modifier les permissions : l'admin ─────────────

alter table public.role_permissions enable row level security;
alter table public.user_permissions enable row level security;
drop policy if exists "staff read role_permissions" on public.role_permissions;
drop policy if exists "admin write role_permissions" on public.role_permissions;
create policy "staff read role_permissions" on public.role_permissions for select to authenticated using (true);
create policy "admin write role_permissions" on public.role_permissions for all to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());
drop policy if exists "own or admin read user_permissions" on public.user_permissions;
drop policy if exists "admin write user_permissions" on public.user_permissions;
create policy "own or admin read user_permissions" on public.user_permissions for select to authenticated
  using (user_id = auth.uid() or public.is_app_admin());
create policy "admin write user_permissions" on public.user_permissions for all to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());

-- ───────────── Sections : RLS selon la permission ─────────────

-- Stock et fournisseurs
drop policy if exists "admin all stock_items" on public.stock_items;
drop policy if exists "perm stock stock_items" on public.stock_items;
create policy "perm stock stock_items" on public.stock_items for all to authenticated
  using (public.has_permission('stock')) with check (public.has_permission('stock'));
drop policy if exists "admin all suppliers" on public.suppliers;
drop policy if exists "perm suppliers suppliers" on public.suppliers;
create policy "perm suppliers suppliers" on public.suppliers for all to authenticated
  using (public.has_permission('suppliers')) with check (public.has_permission('suppliers'));

-- Sauvegardes
drop policy if exists "admin read backups_log" on public.backups_log;
drop policy if exists "admin add backups_log" on public.backups_log;
drop policy if exists "perm backup read backups_log" on public.backups_log;
drop policy if exists "perm backup add backups_log" on public.backups_log;
create policy "perm backup read backups_log" on public.backups_log for select to authenticated using (public.has_permission('backup'));
create policy "perm backup add backups_log" on public.backups_log for insert to authenticated with check (public.has_permission('backup'));

-- Ticket : tout le monde le lit pour imprimer, la permission « ticket » le modifie
drop policy if exists "admin write receipt_settings" on public.receipt_settings;
drop policy if exists "admin update receipt_settings" on public.receipt_settings;
drop policy if exists "perm ticket insert receipt_settings" on public.receipt_settings;
drop policy if exists "perm ticket update receipt_settings" on public.receipt_settings;
create policy "perm ticket insert receipt_settings" on public.receipt_settings for insert to authenticated with check (public.has_permission('ticket'));
create policy "perm ticket update receipt_settings" on public.receipt_settings for update to authenticated
  using (public.has_permission('ticket')) with check (public.has_permission('ticket'));

-- Paramètres : imprimantes et liens catégorie → imprimante (lus par tous pour envoyer en cuisine)
drop policy if exists "staff all printers" on public.printers;
drop policy if exists "staff read printers" on public.printers;
drop policy if exists "perm settings write printers" on public.printers;
create policy "staff read printers" on public.printers for select to authenticated using (true);
create policy "perm settings write printers" on public.printers for all to authenticated
  using (public.has_permission('settings')) with check (public.has_permission('settings'));
drop policy if exists "staff all category_printers" on public.category_printers;
drop policy if exists "staff read category_printers" on public.category_printers;
drop policy if exists "perm settings write category_printers" on public.category_printers;
create policy "staff read category_printers" on public.category_printers for select to authenticated using (true);
create policy "perm settings write category_printers" on public.category_printers for all to authenticated
  using (public.has_permission('settings')) with check (public.has_permission('settings'));

-- Édition : salles, tables du plan, menu (lus par tous pour le service). L'état libre/occupée d'une table est
-- mis à jour par des triggers security definer, donc le service n'a pas besoin d'écrire dans « tables ».
drop policy if exists "staff write halls" on public.halls;
drop policy if exists "perm edit write halls" on public.halls;
create policy "perm edit write halls" on public.halls for all to authenticated
  using (public.has_permission('edit')) with check (public.has_permission('edit'));
drop policy if exists "staff write tables" on public.tables;
drop policy if exists "perm edit write tables" on public.tables;
create policy "perm edit write tables" on public.tables for all to authenticated
  using (public.has_permission('edit')) with check (public.has_permission('edit'));

do $$
declare
  t text;
begin
  foreach t in array array['categories', 'items', 'option_groups', 'options'] loop
    execute format('drop policy if exists %I on public.%I', 'staff all ' || t, t);
    execute format('drop policy if exists %I on public.%I', 'staff read ' || t, t);
    execute format('drop policy if exists %I on public.%I', 'perm edit write ' || t, t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', 'staff read ' || t, t);
    execute format('create policy %I on public.%I for all to authenticated using (public.has_permission(''edit'')) with check (public.has_permission(''edit''))',
                   'perm edit write ' || t, t);
  end loop;
end $$;

-- Gestion des employés
create or replace function public.list_staff()
returns table (id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz)
language sql stable security definer set search_path = public, auth as $$
  select u.id, u.email::text, u.created_at, u.last_sign_in_at
  from auth.users u
  where public.has_permission('staff')
  order by u.created_at
$$;

-- ───────────── Actions : Annuler la CMD, Offrir, Remise ─────────────

-- Vérifiées dans la base au moment de l'écriture, quel que soit l'écran qui écrit.
create or replace function public.orders_check_permissions() returns trigger
language plpgsql set search_path = public as $$
begin
  -- Annuler une commande qui a des articles (une commande vide abandonnée se ferme sans permission).
  if new.status = 'cancelled' and old.status is distinct from 'cancelled'
     and exists (select 1 from public.order_items i where i.order_id = new.id)
     and not public.permission_ok('cancel_order') then
    raise exception 'permission_denied:cancel_order';
  end if;
  if new.offered is distinct from old.offered and not public.permission_ok('offer') then
    raise exception 'permission_denied:offer';
  end if;
  if (new.discount_type is distinct from old.discount_type or new.discount_value is distinct from old.discount_value)
     and not public.permission_ok('discount') then
    raise exception 'permission_denied:discount';
  end if;
  return new;
end $$;
drop trigger if exists orders_check_permissions on public.orders;
create trigger orders_check_permissions before update on public.orders
  for each row execute function public.orders_check_permissions();

create or replace function public.order_items_check_permissions() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.offered is distinct from old.offered and not public.permission_ok('offer') then
    raise exception 'permission_denied:offer';
  end if;
  if (new.discount_type is distinct from old.discount_type or new.discount_value is distinct from old.discount_value)
     and not public.permission_ok('discount') then
    raise exception 'permission_denied:discount';
  end if;
  return new;
end $$;
drop trigger if exists order_items_check_permissions on public.order_items;
create trigger order_items_check_permissions before update on public.order_items
  for each row execute function public.order_items_check_permissions();

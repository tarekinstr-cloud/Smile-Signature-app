-- Smile Signature: rôles Admin / Employé et protection des données sensibles (RLS)
-- Idempotent: peut être exécuté plusieurs fois sans problème.
-- À exécuter après 20260929000000_users_backup.sql et 20260929010000_login.sql.

-- ───────────── Deux rôles : admin, employe ─────────────

-- Anciens rôles : Gérant → admin ; Caissier et Serveur → employe.
alter table public.app_users drop constraint if exists app_users_role_check;
update public.app_users set role = 'admin' where role = 'manager';
update public.app_users set role = 'employe' where role not in ('admin', 'employe');
alter table public.app_users alter column role set default 'employe';
alter table public.app_users add constraint app_users_role_check check (role in ('admin', 'employe'));

-- save_user n'accepte plus que ces deux rôles.
create or replace function public.save_user(
  p_id uuid, p_username text, p_display_name text, p_role text, p_password text, p_active boolean
)
returns uuid
language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  v_id uuid := p_id;
  v_username text := lower(trim(coalesce(p_username, '')));
  v_email text;
begin
  if not public.is_app_admin() then
    raise exception 'not_admin';
  end if;
  if v_username !~ '^[a-z0-9._-]{2,32}$' then
    raise exception 'bad_username';
  end if;
  if p_role not in ('admin', 'employe') then
    raise exception 'bad_role';
  end if;
  if (v_id is null or coalesce(p_password, '') <> '') and length(coalesce(p_password, '')) < 4 then
    raise exception 'weak_password';
  end if;
  if exists (select 1 from public.app_users where lower(username) = v_username and user_id is distinct from v_id) then
    raise exception 'username_taken';
  end if;

  if v_id is null then
    v_id := gen_random_uuid();
    v_email := v_username || '@smile-signature.local';
    if exists (select 1 from auth.users where lower(email) = v_email) then
      raise exception 'username_taken';
    end if;
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
      crypt(p_password, gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('username', v_username), now(), now(),
      '', '', '', ''
    );
    insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (
      gen_random_uuid(), v_id::text, v_id,
      jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
      'email', now(), now(), now()
    );
  else
    if not exists (select 1 from auth.users where id = v_id) then
      raise exception 'user_not_found';
    end if;
    -- Un administrateur ne peut pas se retirer ses propres droits ni se désactiver (il resterait bloqué dehors).
    if v_id = auth.uid() and (p_role <> 'admin' or not p_active) then
      raise exception 'self_demote';
    end if;
    if coalesce(p_password, '') <> '' then
      update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now() where id = v_id;
    end if;
  end if;

  update auth.users set banned_until = case when p_active then null else 'infinity'::timestamptz end where id = v_id;

  insert into public.app_users (user_id, username, display_name, role, active)
  values (v_id, v_username, trim(coalesce(p_display_name, '')), p_role, p_active)
  on conflict (user_id) do update
    set username = excluded.username, display_name = excluded.display_name, role = excluded.role, active = excluded.active;

  return v_id;
end $$;
revoke all on function public.save_user(uuid, text, text, text, text, boolean) from public, anon;
grant execute on function public.save_user(uuid, text, text, text, text, boolean) to authenticated;

-- ───────────── Comptes : réservés à l'admin ─────────────

-- Un employé ne lit que son propre profil (nom et rôle affichés dans l'app).
drop policy if exists "staff read app_users" on public.app_users;
drop policy if exists "own or admin read app_users" on public.app_users;
create policy "own or admin read app_users" on public.app_users for select to authenticated
  using (user_id = auth.uid() or public.is_app_admin());

create or replace function public.list_users()
returns table (
  id uuid, username text, display_name text, role text, active boolean, email text,
  created_at timestamptz, last_sign_in_at timestamptz
)
language sql stable security definer set search_path = public, auth as $$
  select u.id,
         coalesce(a.username, split_part(u.email, '@', 1)),
         coalesce(a.display_name, ''),
         a.role,
         coalesce(a.active, true),
         u.email::text,
         u.created_at,
         u.last_sign_in_at
  from auth.users u
  left join public.app_users a on a.user_id = u.id
  where public.is_app_admin()
  order by lower(coalesce(a.username, u.email))
$$;

create or replace function public.list_staff()
returns table (id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz)
language sql stable security definer set search_path = public, auth as $$
  select u.id, u.email::text, u.created_at, u.last_sign_in_at
  from auth.users u
  where public.is_app_admin()
  order by u.created_at
$$;

-- ───────────── Stock et fournisseurs : admin seulement ─────────────

drop policy if exists "staff all stock_items" on public.stock_items;
drop policy if exists "admin all stock_items" on public.stock_items;
create policy "admin all stock_items" on public.stock_items for all to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());

drop policy if exists "staff all suppliers" on public.suppliers;
drop policy if exists "admin all suppliers" on public.suppliers;
create policy "admin all suppliers" on public.suppliers for all to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());

-- ───────────── Sauvegardes : admin seulement ─────────────

drop policy if exists "staff read backups_log" on public.backups_log;
drop policy if exists "staff add backups_log" on public.backups_log;
drop policy if exists "admin read backups_log" on public.backups_log;
drop policy if exists "admin add backups_log" on public.backups_log;
create policy "admin read backups_log" on public.backups_log for select to authenticated using (public.is_app_admin());
create policy "admin add backups_log" on public.backups_log for insert to authenticated with check (public.is_app_admin());

-- ───────────── Ticket : tout le monde l'imprime, seul l'admin le modifie ─────────────

drop policy if exists "staff all receipt_settings" on public.receipt_settings;
drop policy if exists "staff read receipt_settings" on public.receipt_settings;
drop policy if exists "admin write receipt_settings" on public.receipt_settings;
drop policy if exists "admin update receipt_settings" on public.receipt_settings;
create policy "staff read receipt_settings" on public.receipt_settings for select to authenticated using (true);
create policy "admin write receipt_settings" on public.receipt_settings for insert to authenticated with check (public.is_app_admin());
create policy "admin update receipt_settings" on public.receipt_settings for update to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());

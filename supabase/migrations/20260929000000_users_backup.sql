-- Smile Signature: menu Fichier (Utilisateurs, Sauvegarder la base de données, Modifier le Ticket)
-- Idempotent: peut être exécuté plusieurs fois sans problème.

create extension if not exists pgcrypto with schema extensions;

-- ───────────── Utilisateurs ─────────────

-- Profil de chaque compte (auth.users) : nom d'utilisateur pour la connexion, nom affiché, rôle, actif.
-- Les comptes sont créés et modifiés par un administrateur via save_user (la clé service_role reste hors de l'app).
create table if not exists public.app_users (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  username      text not null check (username ~ '^[a-z0-9._-]{2,32}$'),
  display_name  text not null default '',
  role          text not null default 'cashier' check (role in ('admin', 'manager', 'cashier', 'waiter')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create unique index if not exists app_users_username_key on public.app_users (lower(username));

-- Premier passage : les comptes déjà existants deviennent administrateurs (nom d'utilisateur = début de l'e-mail).
do $$
declare
  u record;
  v_name text;
begin
  if exists (select 1 from public.app_users) then
    return;
  end if;
  for u in select id, email from auth.users order by created_at loop
    v_name := left(regexp_replace(lower(split_part(coalesce(u.email, ''), '@', 1)), '[^a-z0-9._-]', '', 'g'), 24);
    if length(v_name) < 2 then
      v_name := 'user';
    end if;
    if exists (select 1 from public.app_users where lower(username) = v_name) then
      v_name := v_name || '-' || left(u.id::text, 4);
    end if;
    insert into public.app_users (user_id, username, role) values (u.id, v_name, 'admin');
  end loop;
end $$;

create or replace function public.is_app_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_users where user_id = auth.uid() and role = 'admin' and active)
$$;
revoke all on function public.is_app_admin() from public, anon;
grant execute on function public.is_app_admin() to authenticated;

-- Liste des comptes pour la page Utilisateurs. Un compte créé ailleurs (tableau de bord Supabase) sans profil
-- apparaît avec role = null ; un administrateur peut lui donner un profil.
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
  where auth.uid() is not null
  order by lower(coalesce(a.username, u.email))
$$;
revoke all on function public.list_users() from public, anon;
grant execute on function public.list_users() to authenticated;

-- Crée (p_id null) ou modifie un compte. Réservé aux administrateurs.
-- Mot de passe : obligatoire à la création, vide = inchangé en modification.
-- Un compte désactivé ne peut plus se connecter (banned_until).
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
  if p_role not in ('admin', 'manager', 'cashier', 'waiter') then
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

alter table public.app_users enable row level security;
drop policy if exists "staff read app_users" on public.app_users;
create policy "staff read app_users" on public.app_users for select to authenticated using (true);
-- Pas de policy d'écriture : les changements passent par save_user.

-- ───────────── Sauvegardes ─────────────

-- Journal des exports faits depuis l'app (le fichier lui-même est téléchargé sur l'appareil).
create table if not exists public.backups_log (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  user_label  text not null default '',
  format      text not null check (format in ('json', 'csv')),
  tables      text[] not null default '{}',
  row_count   integer not null default 0,
  size_bytes  integer not null default 0
);

alter table public.backups_log enable row level security;
drop policy if exists "staff read backups_log" on public.backups_log;
create policy "staff read backups_log" on public.backups_log for select to authenticated using (true);
drop policy if exists "staff add backups_log" on public.backups_log;
create policy "staff add backups_log" on public.backups_log for insert to authenticated with check (true);

-- ───────────── Ticket ─────────────

-- Logo du ticket (image en data URL, réduite par l'app). Vide = logo par défaut.
alter table public.receipt_settings add column if not exists logo text;

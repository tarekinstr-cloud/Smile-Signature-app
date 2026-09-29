-- Smile Signature: réparation de la connexion par nom d'utilisateur (ex. « agent1 »)
-- Idempotent: peut être exécuté plusieurs fois sans problème.
-- À exécuter après 20260929020000_roles.sql. Contient aussi login_users / login_email : si
-- 20260929010000_login.sql n'avait pas été exécuté, celle-ci suffit.

-- ───────────── Connexion par nom d'utilisateur ─────────────

-- Noms des comptes actifs, pour la liste déroulante de l'écran de connexion (avant d'être connecté).
create or replace function public.login_users()
returns table (username text, display_name text)
language sql stable security definer set search_path = public as $$
  select a.username, a.display_name
  from public.app_users a
  where a.active
  order by lower(a.username)
$$;
revoke all on function public.login_users() from public;
grant execute on function public.login_users() to anon, authenticated;

-- Adresse de connexion Supabase d'un nom d'utilisateur (null si inconnu ou désactivé).
-- Le mot de passe est toujours vérifié par Supabase Auth.
create or replace function public.login_email(p_username text)
returns text
language sql stable security definer set search_path = public, auth as $$
  select u.email::text
  from public.app_users a
  join auth.users u on u.id = a.user_id
  where lower(a.username) = lower(trim(p_username)) and a.active
$$;
revoke all on function public.login_email(text) from public;
grant execute on function public.login_email(text) to anon, authenticated;

-- ───────────── Réparation des comptes existants ─────────────

-- Comptes gérés dans l'app : e-mail confirmé et jetons vides (sinon Supabase Auth refuse la connexion).
update auth.users u
   set email_confirmed_at = coalesce(u.email_confirmed_at, now()),
       confirmation_token = coalesce(u.confirmation_token, ''),
       recovery_token = coalesce(u.recovery_token, ''),
       email_change_token_new = coalesce(u.email_change_token_new, ''),
       email_change = coalesce(u.email_change, '')
 where exists (select 1 from public.app_users a where a.user_id = u.id)
   and (u.email_confirmed_at is null or u.confirmation_token is null or u.recovery_token is null
        or u.email_change_token_new is null or u.email_change is null);

-- Identité « email » manquante.
insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id::text, u.id,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       'email', now(), now(), now()
  from auth.users u
  join public.app_users a on a.user_id = u.id
 where u.email is not null
   and not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email');

-- ───────────── save_user : même réparation à chaque enregistrement ─────────────

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
    -- Un compte dont l'admin gère le mot de passe doit pouvoir se connecter tout de suite (compte créé dans le
    -- tableau de bord sans confirmation d'e-mail, jetons vides requis par Supabase Auth).
    update auth.users
       set email_confirmed_at = coalesce(email_confirmed_at, now()),
           confirmation_token = coalesce(confirmation_token, ''),
           recovery_token = coalesce(recovery_token, ''),
           email_change_token_new = coalesce(email_change_token_new, ''),
           email_change = coalesce(email_change, '')
     where id = v_id;
    insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    select gen_random_uuid(), u.id::text, u.id,
           jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
           'email', now(), now(), now()
      from auth.users u
     where u.id = v_id and u.email is not null
       and not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email');
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

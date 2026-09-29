-- Smile Signature: écran de connexion (liste des utilisateurs + connexion par nom d'utilisateur)
-- Idempotent: peut être exécuté plusieurs fois sans problème.
-- À exécuter après 20260929000000_users_backup.sql.

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

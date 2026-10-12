#!/usr/bin/env bash
# Crée (ou répare) un compte administrateur de l'application : nom d'utilisateur + mot de passe.
# Usage : creer-admin            (questions posées à l'écran)
#         creer-admin nom motdepasse ["Nom affiché"]
set -euo pipefail
bash "$(dirname "$0")/attendre.sh" 120 >/dev/null

user="${1:-}"; pass="${2:-}"; display="${3:-}"
if [ -z "$user" ]; then
  read -r -p "Nom d'utilisateur de l'administrateur (ex. admin) : " user
fi
user="$(echo "$user" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
if ! [[ "$user" =~ ^[a-z0-9._-]{2,32}$ ]]; then
  echo "ERREUR : nom invalide (2 a 32 caracteres : lettres, chiffres, point, tiret)."; exit 1
fi
# Mot de passe : lettres SANS accent, chiffres et signes du clavier. Une lettre accentuée tapée dans la fenêtre
# noire de Windows n'arrive pas toujours avec le même codage que dans le navigateur : le compte serait créé avec
# un mot de passe impossible à retaper dans l'application. On la refuse donc ici, avec un message clair.
probleme_mdp() {
  if printf '%s' "$1" | LC_ALL=C grep -q '[^ -~]'; then
    echo "ERREUR : le mot de passe contient une lettre accentuee ou un signe special (é è à ç ù € ...)."
    echo "         Utilisez seulement des lettres sans accent (a-z, A-Z), des chiffres et les signes du clavier"
    echo "         comme ! ? @ # - _ . (exemple : Cafe2026!)."
    return 0
  fi
  if [ ${#1} -lt 4 ]; then echo "ERREUR : mot de passe trop court (4 caracteres minimum)."; return 0; fi
  return 1
}
if [ -z "$pass" ]; then
  for essai in 1 2 3; do
    read -r -s -p "Mot de passe (4 caracteres minimum, sans accent) : " pass; echo
    if probleme_mdp "$pass"; then pass=""; continue; fi
    read -r -s -p "Retapez le mot de passe : " again; echo
    [ "$pass" = "$again" ] && break
    echo "ERREUR : les deux mots de passe sont differents."; pass=""
  done
  [ -n "$pass" ] || { echo "ERREUR : aucun mot de passe valide apres 3 essais. Relancez CREER-ADMIN.bat."; exit 1; }
else
  probleme_mdp "$pass" && exit 1
fi
[ -n "$display" ] || display="Administrateur"

psql -v ON_ERROR_STOP=1 -q -v u="$user" -v p="$pass" -v d="$display" <<'SQL'
set search_path = public, auth, extensions;
\o /dev/null
select set_config('smile.u', :'u', false), set_config('smile.p', :'p', false), set_config('smile.d', :'d', false);
\o
do $$
declare
  v_user text := current_setting('smile.u');
  v_pass text := current_setting('smile.p');
  v_disp text := current_setting('smile.d');
  v_email text := v_user || '@smile-signature.local';
  v_id uuid;
begin
  select a.user_id into v_id from public.app_users a where lower(a.username) = v_user;
  if v_id is null then
    select u.id into v_id from auth.users u where lower(u.email) = v_email;
  end if;
  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
      crypt(v_pass, gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('username', v_user), now(), now(),
      '', '', '', ''
    );
    insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_id::text, v_id,
            jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true), 'email', now(), now(), now());
    raise notice 'Compte cree : %', v_user;
  else
    update auth.users set encrypted_password = crypt(v_pass, gen_salt('bf')), banned_until = null,
           email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now()
     where id = v_id;
    raise notice 'Compte existant : mot de passe remplace, droits administrateur retablis : %', v_user;
  end if;
  insert into public.app_users (user_id, username, display_name, role, active)
  values (v_id, v_user, v_disp, 'admin', true)
  on conflict (user_id) do update set username = excluded.username, role = 'admin', active = true;
end $$;
SQL
echo "OK : administrateur « $user » pret. Connectez-vous dans l'application avec ce nom et ce mot de passe."

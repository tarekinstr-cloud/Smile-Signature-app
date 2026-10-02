#!/usr/bin/env bash
# Applique dans l'ordre les migrations de supabase/migrations qui ne l'ont pas encore été (suivi dans la table
# serveur_local.migrations), vérifie les buckets de photos, puis prépare la fonction pin-login.
# Chaque migration est appliquée en une seule transaction : en cas d'erreur, rien n'est à moitié fait.
set -euo pipefail
bash "$(dirname "$0")/attendre.sh" "${ATTENTE_MAX:-300}"

psql -v ON_ERROR_STOP=1 -q <<'SQL'
create schema if not exists serveur_local;
create table if not exists serveur_local.migrations (
  fichier    text primary key,
  empreinte  text not null,
  applique_le timestamptz not null default now()
);
revoke all on schema serveur_local from public, anon, authenticated;
SQL

applied=0
shopt -s nullglob
files=(/migrations/*.sql)
[ ${#files[@]} -gt 0 ] || { echo "ERREUR : aucune migration trouvee dans supabase/migrations"; exit 1; }
for f in "${files[@]}"; do
  name="$(basename "$f")"
  sum="$(sha256sum "$f" | cut -c1-16)"
  done_sum="$(psql -tAc "select empreinte from serveur_local.migrations where fichier = '$name'")"
  if [ -n "$done_sum" ]; then
    [ "$done_sum" = "$sum" ] || echo "Note : $name a change depuis son application (non rejouee)."
    continue
  fi
  echo "-> $name"
  if ! psql -v ON_ERROR_STOP=1 -q -1 -f "$f" > /tmp/migration.log 2>&1; then
    cat /tmp/migration.log
    echo "ERREUR dans $name : arret (les migrations suivantes ne sont pas appliquees)."
    exit 1
  fi
  psql -q -c "insert into serveur_local.migrations (fichier, empreinte) values ('$name', '$sum')"
  applied=$((applied + 1))
done
psql -q -c "notify pgrst, 'reload schema'"
total="$(psql -tAc "select count(*) from serveur_local.migrations")"
echo "Migrations : $applied appliquee(s) maintenant, $total au total."

# Buckets de photos (créés par les migrations ; vérifiés ici).
buckets="$(psql -tAc "select string_agg(id, ', ' order by id) from storage.buckets")"
echo "Buckets Storage : ${buckets:-aucun}"

# pin-login : un premier appel télécharge ses modules (internet nécessaire la première fois), ensuite elle
# fonctionne hors ligne. Réponse attendue : {"error":"pin_bad"} (aucun compte « verification »).
resp=""
for i in $(seq 1 30); do
  resp="$(curl -s -m 60 -X POST http://web/functions/v1/pin-login -H 'Content-Type: application/json' \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -d '{"username":"verification","pin":"0000"}' || true)"
  case "$resp" in *pin_bad*|*pin_locked*|*pin_disabled*) break ;; esac
  sleep 2
done
case "$resp" in
  *pin_bad*|*pin_locked*|*pin_disabled*) echo "OK : fonction pin-login" ;;
  *) echo "ATTENTION : pin-login ne repond pas correctement : $resp" ;;
esac

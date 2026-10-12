#!/usr/bin/env bash
# Restaure une sauvegarde faite par sauvegarder.sh : base + fichiers du stockage.
# Usage : restaurer <nom-du-dossier>      (dans /kit/sauvegardes)
# À lancer quand les autres services (auth, rest, realtime, storage, functions, web) sont ARRÊTÉS :
# RESTAURER.bat s'en occupe.
#
# La sauvegarde est d'abord chargée dans une base à part. La base actuelle n'est remplacée qu'une fois ce
# chargement réussi : en cas d'erreur, rien n'est modifié.
set -euo pipefail
nom="${1:?nom de la sauvegarde manquant}"
case "$nom" in */*|.*) echo "ERREUR : nom de sauvegarde invalide : $nom"; exit 1 ;; esac
dossier="/kit/sauvegardes/$nom"
[ -f "$dossier/base.dump" ] || { echo "ERREUR : $nom/base.dump introuvable."; exit 1; }
[ -f "$dossier/stockage.tar.gz" ] || { echo "ERREUR : $nom/stockage.tar.gz introuvable."; exit 1; }

export PGUSER=supabase_admin
pg_isready -h db -U postgres -t 60 >/dev/null || { echo "ERREUR : la base ne repond pas."; exit 1; }

echo "  - Relecture de la sauvegarde..."
pg_restore -l "$dossier/base.dump" > /dev/null || { echo "ERREUR : archive de la base illisible."; exit 1; }
tar -tzf "$dossier/stockage.tar.gz" > /dev/null || { echo "ERREUR : archive du stockage illisible."; exit 1; }

echo "  - Chargement de la base dans une base temporaire..."
psql -d template1 -q -v ON_ERROR_STOP=1 <<'SQL'
drop database if exists smile_restauration with (force);
create database smile_restauration with template template0 encoding 'UTF8' owner postgres;
SQL
# Réglages propres à la base (fuseau horaire, durée des sessions…) : pg_dump ne les contient pas, on recopie
# ceux de la base actuelle.
psql -d template1 -tAq -v ON_ERROR_STOP=1 > /tmp/reglages.sql <<'SQL'
select format('alter %sdatabase smile_restauration set %I to %L;',
              coalesce('role ' || quote_ident(r.rolname) || ' in ', ''),
              split_part(cfg, '=', 1), substr(cfg, strpos(cfg, '=') + 1))
  from pg_db_role_setting s
  join pg_database d on d.oid = s.setdatabase
  left join pg_roles r on r.oid = s.setrole
  cross join lateral unnest(s.setconfig) as cfg
 where d.datname = 'postgres';
SQL
psql -d template1 -q -v ON_ERROR_STOP=1 -f /tmp/reglages.sql

if ! pg_restore -d smile_restauration --exit-on-error "$dossier/base.dump" > /tmp/restauration.log 2>&1; then
  cat /tmp/restauration.log
  psql -d template1 -q -c "drop database if exists smile_restauration with (force)" || true
  echo "ERREUR : la sauvegarde n'a pas pu etre chargee. La base actuelle n'a PAS ete modifiee."
  exit 1
fi

echo "  - Remplacement de la base..."
# Personne ne doit être connecté à la base pendant l'échange de nom (tâches de fond de Postgres comprises).
psql -d template1 -q -v ON_ERROR_STOP=1 > /dev/null <<'SQL'
alter database postgres with allow_connections false;
select pg_terminate_backend(pid) from pg_stat_activity where datname = 'postgres' and pid <> pg_backend_pid();
SQL
ok=0
for i in $(seq 1 20); do
  if psql -d template1 -q -c "drop database if exists smile_ancienne with (force)" -c "alter database postgres rename to smile_ancienne" 2>/dev/null; then
    ok=1; break
  fi
  psql -d template1 -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'postgres' and pid <> pg_backend_pid()" >/dev/null 2>&1 || true
  sleep 1
done
if [ "$ok" != 1 ]; then
  psql -d template1 -q -c "alter database postgres with allow_connections true" || true
  psql -d template1 -q -c "drop database if exists smile_restauration with (force)" || true
  echo "ERREUR : la base actuelle est occupee. Rien n'a ete modifie ; relancez RESTAURER.bat."
  exit 1
fi
if ! psql -d template1 -q -v ON_ERROR_STOP=1 -c "alter database smile_restauration rename to postgres"; then
  # Retour à la base d'origine.
  psql -d template1 -q -c "alter database smile_ancienne rename to postgres" -c "alter database postgres with allow_connections true" || true
  echo "ERREUR : echange de base impossible. La base d'origine a ete remise en place."
  exit 1
fi
psql -d template1 -q -c "drop database if exists smile_ancienne with (force)"

echo "  - Photos et fonds de salle..."
# Extraction à côté, puis échange : en cas d'erreur, les fichiers actuels restent en place.
nouveau=/var/lib/storage/.restauration
rm -rf "$nouveau"
mkdir -p "$nouveau"
tar -C "$nouveau" --numeric-owner -xzf "$dossier/stockage.tar.gz"
find /var/lib/storage -mindepth 1 -maxdepth 1 ! -name .restauration -exec rm -rf {} +
find "$nouveau" -mindepth 1 -maxdepth 1 -exec mv {} /var/lib/storage/ \;
rmdir "$nouveau"

echo "OK : sauvegarde $nom restauree."
sed -n 's/^date=/     Date de la sauvegarde : /p; s/^fichiers_par_bucket=/     Fichiers : /p' "$dossier/infos.txt" 2>/dev/null || true

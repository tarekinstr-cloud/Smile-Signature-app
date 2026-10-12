#!/usr/bin/env bash
# Charge dans la base locale la configuration lue en ligne par importer-en-ligne.mjs (IMPORTER-DEPUIS-EN-LIGNE.bat).
# Usage : importer <dossier>     (dans /kit : fichiers <table>.ndjson, une ligne JSON par ligne de table)
# Tout se fait en une transaction (importer.sql) : en cas d'erreur, la base n'est pas modifiée.
set -euo pipefail
dossier="/kit/${1:?dossier de l import manquant}"
[ -d "$dossier" ] || { echo "ERREUR : dossier $dossier introuvable."; exit 1; }
export PGUSER=supabase_admin
pg_isready -h db -U postgres -t 60 >/dev/null || { echo "ERREUR : la base ne repond pas."; exit 1; }

pre=/tmp/import-fichiers.sql
: > "$pre"
for f in "$dossier"/*.ndjson; do
  [ -e "$f" ] || continue
  t="$(basename "$f" .ndjson)"
  [[ "$t" =~ ^[a-z_]+$ ]] || continue
  # Une ligne du fichier = un objet JSON entier (format csv avec des séparateurs qui n'apparaissent jamais en JSON).
  echo "\\copy _in_$t (j) from '$f' with (format csv, quote e'\\x01', delimiter e'\\x02')" >> "$pre"
  echo "insert into _presentes values ('$t');" >> "$pre"
done
psql -d postgres -v ON_ERROR_STOP=1 -q -tA -v pre="$pre" -f "$(dirname "$0")/importer.sql"

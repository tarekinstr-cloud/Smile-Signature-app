#!/usr/bin/env bash
# Sauvegarde complète : base (pg_dump compressé) + fichiers du stockage (photos des plats, fonds de salle).
# Usage : sauvegarder <nom-du-dossier>     (créé dans /kit/sauvegardes, c.-à-d. serveur-local\sauvegardes)
# Le dossier est d'abord écrit sous le nom <nom>.en-cours, puis renommé seulement si tout a réussi :
# un dossier sans « .en-cours » est toujours une sauvegarde complète et relue.
set -euo pipefail
nom="${1:?nom du dossier de sauvegarde manquant}"
case "$nom" in */*|.*) echo "ERREUR : nom de sauvegarde invalide : $nom"; exit 1 ;; esac
racine=/kit/sauvegardes
final="$racine/$nom"
tmp="$final.en-cours"
[ -e "$final" ] && { echo "ERREUR : la sauvegarde $nom existe deja."; exit 1; }
mkdir -p "$racine"
rm -rf "$tmp"
mkdir -p "$tmp"
trap 'rm -rf "$tmp"' EXIT

# supabase_admin : seul rôle qui peut tout lire (schémas auth, storage…). Même mot de passe que la base.
export PGUSER=supabase_admin

pg_isready -h db -U postgres -t 60 >/dev/null || { echo "ERREUR : la base ne repond pas."; exit 1; }

echo "Base de donnees..."
pg_dump -Fc -Z 6 -d postgres -f "$tmp/base.dump"
# Relecture : l'archive doit être lisible en entier.
pg_restore -l "$tmp/base.dump" > /dev/null || { echo "ERREUR : archive de la base illisible."; exit 1; }

echo "Photos et fonds de salle (stockage)..."
if [ -d /var/lib/storage ]; then
  tar -C /var/lib/storage --numeric-owner -czf "$tmp/stockage.tar.gz" .
  tar -tzf "$tmp/stockage.tar.gz" > /dev/null || { echo "ERREUR : archive du stockage illisible."; exit 1; }
else
  echo "ERREUR : dossier du stockage introuvable (/var/lib/storage)."; exit 1
fi

taille() { du -k "$1" | cut -f1; }
version="$(curl -s -m 5 http://web/version.json 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
{
  echo "date=$(date '+%Y-%m-%d %H:%M:%S')"
  echo "epoch=$(date +%s)"
  echo "version_app=${version:-inconnue}"
  echo "migrations=$(psql -d postgres -tAc 'select count(*) from serveur_local.migrations' 2>/dev/null || echo 0)"
  echo "derniere_migration=$(psql -d postgres -tAc 'select max(fichier) from serveur_local.migrations' 2>/dev/null)"
  echo "derniere_cloture=$(psql -d postgres -tAc "select coalesce(to_char(max(closed_at), 'YYYY-MM-DD HH24:MI'), '') from public.cash_days" 2>/dev/null)"
  echo "fichiers_par_bucket=$(psql -d postgres -tAc "select coalesce(string_agg(b.id || ':' || (select count(*) from storage.objects o where o.bucket_id = b.id), ' ' order by b.id), '') from storage.buckets b" 2>/dev/null)"
  echo "base_ko=$(taille "$tmp/base.dump")"
  echo "stockage_ko=$(taille "$tmp/stockage.tar.gz")"
} > "$tmp/infos.txt"

mv "$tmp" "$final"
trap - EXIT
echo "OK : sauvegarde $nom ($(( $(taille "$final/base.dump") + $(taille "$final/stockage.tar.gz") )) Ko)"
sed -n 's/^fichiers_par_bucket=/     Fichiers : /p; s/^derniere_cloture=\(..*\)/     Derniere cloture de caisse : \1/p' "$final/infos.txt"

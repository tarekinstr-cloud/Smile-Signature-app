#!/usr/bin/env bash
# Point d'entrée de la boîte à outils : outil.sh <commande> [arguments]
set -euo pipefail
cmd="${1:-aide}"
shift || true
here="$(dirname "$0")"
case "$cmd" in
  attendre)     exec bash "$here/attendre.sh" "$@" ;;
  migrer)       exec bash "$here/migrer.sh" "$@" ;;
  creer-admin)  exec bash "$here/creer-admin.sh" "$@" ;;
  verifier)     exec bash "$here/verifier.sh" "$@" ;;
  sql)          exec psql -v ON_ERROR_STOP=1 "$@" ;;
  *)
    echo "Commandes : attendre | migrer | creer-admin | verifier | sql"
    exit 1 ;;
esac

#!/usr/bin/env bash
# Attend que la base, l'authentification et le stockage aient fini de démarrer (ils créent leurs tables au
# premier lancement), puis que le serveur web réponde. Délai max : $1 secondes (300 par défaut).
set -euo pipefail
max="${1:-300}"
start=$(date +%s)
waitfor() {
  local what="$1"; shift
  until "$@" >/dev/null 2>&1; do
    if [ $(( $(date +%s) - start )) -gt "$max" ]; then
      echo "ERREUR : $what ne repond pas apres ${max} s. Voir : docker compose logs"
      exit 1
    fi
    sleep 2
  done
  echo "OK : $what"
}
waitfor "base de donnees" pg_isready -h db -U postgres
waitfor "connexion a la base" psql -tAc "select 1"
waitfor "authentification (tables auth)" sh -c "psql -tAc \"select to_regclass('auth.users') is not null and to_regclass('auth.identities') is not null\" | grep -q t"
waitfor "authentification (service)" curl -sf http://auth:9999/health
waitfor "stockage (tables storage)" sh -c "psql -tAc \"select to_regclass('storage.buckets') is not null\" | grep -q t"
waitfor "stockage (service)" curl -sf http://storage:5000/status
waitfor "API REST" curl -sf -o /dev/null http://rest:3000/ -H "apikey: $ANON_KEY"
waitfor "serveur web" curl -sf http://web/healthz

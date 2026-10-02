#!/usr/bin/env bash
# État du serveur : services, base (intégrité), migrations, buckets, comptes, fonction pin-login.
set -uo pipefail
ok=1
check() {
  local what="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  OK      $what"; else echo "  ERREUR  $what"; ok=0; fi
}
echo "Services :"
check "base de donnees"     pg_isready -h db -U postgres
check "authentification"    curl -sf -m 5 http://auth:9999/health
check "API REST"            curl -sf -m 5 -o /dev/null http://rest:3000/ -H "apikey: $ANON_KEY"
check "temps reel"          curl -sf -m 5 -o /dev/null -H "Authorization: Bearer $ANON_KEY" http://realtime-dev.supabase-realtime:4000/api/tenants/realtime-dev/health
check "stockage (photos)"   curl -sf -m 5 http://storage:5000/status
check "serveur web"         curl -sf -m 5 http://web/healthz
check "application"         sh -c "curl -sf -m 5 http://web/ | grep -q '<div id=\"root\">'"
check "pin-login"           sh -c "curl -s -m 30 -X POST http://web/functions/v1/pin-login -H 'Content-Type: application/json' -d '{\"username\":\"verification\",\"pin\":\"0000\"}' | grep -Eq 'pin_bad|pin_locked|pin_disabled'"
echo "Base :"
# Intégrité : lecture complète de chaque table de l'application (une page abîmée provoque une erreur).
if psql -v ON_ERROR_STOP=1 -tAq > /tmp/verif.log 2>&1 <<'SQL'
do $$
declare r record; n bigint;
begin
  for r in select schemaname, tablename from pg_tables where schemaname in ('public', 'auth', 'storage') loop
    execute format('select count(*) from %I.%I', r.schemaname, r.tablename) into n;
  end loop;
end $$;
SQL
then echo "  OK      lecture de toutes les tables"; else echo "  ERREUR  lecture des tables :"; cat /tmp/verif.log; ok=0; fi
echo "  Migrations appliquees : $(psql -tAc 'select count(*) from serveur_local.migrations' 2>/dev/null || echo 0) / $(ls /migrations/*.sql | wc -l)"
echo "  Buckets : $(psql -tAc "select string_agg(id, ', ' order by id) from storage.buckets" 2>/dev/null)"
echo "  Administrateurs actifs : $(psql -tAc "select count(*) from public.app_users where role = 'admin' and active" 2>/dev/null || echo 0)"
echo "  Taille de la base : $(psql -tAc "select pg_size_pretty(pg_database_size('postgres'))" 2>/dev/null)"
echo "  Fuseau de la base : $(psql -tAc "show timezone" 2>/dev/null)"
if [ "$ok" = 1 ]; then echo "RESULTAT : tout fonctionne."; else echo "RESULTAT : probleme detecte (voir ERREUR ci-dessus)."; exit 1; fi

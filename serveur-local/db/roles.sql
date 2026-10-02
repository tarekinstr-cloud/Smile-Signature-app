-- Mots de passe des rôles internes de Supabase = POSTGRES_PASSWORD du fichier .env (exécuté une seule fois, à la
-- création de la base). Repris du kit officiel, sans supabase_functions_admin (webhooks non installés ici).
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER pgbouncer WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';

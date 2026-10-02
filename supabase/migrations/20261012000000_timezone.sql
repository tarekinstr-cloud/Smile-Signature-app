-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Fuseau horaire Africa/Algiers (UTC+1) pour la base (à exécuter après 20261011000000_cashier_name.sql).
-- À exécuter à la main dans Supabase > SQL Editor.
--
-- • La base calcule ses dates du jour (current_date, date_trunc, ::date) en heure d'Alger et non plus en UTC :
--   entre minuit et 1 h du matin, une avance sur salaire, une facture ou un règlement fournisseur saisi sans date
--   tombe bien sur le jour d'Alger.
-- • Les dates par défaut des tables (avances, factures, règlements et retours fournisseurs) utilisent local_today().
-- • server_now() reste l'heure de référence de l'app (les appareils corrigent leur décalage d'horloge avec elle).
-- • Les heures enregistrées ne changent pas : ce sont des instants absolus (timestamptz).
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.local_today() returns date
language sql stable as $$ select (now() at time zone 'Africa/Algiers')::date $$;

-- Fuseau des sessions de la base et des rôles utilisés par l'app (API Supabase, tableau de bord SQL).
do $$
begin
  execute format('alter database %I set timezone to %L', current_database(), 'Africa/Algiers');
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'alter role authenticated set timezone to ''Africa/Algiers''';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter role anon set timezone to ''Africa/Algiers''';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'alter role service_role set timezone to ''Africa/Algiers''';
  end if;
end $$;

-- Dates par défaut : jour d'Alger, quel que soit le fuseau de la session.
do $$
declare
  r record;
begin
  for r in
    select c.table_name, c.column_name
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.data_type = 'date'
       and c.column_default ilike '%current_date%'
  loop
    execute format('alter table public.%I alter column %I set default public.local_today()', r.table_name, r.column_name);
  end loop;
end $$;

notify pgrst, 'reload schema';

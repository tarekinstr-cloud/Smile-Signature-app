-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Nombre de personnes pour À emporter et Livraison (à exécuter après 20261003000000_takeaway_board.sql).
-- À exécuter à la main dans Supabase > SQL Editor.
--
-- • orders.guests (créé par 20261002000000_floor_visual.sql) sert aussi aux commandes À emporter et Livraison :
--   demandé à la création, modifiable ensuite, imprimé sur le ticket cuisine et le ticket client, compté dans les
--   statistiques (personnes servies, ticket moyen par personne).
-- • app_config : valeur proposée par défaut à la création, séparément pour À emporter et Livraison
--   (Paramètres > Configurations).
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

alter table public.app_config add column if not exists takeaway_default_guests int not null default 1;
alter table public.app_config add column if not exists delivery_default_guests int not null default 1;
alter table public.app_config drop constraint if exists app_config_default_guests;
alter table public.app_config add constraint app_config_default_guests
  check (takeaway_default_guests between 1 and 99 and delivery_default_guests between 1 and 99);

notify pgrst, 'reload schema';

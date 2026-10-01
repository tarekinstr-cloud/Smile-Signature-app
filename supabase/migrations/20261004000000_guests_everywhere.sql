-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Nombre de personnes pour À emporter et Livraison (normalement après 20261003000000_takeaway_board.sql).
-- À exécuter à la main dans Supabase > SQL Editor.
--
-- • orders.guests (aussi créé par 20261002000000_floor_visual.sql) sert aux commandes À emporter et Livraison :
--   demandé à la création, modifiable ensuite, imprimé sur le ticket cuisine et le ticket client, compté dans les
--   statistiques (personnes servies, ticket moyen par personne).
-- • app_config : valeur proposée par défaut à la création, séparément pour À emporter et Livraison
--   (Paramètres > Configurations).
-- • Autonome : crée app_config et orders.guests s'ils n'existent pas encore (si 20261002000000_floor_visual.sql n'a
--   pas été exécuté). Les autres fonctions du plan de salle visuel et des cartes À emporter demandent toujours
--   20261002000000_floor_visual.sql et 20261003000000_takeaway_board.sql.
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- ───────────── Nombre de personnes d'une commande ─────────────

alter table public.orders add column if not exists guests integer;
alter table public.orders drop constraint if exists orders_guests_check;
alter table public.orders add constraint orders_guests_check check (guests is null or guests between 1 and 99);

-- ───────────── Configurations (créée ici si 20261002000000_floor_visual.sql n'a pas été exécuté) ─────────────

create table if not exists public.app_config (
  id               int primary key default 1 check (id = 1),
  timer_warn_min   int not null default 15 check (timer_warn_min between 1 and 600),
  timer_alert_min  int not null default 30 check (timer_alert_min between 2 and 600),
  updated_at       timestamptz not null default now(),
  constraint app_config_timer_order check (timer_alert_min > timer_warn_min)
);
insert into public.app_config (id) values (1) on conflict (id) do nothing;

alter table public.app_config enable row level security;
drop policy if exists "read app_config" on public.app_config;
create policy "read app_config" on public.app_config for select to authenticated using (true);
drop policy if exists "settings write app_config" on public.app_config;
create policy "settings write app_config" on public.app_config for update to authenticated
  using (public.has_permission('settings')) with check (public.has_permission('settings'));
grant select, update on public.app_config to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_config') then
    alter publication supabase_realtime add table public.app_config;
  end if;
end $$;

-- ───────────── Nombre de personnes par défaut ─────────────

alter table public.app_config add column if not exists takeaway_default_guests int not null default 1;
alter table public.app_config add column if not exists delivery_default_guests int not null default 1;
alter table public.app_config drop constraint if exists app_config_default_guests;
alter table public.app_config add constraint app_config_default_guests
  check (takeaway_default_guests between 1 and 99 and delivery_default_guests between 1 and 99);

notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- À emporter et Livraison : numéro du client / de la livraison choisi à la création
-- (à exécuter après 20261005000000_takeaway_delivery_floor.sql). À exécuter à la main dans Supabase > SQL Editor.
--
-- • Le n° (orders.takeaway_no / orders.delivery_no) est choisi à la création dans une grille ou au clavier ; il
--   remplace la numérotation automatique E 1, E 2… / L 1, L 2… (gardée seulement si aucun numéro n'est donné).
-- • Plages réglables séparément (Paramètres > Configurations), pour ne jamais confondre les deux modes :
--   app_config.takeaway_number_min/max (1 à 40 par défaut) et delivery_number_min/max (41 à 60 par défaut).
-- • Un numéro est « en cours » :
--     À emporter : commande ouverte, ou payée mais pas encore remise au client ;
--     Livraison  : commande ouverte, ou payée mais pas encore livrée.
--   Index uniques partiels : deux commandes en cours du même mode ne peuvent pas avoir le même numéro, même si deux
--   appareils le choisissent en même temps (erreurs orders_takeaway_number_in_use / orders_delivery_number_in_use →
--   « Numéro déjà utilisé »). Le numéro redevient libre tout seul quand la commande est remise (ou livrée) et payée,
--   ou annulée.
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- ───────────── Plages de numéros ─────────────

alter table public.app_config add column if not exists takeaway_number_min int not null default 1;
alter table public.app_config add column if not exists takeaway_number_max int not null default 40;
alter table public.app_config add column if not exists delivery_number_min int not null default 41;
alter table public.app_config add column if not exists delivery_number_max int not null default 60;
alter table public.app_config drop constraint if exists app_config_number_ranges;
alter table public.app_config add constraint app_config_number_ranges check (
  takeaway_number_min between 1 and 9999 and takeaway_number_max between takeaway_number_min and 9999
  and takeaway_number_max - takeaway_number_min < 500
  and delivery_number_min between 1 and 9999 and delivery_number_max between delivery_number_min and 9999
  and delivery_number_max - delivery_number_min < 500);

-- ───────────── Numéros choisis ─────────────

-- Un n° choisi peut revenir dans la journée (une fois libéré) : plus d'unicité par journée.
drop index if exists public.orders_takeaway_no_per_period;
drop index if exists public.orders_delivery_no_per_period;

alter table public.orders drop constraint if exists orders_order_no_range;
alter table public.orders add constraint orders_order_no_range check (
  (takeaway_no is null or takeaway_no between 1 and 9999) and (delivery_no is null or delivery_no between 1 and 9999)) not valid;

-- Anciennes commandes en cours avec le même n° automatique (ex. une commande d'hier jamais clôturée) : la plus
-- récente garde son numéro, les autres reçoivent un numéro libre à partir de 9000 (signalé ci-dessous).
do $$
declare
  r record;
  v_next int;
  v_keep boolean := exists (select 1 from pg_trigger where tgname = 'orders_keep_number' and tgrelid = 'public.orders'::regclass);
begin
  if v_keep then
    alter table public.orders disable trigger orders_keep_number;
  end if;
  v_next := greatest(9000, (select coalesce(max(takeaway_no), 0) + 1 from public.orders where takeaway_no >= 9000));
  for r in
    select id, takeaway_no from (
      select id, takeaway_no, row_number() over (partition by takeaway_no order by created_at desc) as rn
        from public.orders
       where order_type = 'takeaway' and takeaway_no is not null
         and (status = 'open' or (status = 'paid' and pickup_status in ('preparing', 'ready')))
    ) x where rn > 1
  loop
    update public.orders set takeaway_no = v_next where id = r.id;
    raise notice 'Commande à emporter % : n° % déjà utilisé, renuméroté %', r.id, r.takeaway_no, v_next;
    v_next := v_next + 1;
  end loop;
  v_next := greatest(9000, (select coalesce(max(delivery_no), 0) + 1 from public.orders where delivery_no >= 9000));
  for r in
    select id, delivery_no from (
      select id, delivery_no, row_number() over (partition by delivery_no order by created_at desc) as rn
        from public.orders
       where order_type = 'delivery' and delivery_no is not null
         and (status = 'open' or (status = 'paid' and delivery_status is distinct from 'delivered'))
    ) x where rn > 1
  loop
    update public.orders set delivery_no = v_next where id = r.id;
    raise notice 'Livraison % : n° % déjà utilisé, renuméroté %', r.id, r.delivery_no, v_next;
    v_next := v_next + 1;
  end loop;
  if v_keep then
    alter table public.orders enable trigger orders_keep_number;
  end if;
end $$;

create unique index if not exists orders_takeaway_number_in_use on public.orders (takeaway_no)
  where order_type = 'takeaway' and takeaway_no is not null
    and (status = 'open' or (status = 'paid' and pickup_status in ('preparing', 'ready')));

create unique index if not exists orders_delivery_number_in_use on public.orders (delivery_no)
  where order_type = 'delivery' and delivery_no is not null
    and (status = 'open' or (status = 'paid' and delivery_status is distinct from 'delivered'));

-- Livraisons payées pas encore livrées : elles restent dans la vue Livraison.
create index if not exists orders_delivery_waiting on public.orders (closed_at)
  where order_type = 'delivery' and status = 'paid' and delivery_status is distinct from 'delivered';

notify pgrst, 'reload schema';

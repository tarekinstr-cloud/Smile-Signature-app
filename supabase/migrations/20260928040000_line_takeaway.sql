-- Smile Signature: « Sur place / À emporter » par article.
-- Un client à table peut emporter un article (ex. un tacos) sans que la commande quitte sa table:
-- le marquage est sur la ligne (order_items.is_takeaway), orders.table_id et orders.order_type ne changent pas.
-- Idempotent: peut être exécuté plusieurs fois.

alter table public.order_items
  add column if not exists is_takeaway boolean not null default false;

-- Lignes créées avant cette colonne (au cas où elle aurait existé sans défaut).
update public.order_items set is_takeaway = false where is_takeaway is null;
alter table public.order_items alter column is_takeaway set default false;
alter table public.order_items alter column is_takeaway set not null;

comment on column public.order_items.is_takeaway is
  'Article à emporter (boîte/sac) dans une commande sur place; indépendant de orders.order_type et de table_id.';

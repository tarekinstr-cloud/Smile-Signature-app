-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Paramètres > Configurations : onglets Restaurant et Ticket (à exécuter après 20261006000000_order_numbers_chosen.sql).
-- À exécuter à la main dans Supabase > SQL Editor.
--
-- receipt_settings (une seule ligne, id = 1) reçoit :
--   Restaurant : address, phone, nif, rc, nis, ai (identifiants fiscaux, imprimés sur tickets et factures).
--   Ticket     : paper_width (58 ou 80 mm), ticket_lang ('fr' / 'ar' ; null : langue de l'appareil),
--                show_waiter (nom du serveur), show_table (N° de table / place).
-- Écriture : permission « settings » (Admin par défaut, Fichier > Permissions) ou Admin.
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

alter table public.receipt_settings add column if not exists address text not null default '';
alter table public.receipt_settings add column if not exists phone text not null default '';
alter table public.receipt_settings add column if not exists nif text not null default '';
alter table public.receipt_settings add column if not exists rc text not null default '';
alter table public.receipt_settings add column if not exists nis text not null default '';
alter table public.receipt_settings add column if not exists ai text not null default '';
alter table public.receipt_settings add column if not exists paper_width int not null default 80;
alter table public.receipt_settings add column if not exists ticket_lang text;
alter table public.receipt_settings add column if not exists show_waiter boolean not null default true;
alter table public.receipt_settings add column if not exists show_table boolean not null default true;

alter table public.receipt_settings drop constraint if exists receipt_settings_ticket_check;
alter table public.receipt_settings add constraint receipt_settings_ticket_check check (
  paper_width in (58, 80) and (ticket_lang is null or ticket_lang in ('fr', 'ar'))
  and length(address) <= 300 and length(phone) <= 60
  and length(nif) <= 40 and length(rc) <= 40 and length(nis) <= 40 and length(ai) <= 40);

insert into public.receipt_settings (id) values (1) on conflict (id) do nothing;

drop policy if exists "admin write receipt_settings" on public.receipt_settings;
drop policy if exists "admin update receipt_settings" on public.receipt_settings;
create policy "admin write receipt_settings" on public.receipt_settings for insert to authenticated
  with check (public.is_app_admin() or public.has_permission('settings'));
create policy "admin update receipt_settings" on public.receipt_settings for update to authenticated
  using (public.is_app_admin() or public.has_permission('settings'))
  with check (public.is_app_admin() or public.has_permission('settings'));

notify pgrst, 'reload schema';

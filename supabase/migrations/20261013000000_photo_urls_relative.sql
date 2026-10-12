-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Serveur local : adresses des photos et fonds de salle relatives (à exécuter après 20261012000000_timezone.sql).
-- Appliquée automatiquement par le serveur local (METTRE-A-JOUR.bat) ; sans effet sur le Supabase en ligne.
--
-- • Sur le serveur local, une photo ajoutée depuis l'application était enregistrée avec l'adresse de l'appareil
--   utilisé : http://localhost/storage/v1/... depuis le POS (illisible sur les tablettes), ou
--   http://192.168.1.x/storage/v1/... depuis une tablette (illisible si l'adresse du POS change). L'application
--   enregistre maintenant /storage/v1/... ; cette migration corrige les photos déjà enregistrées.
-- • Seules les adresses en http:// qui pointent vers le stockage sont modifiées. Celles du Supabase en ligne
--   (https://xxxx.supabase.co/...) ne changent pas.
--
-- Idempotent : peut être exécuté plusieurs fois.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

update public.items
   set photo_url = regexp_replace(photo_url, '^http://[^/]+(/storage/v1/)', '\1')
 where photo_url ~ '^http://[^/]+/storage/v1/';

update public.halls
   set background_url = regexp_replace(background_url, '^http://[^/]+(/storage/v1/)', '\1')
 where background_url ~ '^http://[^/]+/storage/v1/';

update public.app_config
   set takeaway_background_url = regexp_replace(takeaway_background_url, '^http://[^/]+(/storage/v1/)', '\1'),
       delivery_background_url = regexp_replace(delivery_background_url, '^http://[^/]+(/storage/v1/)', '\1')
 where takeaway_background_url ~ '^http://[^/]+/storage/v1/'
    or delivery_background_url ~ '^http://[^/]+/storage/v1/';

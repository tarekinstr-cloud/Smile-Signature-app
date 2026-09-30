-- Smile Signature: réservations « Confirmée » dépassées → « No-show » automatiquement
-- Idempotent: peut être exécuté plusieurs fois sans problème.
-- À exécuter après 20260930020000_honor_reservation.sql.
--
-- Une réservation encore « Confirmée » plus d'1 heure après son heure (ni Honorée ni Annulée) passe en « No-show ».
-- L'app appelle expire_reservations() à chaque lecture des réservations (plan de salle, liste) ; l'exécution de ce
-- fichier corrige aussi tout de suite les réservations déjà dépassées.

create or replace function public.expire_reservations()
returns integer
language sql security definer set search_path = public as $$
  with expired as (
    update public.reservations
       set status = 'no_show'
     where status = 'confirmed' and reserved_at < now() - interval '1 hour'
    returning 1
  )
  select count(*)::integer from expired
$$;
revoke all on function public.expire_reservations() from public, anon;
grant execute on function public.expire_reservations() to authenticated;

select public.expire_reservations() as reservations_passees_en_no_show;

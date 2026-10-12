-- Chargement de la configuration lue en ligne (fichiers NDJSON de importer-en-ligne.mjs) dans la base locale.
-- Lancé par importer.sh (psql, rôle supabase_admin), variable :pre = fichier des \copy généré par importer.sh.
--
-- Règles :
--   - tout se fait dans UNE transaction : en cas d'erreur, rien n'est modifié ;
--   - identifiants (UUID) conservés : ajout ou mise à jour sur la clé primaire, donc relançable sans doublon ;
--   - déclencheurs coupés pendant le chargement (session_replication_role = replica) : pas d'historique de prix,
--     pas de mouvement de stock « stock initial », etc. Les liens sont vérifiés à la fin ;
--   - même nom qu'une ligne locale avec un autre identifiant (ex. imprimantes créées par les migrations) : la
--     ligne locale est fusionnée dans celle d'en ligne (ses liens sont repointés) ;
--   - quantités en stock et état des tables (libre / occupée) : jamais copiés (ce sont des données de test) ;
--   - comptes : l'administrateur local et tout compte local ne sont jamais modifiés ; un employé en ligne dont le
--     nom ou l'e-mail est déjà pris en local est ignoré (affiché dans le résumé).
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set search_path = public, extensions;

begin;
set local session_replication_role = replica;

create temp table _presentes (t text primary key);
create temp table _resume (ordre serial, t text, en_ligne bigint, ajoutes bigint, modifies bigint, fusionnes int, note text,
                           supprimes bigint default 0, conserves bigint default 0);
create temp table _ignores (id uuid, nom text, raison text);

create temp table _in_halls (j jsonb);
create temp table _in_tables (j jsonb);
create temp table _in_printers (j jsonb);
create temp table _in_categories (j jsonb);
create temp table _in_category_printers (j jsonb);
create temp table _in_items (j jsonb);
create temp table _in_option_groups (j jsonb);
create temp table _in_options (j jsonb);
create temp table _in_delivery_zones (j jsonb);
create temp table _in_app_config (j jsonb);
create temp table _in_receipt_settings (j jsonb);
create temp table _in_payment_modes (j jsonb);
create temp table _in_expense_categories (j jsonb);
create temp table _in_role_permissions (j jsonb);
create temp table _in_app_users (j jsonb);
create temp table _in_user_permissions (j jsonb);
create temp table _in_user_pins (j jsonb);
create temp table _in_stock_items (j jsonb);
create temp table _in_recipe_lines (j jsonb);
create temp table _in_auth_users (j jsonb);

-- \copy de chaque fichier présent + insert into _presentes (généré par importer.sh).
\i :pre

-- ---------------------------------------------------------------------------------------------------------------
-- Même clé naturelle (nom…) qu'une ligne locale d'un autre identifiant : on libère la place.
--   ligne locale absente de l'import -> fusionnée : ses liens pointent vers la ligne d'en ligne, puis supprimée ;
--   ligne locale aussi dans l'import (noms échangés) -> renommée provisoirement (ou supprimée si pas de nom),
--   l'import lui redonne ensuite ses vraies valeurs.
-- ---------------------------------------------------------------------------------------------------------------
create function pg_temp.liberer(t text, condition text, libre text) returns int language plpgsql as $f$
declare
  r record;
  fk record;
  n int := 0;
begin
  for r in execute format($q$
      select l.id as ancien, (s.j->>'id')::uuid as nouveau,
             exists (select 1 from %2$I s2 where (s2.j->>'id')::uuid = l.id) as dans_import
        from public.%1$I l join %2$I s on (%3$s)
       where l.id <> (s.j->>'id')::uuid$q$, t, '_in_' || t, condition)
  loop
    n := n + 1;
    if r.dans_import and libre is not null then
      execute format('update public.%1$I set %2$I = %2$I || %3$L where id = $1', t, libre, ' ~' || left(r.ancien::text, 8))
        using r.ancien;
    elsif r.dans_import then
      execute format('delete from public.%I where id = $1', t) using r.ancien;
    else
      for fk in
        select c.conrelid::regclass as enfant, a.attname as col
          from pg_constraint c
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
         where c.contype = 'f' and c.confrelid = ('public.' || t)::regclass and array_length(c.conkey, 1) = 1
      loop
        begin
          execute format('update %s set %I = $1 where %I = $2', fk.enfant, fk.col, fk.col) using r.nouveau, r.ancien;
        exception when unique_violation then
          -- Lien en double (ex. catégorie déjà reliée à l'imprimante d'en ligne) : l'ancien est retiré.
          execute format('delete from %s where %I = $1', fk.enfant, fk.col) using r.ancien;
        end;
      end loop;
      execute format('delete from public.%I where id = $1', t) using r.ancien;
    end if;
  end loop;
  return n;
end $f$;

-- ---------------------------------------------------------------------------------------------------------------
-- Ajout / mise à jour d'une table sur sa clé primaire. Seules les colonnes présentes à la fois en ligne et en local
-- sont écrites ; les colonnes de « garder » ne sont jamais modifiées sur une ligne locale existante.
-- ---------------------------------------------------------------------------------------------------------------
create function pg_temp.importer(t text, garder text[] default '{}', fusionnes int default 0) returns void
language plpgsql as $f$
declare
  cols text[];
  pk text[];
  maj text;
  n_ligne bigint;
  n_ajout bigint := 0;
  n_maj bigint := 0;
begin
  if not exists (select 1 from _presentes where _presentes.t = importer.t) then
    insert into _resume (t, en_ligne, ajoutes, modifies, fusionnes, note) values (t, null, 0, 0, 0, 'absente en ligne');
    return;
  end if;
  execute format('select count(*) from %I', '_in_' || t) into n_ligne;
  execute format($q$
    select array_agg(a.attname::text order by a.attnum)
      from pg_attribute a
     where a.attrelid = 'public.%1$I'::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
       and a.attname in (select distinct jsonb_object_keys(j) from %2$I)$q$, t, '_in_' || t) into cols;
  select array_agg(a.attname::text) into pk
    from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
   where i.indrelid = ('public.' || t)::regclass and i.indisprimary;
  if cols is not null and n_ligne > 0 then
    select string_agg(format('%1$I = excluded.%1$I', c), ', ') into maj
      from unnest(cols) c where c <> all(pk) and c <> all(garder);
    execute format($q$
      with up as (
        insert into public.%1$I (%2$s)
        select %3$s from %4$I s, jsonb_populate_record(null::public.%1$I, s.j) r
        on conflict (%5$s) do %6$s
        returning (xmax = 0) as ajout)
      select count(*) filter (where ajout), count(*) filter (where not ajout) from up$q$,
      t,
      (select string_agg(quote_ident(c), ', ') from unnest(cols) c),
      (select string_agg('r.' || quote_ident(c), ', ') from unnest(cols) c),
      '_in_' || t,
      (select string_agg(quote_ident(c), ', ') from unnest(pk) c),
      case when maj is null then 'nothing' else 'update set ' || maj end)
      into n_ajout, n_maj;
  end if;
  insert into _resume (t, en_ligne, ajoutes, modifies, fusionnes) values (t, n_ligne, n_ajout, n_maj, fusionnes);
end $f$;

-- ---------------------------------------------------------------------------------------------------------------
-- Lignes locales absentes en ligne (ex. exemples créés par les migrations, élément supprimé en ligne) : supprimées,
-- sauf si une autre table les utilise encore (commande, mouvement de stock…) : elles sont alors conservées.
-- Jamais pour une table absente en ligne.
-- ---------------------------------------------------------------------------------------------------------------
create function pg_temp.elaguer(t text) returns void language plpgsql as $f$
declare
  pk text[];
  dans_import text;
  utilise text;
  n_sup bigint;
  n_gardes bigint;
begin
  if not exists (select 1 from _presentes where _presentes.t = elaguer.t) then return; end if;
  select array_agg(a.attname::text) into pk
    from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
   where i.indrelid = ('public.' || t)::regclass and i.indisprimary;
  select string_agg(format('s.j->>%L = l.%I::text', c, c), ' and ') into dans_import from unnest(pk) c;
  select string_agg(format('exists (select 1 from %s e where e.%I = l.%I)', c.conrelid::regclass, a.attname, pa.attname), ' or ')
    into utilise
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
   where c.contype = 'f' and c.confrelid = ('public.' || t)::regclass and array_length(c.conkey, 1) = 1;
  execute format('with sup as (delete from public.%1$I l where not exists (select 1 from %2$I s where %3$s) and not (%4$s) returning 1)
                  select count(*) from sup', t, '_in_' || t, dans_import, coalesce(utilise, 'false')) into n_sup;
  execute format('select count(*) from public.%1$I l where not exists (select 1 from %2$I s where %3$s)',
                 t, '_in_' || t, dans_import) into n_gardes;
  update _resume set supprimes = n_sup, conserves = n_gardes where _resume.t = elaguer.t;
end $f$;

-- ---- Données de test jamais copiées, même dans les tables de configuration ----
update _in_tables set j = j || '{"status": "free"}';
update _in_stock_items set j = j || '{"quantity": 0, "kitchen_quantity": 0}';
update _in_user_pins set j = j || '{"failed": 0, "locked_until": null}';

-- ---- Salles et plan ----
select pg_temp.importer('halls');
select pg_temp.importer('tables', '{status}',
  pg_temp.liberer('tables', 'l.hall_id = (s.j->>''hall_id'')::uuid and l.label = s.j->>''label''', 'label'));

-- ---- Imprimantes, catégories et liaisons, articles, options ----
select pg_temp.importer('printers', '{}',
  pg_temp.liberer('printers', 'lower(trim(l.name)) = lower(trim(s.j->>''name''))', 'name'));
select pg_temp.importer('categories');
select pg_temp.importer('category_printers');
select pg_temp.importer('items');
select pg_temp.importer('option_groups');
select pg_temp.importer('options');

-- ---- Livraison et paramètres ----
select pg_temp.importer('delivery_zones', '{}',
  pg_temp.liberer('delivery_zones', 'lower(trim(l.name)) = lower(trim(s.j->>''name''))', 'name'));
select pg_temp.importer('app_config');
select pg_temp.importer('receipt_settings');
select pg_temp.importer('payment_modes');
select pg_temp.importer('expense_categories', '{}',
  pg_temp.liberer('expense_categories', 'lower(trim(l.name)) = lower(trim(s.j->>''name''))', 'name'));
select pg_temp.importer('role_permissions');

-- ---- Employés, comptes de connexion, permissions, codes PIN ----
-- Ignorés : nom d'utilisateur ou e-mail déjà pris par un AUTRE compte local (ex. l'administrateur local), compte
-- de connexion introuvable en ligne, compte sans e-mail.
insert into _ignores
select (s.j->>'user_id')::uuid, s.j->>'username', 'nom deja utilise par un compte local'
  from _in_app_users s
  join public.app_users a on lower(a.username) = lower(s.j->>'username') and a.user_id <> (s.j->>'user_id')::uuid;
insert into _ignores
select (s.j->>'user_id')::uuid, s.j->>'username', 'e-mail deja utilise par un compte local'
  from _in_app_users s
  join _in_auth_users u on u.j->>'id' = s.j->>'user_id'
  join auth.users l on lower(l.email) = lower(u.j->>'email') and l.id <> (u.j->>'id')::uuid
 where (s.j->>'user_id')::uuid not in (select id from _ignores);
insert into _ignores
select (s.j->>'user_id')::uuid, s.j->>'username', 'compte de connexion introuvable en ligne'
  from _in_app_users s
 where not exists (select 1 from _in_auth_users u where u.j->>'id' = s.j->>'user_id' and coalesce(u.j->>'email', '') <> '')
   and not exists (select 1 from auth.users l where l.id = (s.j->>'user_id')::uuid)
   and (s.j->>'user_id')::uuid not in (select id from _ignores);
delete from _in_app_users where (j->>'user_id')::uuid in (select id from _ignores);
delete from _in_auth_users u where not exists (select 1 from _in_app_users s where s.j->>'user_id' = u.j->>'id');
delete from _in_user_permissions p where not exists (select 1 from _in_app_users s where s.j->>'user_id' = p.j->>'user_id');
delete from _in_user_pins p where not exists (select 1 from _in_app_users s where s.j->>'user_id' = p.j->>'user_id');

-- Comptes de connexion manquants : même identifiant et même e-mail qu'en ligne, mot de passe aléatoire
-- inutilisable (les mots de passe ne sont pas lisibles en ligne). Un compte local existant n'est jamais modifié.
with nouveaux as (
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change)
  select '00000000-0000-0000-0000-000000000000', (u.j->>'id')::uuid, 'authenticated', 'authenticated', u.j->>'email',
         crypt(gen_random_uuid()::text, gen_salt('bf')), now(),
         coalesce(nullif(u.j->'app_metadata', '{}'::jsonb), '{"provider": "email", "providers": ["email"]}'::jsonb),
         coalesce(u.j->'user_metadata', '{}'::jsonb), coalesce((u.j->>'created_at')::timestamptz, now()), now(),
         '', '', '', ''
    from _in_auth_users u
   where not exists (select 1 from auth.users l where l.id = (u.j->>'id')::uuid)
  returning id)
insert into _resume (t, en_ligne, ajoutes, modifies, fusionnes)
select 'comptes de connexion', (select count(*) from _in_auth_users), count(*), 0, 0 from nouveaux;
insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id::text, u.id,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), 'email', now(), now(), now()
  from auth.users u
 where u.id in (select (j->>'id')::uuid from _in_auth_users)
   and not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email');

select pg_temp.importer('app_users');
select pg_temp.importer('user_permissions');
select pg_temp.importer('user_pins');

-- ---- Stock (articles, sans les quantités) et fiches techniques ----
select pg_temp.importer('stock_items', '{quantity,kitchen_quantity}',
  pg_temp.liberer('stock_items', 'lower(trim(l.name)) = lower(trim(s.j->>''name''))', 'name'));
select pg_temp.importer('recipe_lines', '{}',
  pg_temp.liberer('recipe_lines', $c$l.item_id = (s.j->>'item_id')::uuid
    and coalesce(l.option_id, '00000000-0000-0000-0000-000000000000') = coalesce((s.j->>'option_id')::uuid, '00000000-0000-0000-0000-000000000000')
    and l.stock_item_id = (s.j->>'stock_item_id')::uuid$c$, null));

-- ---- Nettoyage des lignes locales absentes en ligne (enfants d'abord) ----
-- Jamais : comptes, permissions, codes PIN, réglages généraux, modes de paiement, permissions des rôles.
select pg_temp.elaguer(t) from unnest(array['recipe_lines', 'stock_items', 'category_printers', 'options', 'option_groups',
  'items', 'categories', 'printers', 'tables', 'halls', 'delivery_zones', 'expense_categories']) as t;

-- ---- Adresses des photos : relatives au serveur (/storage/v1/...) au lieu de https://xxxx.supabase.co/... ----
-- Valables sur le POS comme sur les tablettes, quelle que soit l'adresse utilisée pour ouvrir l'application.
update public.items set photo_url = regexp_replace(photo_url, '^https?://[^/]+(/storage/v1/)', '\1')
 where photo_url ~ '^https?://[^/]+/storage/v1/';
update public.halls set background_url = regexp_replace(background_url, '^https?://[^/]+(/storage/v1/)', '\1')
 where background_url ~ '^https?://[^/]+/storage/v1/';
update public.app_config
   set takeaway_background_url = regexp_replace(takeaway_background_url, '^https?://[^/]+(/storage/v1/)', '\1'),
       delivery_background_url = regexp_replace(delivery_background_url, '^https?://[^/]+(/storage/v1/)', '\1')
 where takeaway_background_url ~ '^https?://[^/]+/storage/v1/' or delivery_background_url ~ '^https?://[^/]+/storage/v1/';

-- ---- Vérification des liens (les déclencheurs étaient coupés) : un lien cassé annule tout ----
do $$
declare
  fk record;
  n bigint;
  erreurs text := '';
begin
  for fk in
    select c.conrelid::regclass as enfant, a.attname as col, c.confrelid::regclass as parent, pa.attname as col_parent
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
     where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 1
  loop
    execute format('select count(*) from %s e where e.%I is not null and not exists (select 1 from %s p where p.%I = e.%I)',
                   fk.enfant, fk.col, fk.parent, fk.col_parent, fk.col) into n;
    if n > 0 then erreurs := erreurs || format(E'\n  %s.%s -> %s : %s ligne(s)', fk.enfant, fk.col, fk.parent, n); end if;
  end loop;
  if erreurs <> '' then
    raise exception 'liens casses apres import, rien n''a ete modifie :%', erreurs;
  end if;
end $$;

commit;

-- ---- Résumé ----
\echo ''
\echo 'Resume de l''import (lignes) :'
\echo '  Table                    En ligne   Ajoutees   Mises a jour   Supprimees   Total local'
select format('  %-24s %8s %10s %14s %12s %13s%s', r.t,
              coalesce(r.en_ligne::text, '-'), r.ajoutes, r.modifies, r.supprimes,
              case when r.t = 'comptes de connexion' then '' else (xpath('/row/c/text()',
                query_to_xml(format('select count(*) as c from public.%I', r.t), false, true, '')))[1]::text end,
              case when r.note is not null then '   (' || r.note || ')' else '' end
              || case when r.fusionnes > 0 then format('   (%s du meme nom fusionnee(s))', r.fusionnes) else '' end
              || case when r.conserves > 0 then format('   (%s absente(s) en ligne gardee(s) : utilisee(s) localement)', r.conserves) else '' end)
  from _resume r order by r.ordre;
select format('  ATTENTION : employe "%s" non importe : %s.', nom, raison) from _ignores order by nom;

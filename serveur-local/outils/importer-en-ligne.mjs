// Import de la configuration du Supabase en ligne vers le serveur local (IMPORTER-DEPUIS-EN-LIGNE.bat).
// Lancé dans le conteneur « importer » (node:22-alpine, déjà utilisé à l'installation) :
//   node importer-en-ligne.mjs telecharger <dossier>   lit les tables de configuration en ligne (lecture seule) et
//                                                       les écrit en NDJSON dans /kit/<dossier> ;
//   node importer-en-ligne.mjs photos                   copie les fichiers des buckets vers le stockage local.
// URL et clé service_role du projet en ligne : variables EN_LIGNE_URL et EN_LIGNE_CLE, jamais écrites sur disque.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

// Tables de configuration, dans l'ordre des liens (parents d'abord) avec leur clé primaire (tri des pages).
// Tout le reste (commandes, tickets, paiements, caisse, stock, fournisseurs, réservations, clients, dépenses…)
// n'est jamais lu.
const TABLES = [
  ['halls', 'id'], ['tables', 'id'],
  ['printers', 'id'], ['categories', 'id'], ['category_printers', 'category_id,printer_id'],
  ['items', 'id'], ['option_groups', 'id'], ['options', 'id'],
  ['delivery_zones', 'id'],
  ['app_config', 'id'], ['receipt_settings', 'id'], ['payment_modes', 'code'], ['expense_categories', 'id'],
  ['role_permissions', 'role,permission'],
  ['app_users', 'user_id'], ['user_permissions', 'user_id,permission'], ['user_pins', 'user_id'],
  ['stock_items', 'id'], ['recipe_lines', 'id'],
]
const BUCKETS = ['floor-backgrounds', 'item-photos']
const PAGE = 1000

const [, , commande, dossier] = process.argv
const enLigne = (process.env.EN_LIGNE_URL || '').trim().replace(/\/+$/, '').replace(/\/(rest|auth|storage)\/v1.*$/, '')
const cle = (process.env.EN_LIGNE_CLE || '').trim()
const local = 'http://web'
const cleLocale = process.env.SERVICE_ROLE_KEY || ''

const stop = (message) => { console.log(`ERREUR : ${message}`); process.exit(1) }
const entetes = (k) => ({ apikey: k, Authorization: `Bearer ${k}` })

function verifierCle() {
  if (!/^https?:\/\/[^/\s]+$/.test(enLigne)) stop(`adresse du projet invalide : "${enLigne}" (attendu : https://xxxx.supabase.co).`)
  if (!cle) stop('cle service_role vide.')
  if (cle.startsWith('sb_publishable_')) stop('c\'est la cle publique (publishable/anon) : il faut la cle secrete service_role.')
  const morceaux = cle.split('.')
  if (morceaux.length === 3) {
    let role = ''
    try { role = JSON.parse(Buffer.from(morceaux[1], 'base64url').toString()).role } catch { }
    if (role && role !== 'service_role') stop(`c'est la cle "${role}" : il faut la cle service_role (Project Settings > API).`)
  }
}

async function lire(url, k) {
  let r
  try { r = await fetch(url, { headers: entetes(k) }) } catch (e) { stop(`${url} injoignable (${e.cause?.code || e.message}). Internet est-il connecte ?`) }
  return r
}

async function telecharger() {
  verifierCle()
  const sortie = `/kit/${dossier}`
  rmSync(sortie, { recursive: true, force: true })
  mkdirSync(sortie, { recursive: true })

  // Accès : la clé doit pouvoir lire la configuration.
  const test = await lire(`${enLigne}/rest/v1/app_config?select=id&limit=1`, cle)
  if (test.status === 401 || test.status === 403) stop('cle refusee par le projet en ligne (verifiez la cle service_role).')
  if (!test.ok) stop(`le projet en ligne repond ${test.status} : ${(await test.text()).slice(0, 200)}`)

  console.log(`Lecture de la configuration en ligne (${enLigne}) :`)
  const comptes = {}
  for (const [table, cles] of TABLES) {
    const lignes = []
    for (let debut = 0; ; debut += PAGE) {
      const r = await lire(`${enLigne}/rest/v1/${table}?select=*&order=${cles}&limit=${PAGE}&offset=${debut}`, cle)
      if (r.status === 404) { lignes.length = 0; comptes[table] = null; break }
      if (!r.ok) stop(`lecture de ${table} : ${r.status} ${(await r.text()).slice(0, 200)}`)
      const page = await r.json()
      lignes.push(...page)
      if (page.length < PAGE) break
    }
    if (comptes[table] === null) { console.log(`  ${table.padEnd(20)} absente en ligne (ignoree)`); continue }
    writeFileSync(`${sortie}/${table}.ndjson`, lignes.map((l) => JSON.stringify(l)).join('\n') + (lignes.length ? '\n' : ''))
    comptes[table] = lignes.length
    console.log(`  ${table.padEnd(20)} ${String(lignes.length).padStart(5)} ligne(s)`)
  }

  // Comptes de connexion des employés (auth.users) : identifiant, e-mail, métadonnées. Les mots de passe ne
  // sont pas lisibles (et ne doivent pas l'être) : les employés se connectent par code PIN, ou l'administrateur
  // leur redonne un mot de passe dans l'application.
  const utilisateurs = []
  for (let page = 1; ; page++) {
    const r = await lire(`${enLigne}/auth/v1/admin/users?page=${page}&per_page=500`, cle)
    if (!r.ok) stop(`lecture des comptes : ${r.status} ${(await r.text()).slice(0, 200)}`)
    const lot = (await r.json()).users || []
    utilisateurs.push(...lot)
    if (lot.length < 500) break
  }
  const employes = new Set((comptes.app_users ? lignesDe(sortie, 'app_users') : []).map((u) => u.user_id))
  const garder = utilisateurs.filter((u) => employes.has(u.id)).map((u) => ({
    id: u.id, email: u.email, created_at: u.created_at, user_metadata: u.user_metadata || {}, app_metadata: u.app_metadata || {},
  }))
  writeFileSync(`${sortie}/auth_users.ndjson`, garder.map((l) => JSON.stringify(l)).join('\n') + (garder.length ? '\n' : ''))
  console.log(`  ${'comptes (auth)'.padEnd(20)} ${String(garder.length).padStart(5)} compte(s) d'employes`)

  // Photos : simple comptage ici (rien n'est écrit en local avant la confirmation).
  for (const b of BUCKETS) {
    const fichiers = await lister(enLigne, cle, b)
    console.log(`  ${('photos ' + b).padEnd(20)} ${String(fichiers.length).padStart(5)} fichier(s)`)
  }
}

function lignesDe(sortie, table) {
  const texte = readFileSync(`${sortie}/${table}.ndjson`, 'utf8')
  return texte.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

// Tous les fichiers d'un bucket (les dossiers sont parcourus) : [{ chemin, taille, type }].
async function lister(base, k, bucket, prefixe = '') {
  const fichiers = []
  for (let debut = 0; ; debut += PAGE) {
    let r
    try {
      r = await fetch(`${base}/storage/v1/object/list/${bucket}`, {
        method: 'POST', headers: { ...entetes(k), 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: prefixe, limit: PAGE, offset: debut, sortBy: { column: 'name', order: 'asc' } }),
      })
    } catch (e) { stop(`${base} injoignable (${e.cause?.code || e.message}).`) }
    if (r.status === 400 || r.status === 404) return fichiers // bucket absent
    if (!r.ok) stop(`liste du bucket ${bucket} : ${r.status} ${(await r.text()).slice(0, 200)}`)
    const page = await r.json()
    for (const e of page) {
      const chemin = prefixe + e.name
      if (e.id === null || !e.metadata) fichiers.push(...await lister(base, k, bucket, chemin + '/'))
      else if (e.name !== '.emptyFolderPlaceholder') fichiers.push({ chemin, taille: e.metadata.size, type: e.metadata.mimetype })
    }
    if (page.length < PAGE) break
  }
  return fichiers
}

const encoder = (chemin) => chemin.split('/').map(encodeURIComponent).join('/')

async function photos() {
  verifierCle()
  if (!cleLocale) stop('SERVICE_ROLE_KEY locale absente.')
  console.log('Photos et fonds de salle :')
  let erreurs = 0
  for (const b of BUCKETS) {
    const distants = await lister(enLigne, cle, b)
    const locaux = new Map((await lister(local, cleLocale, b)).map((f) => [f.chemin, f.taille]))
    let copies = 0, presents = 0, echecs = 0
    for (const f of distants) {
      if (locaux.get(f.chemin) === f.taille) { presents++; continue }
      try {
        const r = await fetch(`${enLigne}/storage/v1/object/${b}/${encoder(f.chemin)}`, { headers: entetes(cle) })
        if (!r.ok) throw new Error(`telechargement ${r.status}`)
        const contenu = Buffer.from(await r.arrayBuffer())
        const u = await fetch(`${local}/storage/v1/object/${b}/${encoder(f.chemin)}`, {
          method: 'POST',
          headers: { ...entetes(cleLocale), 'Content-Type': f.type || 'application/octet-stream', 'x-upsert': 'true', 'Cache-Control': 'max-age=3600' },
          body: contenu,
        })
        if (!u.ok) throw new Error(`envoi ${u.status} ${(await u.text()).slice(0, 120)}`)
        copies++
      } catch (e) {
        echecs++
        console.log(`  ERREUR ${b}/${f.chemin} : ${e.message}`)
      }
    }
    erreurs += echecs
    console.log(`  ${b.padEnd(18)} en ligne ${String(distants.length).padStart(4)}   copies ${String(copies).padStart(4)}   deja presents ${String(presents).padStart(4)}   erreurs ${echecs}`)
  }
  if (erreurs) stop(`${erreurs} fichier(s) non copie(s) : relancez l'import (les fichiers deja copies ne sont pas recopies).`)
}

if (commande === 'telecharger' && dossier) await telecharger()
else if (commande === 'photos') await photos()
else stop('usage : importer-en-ligne.mjs telecharger <dossier> | photos')

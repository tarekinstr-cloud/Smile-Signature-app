// Remplace chaque A_GENERER du fichier .env par un secret aléatoire, et fabrique ANON_KEY et SERVICE_ROLE_KEY
// (jetons JWT signés avec JWT_SECRET, valables 20 ans). Ne touche jamais un secret déjà rempli.
// Lancé par 1-INSTALLER.bat : docker compose run --rm secrets
import { createHmac, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const file = '/kit/.env'
if (!existsSync(file)) copyFileSync('/kit/.env.example', file)
// Fichier enregistré sous Windows : fins de ligne CRLF retirées.
let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

const get = (key) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim() ?? ''
const put = (key, value) => {
  const re = new RegExp(`^${key}=.*$`, 'm')
  text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\n?$/, '\n')}${key}=${value}\n`
}
const missing = (key) => !get(key) || get(key) === 'A_GENERER'
const hex = (n) => randomBytes(n).toString('hex')
const b64url = (s) => Buffer.from(s).toString('base64url')
const jwt = (role, secret) => {
  const now = Math.floor(Date.now() / 1000)
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ role, iss: 'supabase', iat: now, exp: now + 20 * 365 * 24 * 3600 }))
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

let changed = false
for (const [key, bytes] of [['POSTGRES_PASSWORD', 24], ['SECRET_KEY_BASE', 32], ['PG_META_CRYPTO_KEY', 16]]) {
  if (missing(key)) { put(key, hex(bytes)); changed = true }
}
if (missing('JWT_SECRET')) {
  put('JWT_SECRET', hex(32))
  // Nouveau secret : les clés doivent être refaites avec lui.
  put('ANON_KEY', 'A_GENERER')
  put('SERVICE_ROLE_KEY', 'A_GENERER')
  changed = true
}
if (missing('ANON_KEY')) { put('ANON_KEY', jwt('anon', get('JWT_SECRET'))); changed = true }
if (missing('SERVICE_ROLE_KEY')) { put('SERVICE_ROLE_KEY', jwt('service_role', get('JWT_SECRET'))); changed = true }

writeFileSync(file, text)
console.log(changed ? 'Secrets generes dans .env' : 'Secrets deja presents dans .env (inchanges)')

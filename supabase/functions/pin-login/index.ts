// Fonction Edge « pin-login » : connexion rapide par code PIN (Paramètres > Configurations > Sécurité).
//
// Reçoit { username, pin }, vérifie le PIN dans la base (pin_login_check : 5 codes faux bloquent le compte 5 minutes),
// puis crée un lien de connexion à usage unique pour ce compte et renvoie son jeton haché. L'app ouvre la session
// avec supabase.auth.verifyOtp({ token_hash, type: 'magiclink' }). Aucun e-mail n'est envoyé.
//
// Déploiement (une fois) : Supabase > Edge Functions > Deploy a new function > nom « pin-login », coller ce fichier,
// et désactiver « Verify JWT » (l'écran de connexion n'a pas encore de session). Ou en ligne de commande :
//   supabase functions deploy pin-login --no-verify-jwt
// SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont fournis automatiquement par Supabase.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const reply = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405)

  let username = ''
  let pin = ''
  try {
    const body = await req.json()
    username = String(body?.username ?? '').trim()
    pin = String(body?.pin ?? '')
  } catch {
    return reply({ error: 'bad_request' }, 400)
  }
  if (!username || !/^\d{4}$/.test(pin)) return reply({ error: 'pin_bad' })

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const check = await admin.rpc('pin_login_check', { p_username: username, p_pin: pin })
  if (check.error) {
    const code = /pin_locked|pin_disabled|pin_bad/.exec(check.error.message)?.[0]
    return reply({ error: code ?? 'server_error' }, code ? 200 : 500)
  }
  const email = check.data as string | null
  if (!email) return reply({ error: 'pin_bad' })

  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  const token_hash = link.data?.properties?.hashed_token
  if (link.error || !token_hash) return reply({ error: 'server_error' }, 500)
  return reply({ token_hash })
})

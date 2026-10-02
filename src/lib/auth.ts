import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from './repo'
import { tr } from './i18n'
import { checkPassword, loadLocalUsers, saveLocalUsers } from './admin'
import { localPinCheck, settings } from './settings'
import type { UserRole } from './types'

/** Who is signed in: shown in the navigation, and the role for later permissions. */
export interface SessionUser {
  id: string
  username: string
  display_name: string
  role: UserRole
}

/** A name in the login screen's drop-down list. */
export interface LoginUser {
  username: string
  display_name: string
}

/** Opening and closing a session (écran de connexion, Déconnexion). Supabase Auth, or demo accounts on this device. */
export interface Auth {
  /** Active users, for the drop-down list. Empty when the list is not available (the name is then typed). */
  loginUsers(): Promise<LoginUser[]>
  /** Signs in with a username (or an e-mail address). Throws with a readable message when refused. */
  signIn(username: string, password: string): Promise<void>
  /** Écran de connexion: whether quick PIN login is on, and the usernames that have a PIN. */
  loginOptions(): Promise<LoginOptions>
  /** Quick login with a 4-digit PIN (Paramètres > Configurations > Sécurité). Throws with a readable message when refused. */
  signInWithPin(username: string, pin: string): Promise<void>
  signOut(): Promise<void>
  current(): Promise<SessionUser | null>
  /** Calls onChange after every sign in or sign out. Returns an unsubscribe function. */
  subscribe(onChange: () => void): () => void
}

export interface LoginOptions {
  pinLogin: boolean
  pinUsers: string[]
}

const badLogin = () => new Error(tr().badLogin)

/** Readable message for a refused PIN (codes of pin_login_check, through the pin-login function). */
function pinError(code: string | undefined): Error {
  const t = tr()
  if (code === 'pin_locked') return new Error(t.errPinLocked)
  if (code === 'pin_disabled') return new Error(t.errPinDisabled)
  if (code === 'pin_bad') return new Error(t.errPinBad)
  return new Error(t.errPinFunction)
}

/** Address used by Supabase Auth for an account created in the app (see save_user). */
export const internalEmail = (username: string) => `${username.trim().toLowerCase()}@smile-signature.local`

const missingFunction = (message: string) => /login_email/.test(message) && /does not exist|schema cache|Could not find/i.test(message)

function supabaseAuth(sb: SupabaseClient): Auth {
  return {
    async loginUsers() {
      const res = await sb.rpc('login_users')
      return res.error ? [] : (res.data as LoginUser[])
    },
    async signIn(username, password) {
      const t = tr()
      const name = username.trim()
      let email = name
      let missingRpc = false
      if (!name.includes('@')) {
        // Supabase Auth signs in with an e-mail: the username gives the account's address (agent1 →
        // agent1@smile-signature.local for accounts created in the app, or the address of an older account).
        const res = await sb.rpc('login_email', { p_username: name })
        if (res.error) {
          if (!missingFunction(res.error.message)) throw new Error(res.error.message)
          // Database without the login migration: try the address the app gives the accounts it creates.
          missingRpc = true
          email = internalEmail(name)
        } else if (!res.data) {
          throw new Error(t.errUnknownUser)
        } else {
          email = res.data as string
        }
      }
      const { error } = await sb.auth.signInWithPassword({ email, password })
      if (!error) return
      if (missingRpc) throw new Error(t.errMigrationLogin)
      if (/invalid login credentials/i.test(error.message)) throw badLogin()
      if (/email not confirmed/i.test(error.message)) throw new Error(t.errEmailNotConfirmed)
      // Anything else (account refused by Supabase, network…) is shown as is, so it can be fixed.
      throw new Error(`${t.errLoginOther} ${error.message}`)
    },
    async loginOptions() {
      const res = await sb.rpc('login_options')
      // Before the migration: password only.
      if (res.error || !res.data) return { pinLogin: false, pinUsers: [] }
      const d = res.data as { pin_login?: boolean; pin_users?: string[] }
      return { pinLogin: !!d.pin_login, pinUsers: d.pin_users ?? [] }
    },
    async signInWithPin(username, pin) {
      if (!/^\d{4}$/.test(pin)) throw pinError('pin_bad')
      // The PIN is checked by the pin-login Edge Function, which hands back a one-time sign-in token for the account.
      const res = await sb.functions.invoke('pin-login', { body: { username: username.trim(), pin } })
      const data = res.data as { token_hash?: string; error?: string } | null
      if (res.error || !data) throw pinError(undefined)
      if (!data.token_hash) throw pinError(data.error)
      const { error } = await sb.auth.verifyOtp({ token_hash: data.token_hash, type: 'magiclink' })
      if (error) throw new Error(`${tr().errLoginOther} ${error.message}`)
    },
    async signOut() {
      await sb.auth.signOut()
    },
    async current() {
      const { data } = await sb.auth.getSession()
      const u = data.session?.user
      if (!u) return null
      const profile = await sb.from('app_users').select('username, display_name, role').eq('user_id', u.id).maybeSingle()
      const p = profile.error ? null : (profile.data as { username: string; display_name: string; role: string } | null)
      // No app_users table yet (users migration not run): the database has no roles, the account keeps full access.
      // An account with no profile (created in the Supabase dashboard) is an employé until an admin gives it a role.
      const role: UserRole = profile.error && /app_users/.test(profile.error.message) ? 'admin' : p?.role === 'admin' || p?.role === 'manager' ? 'admin' : 'employe'
      return { id: u.id, username: p?.username ?? u.email?.split('@')[0] ?? '', display_name: p?.display_name ?? '', role }
    },
    subscribe(onChange) {
      const { data } = sb.auth.onAuthStateChange((event) => {
        // Outside the auth callback: Supabase calls made inside it can wait on each other.
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') setTimeout(onChange, 0)
      })
      return () => data.subscription.unsubscribe()
    },
  }
}

const SESSION_KEY = 'smile.session.v1'

function localAuth(): Auth {
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((l) => l())
  const setSession = (id: string | null) => {
    try {
      if (id) localStorage.setItem(SESSION_KEY, id)
      else localStorage.removeItem(SESSION_KEY)
    } catch {
      // Not remembered after a reload; the session still opens.
    }
  }
  let memory: string | null = null
  return {
    async loginUsers() {
      return loadLocalUsers()
        .filter((u) => u.active)
        .map(({ username, display_name }) => ({ username, display_name }))
        .sort((a, b) => a.username.localeCompare(b.username))
    },
    async signIn(username, password) {
      const users = loadLocalUsers()
      const u = users.find((x) => x.active && x.username === username.trim().toLowerCase())
      if (!u || !(await checkPassword(u.password_hash, password))) throw badLogin()
      saveLocalUsers(users.map((x) => (x.id === u.id ? { ...x, last_sign_in_at: new Date().toISOString() } : x)))
      memory = u.id
      setSession(u.id)
      notify()
    },
    async loginOptions() {
      const sec = await settings.getSecurity()
      const users = loadLocalUsers().filter((u) => u.active && u.pin_hash).map((u) => u.username)
      return { pinLogin: sec.pin_login_enabled, pinUsers: sec.pin_login_enabled ? users : [] }
    },
    async signInWithPin(username, pin) {
      const id = await localPinCheck(username, pin)
      saveLocalUsers(loadLocalUsers().map((x) => (x.id === id ? { ...x, last_sign_in_at: new Date().toISOString() } : x)))
      memory = id
      setSession(id)
      notify()
    },
    async signOut() {
      memory = null
      setSession(null)
      notify()
    },
    async current() {
      let id = memory
      try {
        id = localStorage.getItem(SESSION_KEY) ?? memory
      } catch {
        // Storage blocked: the session lives in memory for this visit.
      }
      const u = id ? loadLocalUsers().find((x) => x.id === id && x.active) : undefined
      return u ? { id: u.id, username: u.username, display_name: u.display_name, role: u.role ?? 'employe' } : null
    },
    subscribe(onChange) {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
  }
}

export const auth: Auth = supabase ? supabaseAuth(supabase) : localAuth()

import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from './repo'
import { tr } from './i18n'
import { USER_ROLES, type AppUser, type BackupLogEntry, type UserInput, type UserRole } from './types'

/**
 * Data access for the Fichier menu: user accounts (page Utilisateurs) and database exports (Sauvegarder la base de
 * données). Backed by Supabase when configured, localStorage otherwise, like `repo`.
 */
export interface Admin {
  listUsers(): Promise<AppUser[]>
  /** Only administrators can create or change users. */
  isAdmin(): Promise<boolean>
  /** Id of the signed-in account, to mark it in the list. */
  currentUserId(): Promise<string | null>
  /** Creates a user (no id) or saves changes. Returns its id. */
  saveUser(u: UserInput): Promise<string>

  /** Tables included in a backup, in export order. */
  backupTables(): Promise<string[]>
  /** Every row of one table. */
  readTable(name: string): Promise<Record<string, unknown>[]>
  logBackup(e: Omit<BackupLogEntry, 'id' | 'created_at'>): Promise<void>
  listBackups(): Promise<BackupLogEntry[]>
}

const USERNAME = /^[a-z0-9._-]{2,32}$/
export const MIN_PASSWORD = 4

/** Checks done in the app before saving, so the message is the same with or without Supabase. */
function checkUser(u: UserInput) {
  const t = tr()
  if (!USERNAME.test(u.username)) throw new Error(t.errUsername)
  if (!USER_ROLES.includes(u.role)) throw new Error(t.errRole)
  if ((!u.id || u.password) && u.password.length < MIN_PASSWORD) throw new Error(t.errPasswordShort(MIN_PASSWORD))
}

/** Lower case, trimmed: usernames are compared without case. */
export const cleanUsername = (s: string) => s.trim().toLowerCase()

function adminError(message: string): Error {
  const t = tr()
  if (message.includes('not_admin')) return new Error(t.errNotAdmin)
  if (message.includes('bad_username')) return new Error(t.errUsername)
  if (message.includes('bad_role')) return new Error(t.errRole)
  if (message.includes('weak_password')) return new Error(t.errPasswordShort(MIN_PASSWORD))
  if (message.includes('username_taken')) return new Error(t.errUsernameTaken)
  if (message.includes('self_demote')) return new Error(t.errSelfDemote)
  if (message.includes('user_not_found')) return new Error(t.errUserGone)
  if (/list_users|save_user|is_app_admin|app_users|backups_log|logo/.test(message) && /does not exist|schema cache|Could not find/i.test(message)) {
    return new Error(t.errMigrationUsers)
  }
  return new Error(message)
}

const missingTable = (message: string) => /does not exist|schema cache|Could not find/i.test(message)

/** Tables of the Supabase database, in export order (parents before children), with the column to page by. */
const SUPABASE_TABLES: [string, string][] = [
  ['halls', 'id'], ['tables', 'id'],
  ['categories', 'id'], ['items', 'id'], ['option_groups', 'id'], ['options', 'id'],
  ['printers', 'id'], ['category_printers', 'category_id'],
  ['orders', 'id'], ['order_items', 'id'], ['payments', 'id'], ['kitchen_tickets', 'id'], ['table_moves', 'id'],
  ['receipt_settings', 'id'], ['stock_items', 'id'], ['suppliers', 'id'],
  ['app_users', 'user_id'], ['backups_log', 'id'], ['role_permissions', 'role'], ['user_permissions', 'user_id'],
  ['reservations', 'id'], ['delivery_zones', 'id'], ['salary_advances', 'id'], ['device_sessions', 'id'],
]
const PAGE = 1000

function supabaseAdmin(sb: SupabaseClient): Admin {
  const check = <T>(res: { data: T; error: { message: string } | null }): T => {
    if (res.error) throw adminError(res.error.message)
    return res.data
  }
  return {
    async listUsers() {
      return check(await sb.rpc('list_users')) as AppUser[]
    },
    async isAdmin() {
      const res = await sb.rpc('is_app_admin')
      return !res.error && res.data === true
    },
    async currentUserId() {
      const { data } = await sb.auth.getUser()
      return data.user?.id ?? null
    },
    async saveUser(u) {
      checkUser(u)
      return check(await sb.rpc('save_user', {
        p_id: u.id ?? null, p_username: cleanUsername(u.username), p_display_name: u.display_name.trim(), p_role: u.role,
        p_password: u.password || null, p_active: u.active,
      })) as string
    },

    async backupTables() {
      return SUPABASE_TABLES.map(([name]) => name)
    },
    async readTable(name) {
      const key = SUPABASE_TABLES.find(([n]) => n === name)?.[1] ?? 'id'
      const rows: Record<string, unknown>[] = []
      for (let from = 0; ; from += PAGE) {
        const res = await sb.from(name).select('*').order(key).range(from, from + PAGE - 1)
        if (res.error) {
          // A table from a migration not run yet: the backup goes on without it.
          if (missingTable(res.error.message)) return []
          throw new Error(res.error.message)
        }
        rows.push(...(res.data as Record<string, unknown>[]))
        if (res.data.length < PAGE) return rows
      }
    },
    async logBackup(e) {
      check(await sb.from('backups_log').insert(e))
    },
    async listBackups() {
      const res = await sb.from('backups_log').select('*').order('created_at', { ascending: false }).limit(20)
      if (res.error) {
        if (missingTable(res.error.message)) return []
        throw adminError(res.error.message)
      }
      return (res.data as BackupLogEntry[]).map((b) => ({ ...b, id: String(b.id) }))
    },
  }
}

// ───────────── Demo mode (localStorage) ─────────────

export const USERS_KEY = 'smile.users.v1'
const BACKUPS_KEY = 'smile.backups.v1'

/** A demo user, with its password hash (never exported). */
export interface LocalUser extends AppUser {
  password_hash: string
}

/**
 * Password hash for the demo users: SHA-256 of a random salt and the password, stored as "sha256:salt:hash".
 * Seeded users start with "plain:…" until their password is changed.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')
  return `sha256:${salt}:${await sha256(salt + password)}`
}

export async function checkPassword(stored: string, password: string): Promise<boolean> {
  if (stored.startsWith('plain:')) return stored.slice(6) === password
  const [, salt, hash] = stored.split(':')
  return (await sha256(salt + password)) === hash
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Demo administrator: admin / 1234. */
export const DEMO_ADMIN = { username: 'admin', password: '1234' }

const toRole = (r: string | null): UserRole => (r === 'admin' || r === 'manager' ? 'admin' : 'employe')

export function loadLocalUsers(): LocalUser[] {
  try {
    const raw = localStorage.getItem(USERS_KEY)
    // Older demo data had four roles: Gérant became admin, Caissier and Serveur became employé.
    if (raw) return (JSON.parse(raw) as LocalUser[]).map((u) => ({ ...u, role: toRole(u.role as string | null) }))
  } catch {
    // Storage blocked or unreadable: start again from the demo administrator.
  }
  const users: LocalUser[] = [{
    id: 'demo-admin', username: DEMO_ADMIN.username, display_name: 'Administrateur', role: 'admin', active: true, email: null,
    created_at: new Date().toISOString(), last_sign_in_at: null, password_hash: `plain:${DEMO_ADMIN.password}`,
  }]
  saveLocalUsers(users)
  return users
}

export function saveLocalUsers(users: LocalUser[]) {
  try {
    localStorage.setItem(USERS_KEY, JSON.stringify(users))
  } catch {
    // Not persisted in this browser (private mode); the page still works for this visit.
  }
}

const publicUser = ({ password_hash: _, ...u }: LocalUser): AppUser => u

/** Demo tables: every array inside the app's localStorage stores ("floor.halls", "orders.lines"…). */
function localTables(): Map<string, Record<string, unknown>[]> {
  const out = new Map<string, Record<string, unknown>[]>()
  const keys: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)!)
  } catch {
    return out
  }
  for (const key of keys.filter((k) => k.startsWith('smile.')).sort()) {
    if (key === USERS_KEY) {
      out.set('users', loadLocalUsers().map(publicUser) as unknown as Record<string, unknown>[])
      continue
    }
    let value: unknown
    try {
      value = JSON.parse(localStorage.getItem(key) ?? 'null')
    } catch {
      continue
    }
    const short = key.replace(/^smile\./, '').replace(/\.v\d+$/, '')
    if (Array.isArray(value)) out.set(short, value as Record<string, unknown>[])
    else if (value && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) {
        if (Array.isArray(v)) out.set(`${short}.${prop}`, v as Record<string, unknown>[])
        else if (v && typeof v === 'object') out.set(`${short}.${prop}`, [v as Record<string, unknown>])
      }
    }
  }
  return out
}

function localAdmin(): Admin {
  return {
    async listUsers() {
      return loadLocalUsers().map(publicUser).sort((a, b) => a.username.localeCompare(b.username))
    },
    async isAdmin() {
      const me = localStorage.getItem('smile.session.v1')
      const users = loadLocalUsers()
      // The signed-in demo account (login screen), when it is an active admin.
      return users.some((u) => u.id === me && u.role === 'admin' && u.active)
    },
    async currentUserId() {
      try {
        return localStorage.getItem('smile.session.v1')
      } catch {
        return null
      }
    },
    async saveUser(u) {
      checkUser(u)
      const t = tr()
      const users = loadLocalUsers()
      const username = cleanUsername(u.username)
      if (users.some((x) => x.id !== u.id && x.username === username)) throw new Error(t.errUsernameTaken)
      const me = await this.currentUserId()
      if (u.id && u.id === me && (u.role !== 'admin' || !u.active)) throw new Error(t.errSelfDemote)
      const fields = { username, display_name: u.display_name.trim(), role: u.role as UserRole, active: u.active }
      if (!u.id) {
        const row: LocalUser = {
          id: crypto.randomUUID(), ...fields, email: null, created_at: new Date().toISOString(), last_sign_in_at: null,
          password_hash: await hashPassword(u.password),
        }
        saveLocalUsers([...users, row])
        return row.id
      }
      const current = users.find((x) => x.id === u.id)
      if (!current) throw new Error(t.errUserGone)
      const password_hash = u.password ? await hashPassword(u.password) : current.password_hash
      saveLocalUsers(users.map((x) => (x.id === u.id ? { ...x, ...fields, password_hash } : x)))
      return current.id
    },

    async backupTables() {
      return [...localTables().keys()]
    },
    async readTable(name) {
      return localTables().get(name) ?? []
    },
    async logBackup(e) {
      const log = await this.listBackups()
      const row: BackupLogEntry = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...e }
      try {
        localStorage.setItem(BACKUPS_KEY, JSON.stringify([row, ...log].slice(0, 20)))
      } catch {
        // History not kept in this browser; the file was still downloaded.
      }
    },
    async listBackups() {
      try {
        return JSON.parse(localStorage.getItem(BACKUPS_KEY) ?? '[]') as BackupLogEntry[]
      } catch {
        return []
      }
    },
  }
}

export const admin: Admin = supabase ? supabaseAdmin(supabase) : localAdmin()

// ───────────── Export files ─────────────

/** One CSV cell: objects as JSON, quotes doubled, quoted when needed. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Rows as CSV with ";" separators and a byte order mark, so Excel in French opens it directly with accents and
 * Arabic text intact. Columns: every key found in the rows.
 */
export function toCsv(rows: Record<string, unknown>[]): string {
  const cols: string[] = []
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k)
  const lines = [cols.map(csvCell).join(';'), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(';'))]
  return '﻿' + lines.join('\r\n') + '\r\n'
}

/** Saves text as a file on this device (browser download). Returns its size in bytes. */
export function download(filename: string, text: string, type: string): number {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return blob.size
}

/** "2026-09-29_2215" for file names. */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

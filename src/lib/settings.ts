import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { repo, sharedChannel, supabase } from './repo'
import { tr, type Dict } from './i18n'
import { checkPassword, hashPassword, loadLocalUsers, saveLocalUsers } from './admin'
import type { PaymentMode, ReasonLists, SecurityConfig } from './types'

/**
 * Paramètres > Configurations, tabs Paiement, Motifs and Sécurité, and the users' PIN codes. Supabase (table
 * payment_modes, app_config columns, app_users.pin_hash: migration 20261008000000_settings_printers_halls_payments.sql),
 * or localStorage in demo mode, like `repo`.
 */
export interface SettingsService {
  /** Every payment mode, in display order (Espèces first unless moved). */
  listPaymentModes(): Promise<PaymentMode[]>
  /** A new mode, active, at the end of the list. Its code is made from the label (cib, edahabia…). */
  createPaymentMode(label: string): Promise<PaymentMode>
  updatePaymentMode(code: string, patch: Partial<Pick<PaymentMode, 'label' | 'active' | 'sort_order'>>): Promise<void>
  /** Refused for Espèces and Carte, and for a mode already used by a payment (deactivate it instead). */
  deletePaymentMode(code: string): Promise<void>
  getReasons(): Promise<ReasonLists>
  saveReasons(lists: ReasonLists): Promise<void>
  getSecurity(): Promise<SecurityConfig>
  saveSecurity(config: SecurityConfig): Promise<void>
  /** Sets (4 digits) or removes (null) a user's PIN. Admin only. */
  setUserPin(userId: string, pin: string | null): Promise<void>
  /** Ids of the users who have a PIN (page Utilisateurs). */
  usersWithPin(): Promise<string[]>
  /** Calls onChange when the payment modes or the configuration change elsewhere. */
  subscribe(onChange: () => void): () => void
}

/** Built-in payment modes, before the migration or in a new demo. */
export const defaultPaymentModes = (): PaymentMode[] => [
  { code: 'cash', label: null, active: true, sort_order: 0 },
  { code: 'card', label: null, active: true, sort_order: 1 },
  { code: 'cib', label: 'CIB', active: false, sort_order: 2 },
  { code: 'edahabia', label: 'Edahabia', active: false, sort_order: 3 },
  { code: 'baridimob', label: 'BaridiMob', active: false, sort_order: 4 },
  { code: 'credit', label: null, active: true, sort_order: 90 },
]

/** Compte client (crédit): not a checkout button like the others, it opens the customer picker (menu Clients). */
export const isCredit = (code: string) => code === 'credit'

/** Name shown for a payment mode (or a code found in old payments): its label, else the app's translation. */
export function paymentLabel(t: Pick<Dict, 'payMethod'>, code: string, modes?: PaymentMode[]): string {
  const m = modes?.find((x) => x.code === code)
  return m?.label?.trim() || t.payMethod[code] || code
}

/** Only Espèces goes through the cash drawer (fond de caisse, clôture). */
export const isCash = (code: string) => code === 'cash'

/** Default reasons, translated, used while the admin has not edited a list. */
export function defaultReasons(t: Dict): { cancel: string[]; offer: string[]; discount: string[] } {
  return {
    cancel: ['entry_error', 'customer_left', 'customer_changed', 'unavailable', 'too_long', 'customer_complaint', 'test'].map((c) => t.cancelReasons[c]),
    offer: t.defaultOfferReasons,
    discount: t.defaultDiscountReasons,
  }
}

/** The lists actually offered on the screens: the admin's, or the defaults. */
export function effectiveReasons(t: Dict, lists: ReasonLists) {
  const d = defaultReasons(t)
  return { cancel: lists.cancel ?? d.cancel, offer: lists.offer ?? d.offer, discount: lists.discount ?? d.discount }
}

const sortModes = (a: PaymentMode, b: PaymentMode) => a.sort_order - b.sort_order || a.code.localeCompare(b.code)

/** Code of a new mode: lower-case letters and digits of its label (« Baridi Mob » → baridi_mob). */
export function modeCode(label: string, taken: string[]): string {
  const base = label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'mode'
  let code = base
  for (let n = 2; taken.includes(code); n++) code = `${base}_${n}`
  return code
}

function cleanLabel(label: string): string {
  const l = label.trim()
  if (!l || l.length > 40) throw new Error(tr().errPayModeLabel)
  return l
}

/** Trimmed, without duplicates or empty lines, at most 30 reasons of 60 characters. */
export function cleanReasonList(list: string[] | null): string[] | null {
  if (list === null) return null
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of list) {
    const v = r.trim().slice(0, 60)
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase())
      out.push(v)
    }
  }
  if (out.length > 30) throw new Error(tr().errReasonsTooMany)
  return out
}

function cleanSecurity(c: SecurityConfig): SecurityConfig {
  const min = c.auto_logout_min
  if (min !== null && !(Number.isInteger(min) && min >= 1 && min <= 480)) throw new Error(tr().errAutoLogout)
  return { pin_login_enabled: !!c.pin_login_enabled, auto_logout_min: min }
}

function checkPin(pin: string | null) {
  if (pin !== null && !/^\d{4}$/.test(pin)) throw new Error(tr().errPinFormat)
}

const missing = (m: string) => /payment_modes|cancel_reasons|offer_reasons|discount_reasons|pin_login_enabled|auto_logout_min|set_user_pin|users_with_pin|pin_hash/.test(m)
  && /does not exist|schema cache|Could not find/i.test(m)

function settingsError(message: string): Error {
  const t = tr()
  if (missing(message)) return new Error(t.errMigrationSettings2)
  if (message.includes('payment_mode_used')) return new Error(t.errPayModeUsed)
  if (message.includes('payment_mode_builtin')) return new Error(t.errPayModeBuiltin)
  if (message.includes('payment_modes_cash_active')) return new Error(t.errPayModeCash)
  if (message.includes('pin_invalid')) return new Error(t.errPinFormat)
  if (/permission_denied|row-level security|permission denied/i.test(message)) return new Error(t.errNoPermission)
  return new Error(message)
}

function supabaseSettings(sb: SupabaseClient): SettingsService {
  const check = <T>(res: { data: T; error: { message: string } | null }): T => {
    if (res.error) throw settingsError(res.error.message)
    return res.data
  }
  const modesChannel = sharedChannel(sb, 'payment_modes', ['payment_modes'])
  const config = async () => {
    const res = await sb.from('app_config').select('*').eq('id', 1).maybeSingle()
    return (res.error ? null : res.data) as Record<string, unknown> | null
  }
  const writeConfig = async (patch: object) => {
    const res = await sb.from('app_config').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1).select('id')
    check(res)
    if (!res.data?.length) throw new Error(tr().errNoPermission)
  }
  return {
    async listPaymentModes() {
      const res = await sb.from('payment_modes').select('code, label, active, sort_order')
      // Before the migration: Espèces and Carte, as before.
      if (res.error) return missing(res.error.message) ? defaultPaymentModes().filter((m) => m.active && !isCredit(m.code)) : Promise.reject(settingsError(res.error.message))
      return (res.data as PaymentMode[]).sort(sortModes)
    },
    async createPaymentMode(label) {
      const l = cleanLabel(label)
      const modes = await this.listPaymentModes()
      const row: PaymentMode = { code: modeCode(l, modes.map((m) => m.code)), label: l, active: true, sort_order: Math.max(-1, ...modes.map((m) => m.sort_order)) + 1 }
      check(await sb.from('payment_modes').insert(row))
      return row
    },
    async updatePaymentMode(code, patch) {
      const p = { ...patch, ...(patch.label !== undefined ? { label: patch.label === null ? null : cleanLabel(patch.label) } : {}) }
      check(await sb.from('payment_modes').update(p).eq('code', code))
    },
    async deletePaymentMode(code) {
      check(await sb.from('payment_modes').delete().eq('code', code))
    },
    async getReasons() {
      const c = await config()
      // Before the migration the orders cannot store an offer / discount reason: none is asked.
      if (!c || !('offer_reasons' in c)) return { cancel: null, offer: [], discount: [] }
      const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : null)
      return { cancel: list(c?.cancel_reasons), offer: list(c?.offer_reasons), discount: list(c?.discount_reasons) }
    },
    async saveReasons(lists) {
      await writeConfig({ cancel_reasons: cleanReasonList(lists.cancel), offer_reasons: cleanReasonList(lists.offer), discount_reasons: cleanReasonList(lists.discount) })
    },
    async getSecurity() {
      const c = await config()
      return { pin_login_enabled: !!c?.pin_login_enabled, auto_logout_min: c?.auto_logout_min == null ? null : Number(c.auto_logout_min) }
    },
    async saveSecurity(c) {
      await writeConfig(cleanSecurity(c))
    },
    async setUserPin(userId, pin) {
      checkPin(pin)
      check(await sb.rpc('set_user_pin', { p_user_id: userId, p_pin: pin }))
    },
    async usersWithPin() {
      const res = await sb.rpc('users_with_pin')
      return res.error ? [] : ((res.data as string[] | null) ?? [])
    },
    subscribe(onChange) {
      const a = modesChannel(onChange)
      const b = repo.subscribeConfig(onChange)
      return () => {
        a()
        b()
      }
    },
  }
}

const KEY = 'smile.settings.v1'

interface LocalSettings {
  paymentModes?: PaymentMode[]
  reasons?: ReasonLists
  security?: SecurityConfig
}

function localSettings(): SettingsService {
  const listeners = new Set<() => void>()
  const read = (): LocalSettings => {
    try {
      return (JSON.parse(localStorage.getItem(KEY) ?? '{}') as LocalSettings) ?? {}
    } catch {
      return {}
    }
  }
  let memory: LocalSettings | null = null
  const load = () => memory ?? read()
  const write = (s: LocalSettings) => {
    memory = s
    try {
      localStorage.setItem(KEY, JSON.stringify(s))
      memory = null
    } catch {
      // Kept for this visit only.
    }
    listeners.forEach((l) => l())
  }
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) listeners.forEach((l) => l())
  })
  const modes = () => {
    const saved = load().paymentModes ?? defaultPaymentModes()
    // Demo saved before the Clients menu: Compte client is added.
    return saved.some((m) => isCredit(m.code)) ? saved : [...saved, defaultPaymentModes().find((m) => isCredit(m.code))!]
  }
  /** Payments already made in a mode (demo orders database), so it is not deleted. */
  const usedModes = (): Set<string> => {
    try {
      const db = JSON.parse(localStorage.getItem('smile.orders.v1') ?? '{}') as { payments?: { method: string }[] }
      return new Set((db.payments ?? []).map((p) => p.method))
    } catch {
      return new Set()
    }
  }
  return {
    async listPaymentModes() {
      return [...modes()].sort(sortModes)
    },
    async createPaymentMode(label) {
      const l = cleanLabel(label)
      const list = modes()
      const row: PaymentMode = { code: modeCode(l, list.map((m) => m.code)), label: l, active: true, sort_order: Math.max(-1, ...list.map((m) => m.sort_order)) + 1 }
      write({ ...load(), paymentModes: [...list, row] })
      return row
    },
    async updatePaymentMode(code, patch) {
      if (code === 'cash' && patch.active === false) throw new Error(tr().errPayModeCash)
      const p = { ...patch, ...(patch.label !== undefined ? { label: patch.label === null ? null : cleanLabel(patch.label) } : {}) }
      write({ ...load(), paymentModes: modes().map((m) => (m.code === code ? { ...m, ...p } : m)) })
    },
    async deletePaymentMode(code) {
      if (code === 'cash' || code === 'card' || code === 'credit') throw new Error(tr().errPayModeBuiltin)
      if (usedModes().has(code)) throw new Error(tr().errPayModeUsed)
      write({ ...load(), paymentModes: modes().filter((m) => m.code !== code) })
    },
    async getReasons() {
      return load().reasons ?? { cancel: null, offer: null, discount: null }
    },
    async saveReasons(lists) {
      write({ ...load(), reasons: { cancel: cleanReasonList(lists.cancel), offer: cleanReasonList(lists.offer), discount: cleanReasonList(lists.discount) } })
    },
    async getSecurity() {
      return load().security ?? { pin_login_enabled: false, auto_logout_min: null }
    },
    async saveSecurity(c) {
      write({ ...load(), security: cleanSecurity(c) })
    },
    async setUserPin(userId, pin) {
      checkPin(pin)
      const users = loadLocalUsers()
      const pin_hash = pin === null ? null : await hashPassword(pin)
      saveLocalUsers(users.map((u) => (u.id === userId ? { ...u, pin_hash, pin_failed: 0, pin_locked_until: null } : u)))
      listeners.forEach((l) => l())
    },
    async usersWithPin() {
      return loadLocalUsers().filter((u) => u.pin_hash).map((u) => u.id)
    },
    subscribe(onChange) {
      const l = () => onChange()
      listeners.add(l)
      const b = repo.subscribeConfig(onChange)
      return () => {
        listeners.delete(l)
        b()
      }
    },
  }
}

export const settings: SettingsService = supabase ? supabaseSettings(supabase) : localSettings()

/** Demo mode: checks a user's PIN (5 wrong codes in a row lock it for 5 minutes, like the database). */
export async function localPinCheck(username: string, pin: string): Promise<string> {
  const t = tr()
  const sec = await settings.getSecurity()
  if (!sec.pin_login_enabled) throw new Error(t.errPinDisabled)
  const users = loadLocalUsers()
  const u = users.find((x) => x.active && x.username === username.trim().toLowerCase())
  if (!u?.pin_hash) throw new Error(t.errPinBad)
  if (u.pin_locked_until && new Date(u.pin_locked_until).getTime() > Date.now()) throw new Error(t.errPinLocked)
  if (/^\d{4}$/.test(pin) && (await checkPassword(u.pin_hash, pin))) {
    saveLocalUsers(users.map((x) => (x.id === u.id ? { ...x, pin_failed: 0, pin_locked_until: null } : x)))
    return u.id
  }
  const failed = (u.pin_failed ?? 0) + 1
  saveLocalUsers(users.map((x) => (x.id === u.id
    ? { ...x, pin_failed: failed >= 5 ? 0 : failed, pin_locked_until: failed >= 5 ? new Date(Date.now() + 5 * 60_000).toISOString() : null }
    : x)))
  throw new Error(failed >= 5 ? t.errPinLocked : t.errPinBad)
}

/** Payment modes, kept up to date (checkout screen, reports). Starts with the built-in active ones. */
export function usePaymentModes(): PaymentMode[] {
  const [modes, setModes] = useState<PaymentMode[]>(() => defaultPaymentModes().filter((m) => m.active && !isCredit(m.code)))
  useEffect(() => {
    let live = true
    const load = () => settings.listPaymentModes().then((m) => live && setModes(m), () => {})
    load()
    const off = settings.subscribe(load)
    return () => {
      live = false
      off()
    }
  }, [])
  return modes
}

/** Reason lists of the screens (admin's or defaults), kept up to date. cancelCodes: the default codes are used. */
export function useReasons(t: Dict) {
  const [lists, setLists] = useState<ReasonLists>({ cancel: null, offer: null, discount: null })
  useEffect(() => {
    let live = true
    const load = () => settings.getReasons().then((r) => live && setLists(r), () => {})
    load()
    const off = settings.subscribe(load)
    return () => {
      live = false
      off()
    }
  }, [])
  return { ...effectiveReasons(t, lists), cancelCodes: lists.cancel === null }
}

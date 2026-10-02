import { appNow, nowIso, tzIsoDay } from './tz'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sharedChannel, supabase } from './repo'
import { tr } from './i18n'
import { loadLocalUsers } from './admin'
import type { NewSalaryAdvance, PayrollRow, SalaryAdvance } from './types'
import { newId } from './id'

/**
 * Salaires et acomptes (menu Gestion des employés): each account's fixed monthly salary and the advances paid on it.
 * Supabase column app_users.monthly_salary and table salary_advances (migration 20260930050000_payroll.sql), or
 * localStorage in demo mode, like `repo`. A month is "YYYY-MM"; a date is "YYYY-MM-DD" (local day).
 */
export interface PayrollService {
  /** Every account with its salary, the month's advances and what is left to pay; active accounts first. */
  summary(month: string): Promise<PayrollRow[]>
  setSalary(userId: string, amount: number): Promise<void>
  /** Advances of the month, newest first; one employee's only when userId is given. */
  advances(month: string, userId?: string): Promise<SalaryAdvance[]>
  addAdvance(advance: NewSalaryAdvance): Promise<SalaryAdvance>
  removeAdvance(id: string): Promise<void>
  subscribe(onChange: () => void): () => void
}

const pad = (n: number) => String(n).padStart(2, '0')
/** Today as YYYY-MM-DD, Algiers time on the server's clock. */
export const todayIso = () => tzIsoDay(appNow())
export const currentMonth = () => todayIso().slice(0, 7)
/** "2026-09" moved by n months. */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`
}
/** First day of the month and first day of the next one. */
const monthRange = (month: string): [string, string] => [`${month}-01`, `${shiftMonth(month, 1)}-01`]

const round2 = (n: number) => Math.round(n * 100) / 100
const validAmount = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1e9

/** Checks and trims an advance before it is saved. */
function clean(a: NewSalaryAdvance): NewSalaryAdvance {
  const t = tr()
  if (!(validAmount(a.amount) && a.amount > 0)) throw new Error(t.errAdvanceAmount)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date)) throw new Error(t.errAdvanceDate)
  return { user_id: a.user_id, amount: round2(a.amount), date: a.date, note: a.note?.trim() || null }
}

function payrollError(message: string): Error {
  const t = tr()
  if (/salary_advances|payroll_summary|set_monthly_salary|monthly_salary/.test(message) && /does not exist|schema cache|Could not find/i.test(message)) {
    return new Error(t.errMigrationPayroll)
  }
  if (/no_permission|row-level security|permission denied/i.test(message)) return new Error(t.errNoPermission)
  if (message.includes('bad_amount')) return new Error(t.errSalaryAmount)
  if (message.includes('user_not_found')) return new Error(t.errUserGone)
  return new Error(message)
}

const normAdvance = (a: SalaryAdvance): SalaryAdvance => ({ ...a, amount: Number(a.amount) })
const newestFirst = (a: SalaryAdvance, b: SalaryAdvance) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at)

function supabasePayroll(sb: SupabaseClient): PayrollService {
  const check = <T>(res: { data: T; error: { message: string } | null }): T => {
    if (res.error) throw payrollError(res.error.message)
    return res.data
  }
  const columns = 'id, user_id, amount, date, note, created_at'
  return {
    async summary(month) {
      const rows = check(await sb.rpc('payroll_summary', { p_month: `${month}-01` })) as PayrollRow[]
      return rows.map((r) => ({
        ...r, monthly_salary: Number(r.monthly_salary), advances: Number(r.advances), advances_count: Number(r.advances_count), remaining: Number(r.remaining),
      }))
    },
    async setSalary(userId, amount) {
      if (!validAmount(amount)) throw new Error(tr().errSalaryAmount)
      check(await sb.rpc('set_monthly_salary', { p_user_id: userId, p_amount: round2(amount) }))
    },
    async advances(month, userId) {
      const [from, to] = monthRange(month)
      let q = sb.from('salary_advances').select(columns).gte('date', from).lt('date', to)
      if (userId) q = q.eq('user_id', userId)
      return (check(await q) as SalaryAdvance[]).map(normAdvance).sort(newestFirst)
    },
    async addAdvance(advance) {
      return normAdvance(check(await sb.from('salary_advances').insert(clean(advance)).select(columns).single()) as SalaryAdvance)
    },
    async removeAdvance(id) {
      check(await sb.from('salary_advances').delete().eq('id', id))
    },
    subscribe: sharedChannel(sb, 'payroll', ['salary_advances']),
  }
}

// ───────────── Demo mode (localStorage) ─────────────

const KEY = 'smile.payroll.v1'

interface LocalPayroll {
  /** Salary by user id; the demo users themselves live in smile.users.v1. */
  salaries: Record<string, number>
  advances: SalaryAdvance[]
}

function localPayroll(): PayrollService {
  const listeners = new Set<() => void>()
  const read = (): LocalPayroll => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<LocalPayroll> | null
      return { salaries: saved?.salaries ?? {}, advances: (saved?.advances ?? []).map(normAdvance) }
    } catch {
      return { salaries: {}, advances: [] }
    }
  }
  const write = (db: LocalPayroll) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(db))
    } catch {
      // Not persisted (private mode); the change is lost on reload.
    }
    listeners.forEach((l) => l())
  }
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) listeners.forEach((l) => l())
  })
  const inMonth = (month: string) => {
    const [from, to] = monthRange(month)
    return (a: SalaryAdvance) => a.date >= from && a.date < to
  }
  return {
    async summary(month) {
      const db = read()
      const advances = db.advances.filter(inMonth(month))
      const name = (u: { display_name: string; username: string }) => (u.display_name || u.username).toLowerCase()
      return loadLocalUsers()
        .sort((a, b) => Number(b.active) - Number(a.active) || name(a).localeCompare(name(b)))
        .map((u) => {
          const mine = advances.filter((a) => a.user_id === u.id)
          const total = round2(mine.reduce((s, a) => s + a.amount, 0))
          const salary = db.salaries[u.id] ?? 0
          return {
            user_id: u.id, username: u.username, display_name: u.display_name, role: u.role, active: u.active,
            monthly_salary: salary, advances: total, advances_count: mine.length, remaining: round2(salary - total),
          }
        })
    },
    async setSalary(userId, amount) {
      if (!validAmount(amount)) throw new Error(tr().errSalaryAmount)
      const db = read()
      db.salaries[userId] = round2(amount)
      write(db)
    },
    async advances(month, userId) {
      return read().advances.filter(inMonth(month)).filter((a) => !userId || a.user_id === userId).sort(newestFirst)
    },
    async addAdvance(advance) {
      const db = read()
      const row: SalaryAdvance = { id: newId(), ...clean(advance), created_at: nowIso() }
      db.advances.push(row)
      write(db)
      return row
    },
    async removeAdvance(id) {
      const db = read()
      db.advances = db.advances.filter((a) => a.id !== id)
      write(db)
    },
    subscribe(onChange) {
      const l = () => onChange()
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
  }
}

export const payroll: PayrollService = supabase ? supabasePayroll(supabase) : localPayroll()

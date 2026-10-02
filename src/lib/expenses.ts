import { appNow, daysInMonth, nowIso, tzIsoDay } from './tz'
import type { SupabaseClient } from '@supabase/supabase-js'
import { onLocalOrderPaid, repo, sharedChannel, supabase } from './repo'
import { editLocalStock, localUserName } from './backoffice'
import { loadLocalUsers } from './admin'
import { consumptionNeeds } from './recipes'
import { tr } from './i18n'
import { money } from './format'
import { newId } from './id'
import type { CostStatus, Expense, ExpenseCategory, NewExpense, OrderLine, ProfitCosts, RecipeLine, StockMovement } from './types'

/**
 * Liste des dépenses and the costs of the page Bénéfice. Supabase tables expense_categories / expenses and functions
 * save_expense, delete_expense, profit_summary (migration 20260930120000_expenses_profit.sql); localStorage in demo mode.
 * An expense paid « espèces caisse » is a Fond de sortie of the open day: both are created, changed and deleted together.
 */
export interface ExpensesService {
  categories(): Promise<ExpenseCategory[]>
  saveCategory(c: { id?: string; name: string; active?: boolean }): Promise<void>
  deleteCategory(id: string): Promise<void>
  /** Expenses whose day is in [first, last] (YYYY-MM-DD), newest first. */
  list(first: string, last: string): Promise<Expense[]>
  save(e: NewExpense, id?: string): Promise<Expense>
  remove(id: string): Promise<void>
  /** Charges, inventory losses, salaries and expenses of a period: [from, to) instants, [first, last] days. */
  profitCosts(from: Date, to: Date, first: string, last: string): Promise<ProfitCosts>
  subscribe(onChange: () => void): () => void
}

const round2 = (n: number) => Math.round(n * 100) / 100
const validAmount = (n: number) => Number.isFinite(n) && n > 0 && n <= 1e9

function expensesError(message: string): Error {
  const t = tr()
  const short = /insufficient_cash:(-?[\d.]+)/.exec(message)
  if (short) return new Error(t.errCashShort(money(Number(short[1]))))
  if (/expense|profit_summary/.test(message) && /does not exist|schema cache|Could not find/i.test(message)) return new Error(t.errMigrationExpenses)
  if (/no_permission|row-level security|permission denied/i.test(message)) return new Error(t.errNoPermission)
  if (message.includes('no_open_day')) return new Error(t.errExpenseNoDay)
  if (message.includes('day_closed')) return new Error(t.errExpenseDayClosed)
  if (message.includes('expense_mode_locked')) return new Error(t.errExpenseMode)
  if (message.includes('category_not_found')) return new Error(t.errExpenseCategory)
  if (message.includes('expense_categories_name') || message.includes('23505')) return new Error(t.errCategoryTaken)
  if (message.includes('bad_amount')) return new Error(t.errCashAmount)
  return new Error(message)
}

function check(e: NewExpense): NewExpense {
  const t = tr()
  if (!validAmount(e.amount)) throw new Error(t.errCashAmount)
  if (!e.category_id) throw new Error(t.errExpenseCategory)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new Error(t.errExpenseDate)
  return { ...e, amount: round2(e.amount), note: e.note.trim().slice(0, 300) }
}

const normExpense = (e: Expense): Expense => ({ ...e, amount: Number(e.amount), note: e.note ?? '' })
const byDate = (a: Expense, b: Expense) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at)
const numbers = (r: Record<string, unknown> | null | undefined) =>
  Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k, Number(v)])) as Record<string, number>

function supabaseExpenses(sb: SupabaseClient): ExpensesService {
  const ok = <T>(res: { data: T; error: { message: string } | null }): T => {
    if (res.error) throw expensesError(res.error.message)
    return res.data
  }
  return {
    async categories() {
      return ok(await sb.from('expense_categories').select('id, name, sort_order, active').order('sort_order').order('name')) as ExpenseCategory[]
    },
    async saveCategory(c) {
      const name = c.name.trim()
      if (!name) throw new Error(tr().errNameEmpty)
      if (c.id) ok(await sb.from('expense_categories').update({ name, ...(c.active !== undefined && { active: c.active }) }).eq('id', c.id))
      else ok(await sb.from('expense_categories').insert({ name, sort_order: 100 }))
    },
    async deleteCategory(id) {
      ok(await sb.from('expense_categories').delete().eq('id', id))
    },
    async list(first, last) {
      return (ok(await sb.from('expenses').select('*').gte('date', first).lte('date', last)) as Expense[]).map(normExpense).sort(byDate)
    },
    async save(e, id) {
      const c = check(e)
      return normExpense(ok(await sb.rpc('save_expense', {
        p_id: id ?? null, p_category_id: c.category_id, p_amount: c.amount, p_date: c.date, p_mode: c.mode, p_note: c.note,
      })) as Expense)
    },
    async remove(id) {
      ok(await sb.rpc('delete_expense', { p_id: id }))
    },
    async profitCosts(from, to, first, last) {
      const r = ok(await sb.rpc('profit_summary', { p_from: from.toISOString(), p_to: to.toISOString(), p_first: first, p_last: last })) as Record<string, unknown>
      return {
        charges: Number(r.charges ?? 0), charges_by_reason: numbers(r.charges_by_reason as Record<string, unknown>),
        inventory_loss: Number(r.inventory_loss ?? 0), salaries: Number(r.salaries ?? 0),
        ...(r.salary_days != null && { salary_days: Number(r.salary_days), period_days: Number(r.period_days) }),
        expenses: Number(r.expenses ?? 0), expenses_by_category: numbers(r.expenses_by_category as Record<string, unknown>),
      }
    },
    subscribe: sharedChannel(sb, 'expenses', ['expenses', 'expense_categories']),
  }
}

// ───────────── Demo mode (localStorage) ─────────────

const KEY = 'smile.expenses.v1'
const DEFAULT_CATEGORIES = ['Loyer', 'Électricité', 'Gaz', 'Eau', 'Internet', 'Entretien', 'Divers']

interface LocalExpenses {
  categories: ExpenseCategory[]
  expenses: Expense[]
}

export function readLocalExpenses(): LocalExpenses {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as LocalExpenses | null
    if (saved?.categories) return { categories: saved.categories, expenses: (saved.expenses ?? []).map(normExpense) }
  } catch {
    // Unreadable: start again.
  }
  // Saved at once, so the default categories keep their ids from one read to the next.
  const fresh = { categories: DEFAULT_CATEGORIES.map((name, i) => ({ id: newId(), name, sort_order: i + 1, active: true })), expenses: [] }
  try {
    localStorage.setItem(KEY, JSON.stringify(fresh))
  } catch {
    // Not persisted (private mode).
  }
  return fresh
}

const expenseListeners = new Set<() => void>()
export function writeLocalExpenses(db: LocalExpenses) {
  try {
    localStorage.setItem(KEY, JSON.stringify(db))
  } catch {
    // Not persisted (private mode).
  }
  expenseListeners.forEach((l) => l())
}

/** Day YYYY-MM-DD of an instant, Algiers time (now: the server's clock). */
export const localIsoDay = (d: Date = appNow()) => tzIsoDay(d)

/** Last purchase price per stock unit of each item, from the demo purchase movements. */
const lastPrices = (moves: StockMovement[]) => {
  const last = new Map<string, number>()
  for (const m of moves) if (m.type === 'purchase' && !m.voided && m.stock_item_id && m.unit_cost != null) last.set(m.stock_item_id, m.unit_cost)
  return last
}

function localExpenses(): ExpensesService {
  const edit = <T>(fn: (db: LocalExpenses) => T): T => {
    const db = readLocalExpenses()
    const out = fn(db)
    writeLocalExpenses(db)
    return out
  }
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) expenseListeners.forEach((l) => l())
  })
  // Demo: fix the cost of the lines of each order paid from now on, like the database trigger.
  onLocalOrderPaid((order, lines) => {
    snapshotLocalCosts(order.id, lines).catch(() => {
      // The sale is done; its lines simply have no cost.
    })
  })
  return {
    async categories() {
      return [...readLocalExpenses().categories].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    },
    async saveCategory(c) {
      const name = c.name.trim()
      if (!name) throw new Error(tr().errNameEmpty)
      edit((db) => {
        if (db.categories.some((x) => x.id !== c.id && x.name.trim().toLowerCase() === name.toLowerCase())) throw new Error(tr().errCategoryTaken)
        if (c.id) db.categories = db.categories.map((x) => (x.id === c.id ? { ...x, name, ...(c.active !== undefined && { active: c.active }) } : x))
        else db.categories.push({ id: newId(), name, sort_order: 100, active: true })
      })
    },
    async deleteCategory(id) {
      edit((db) => {
        db.categories = db.categories.filter((c) => c.id !== id)
        db.expenses = db.expenses.map((e) => (e.category_id === id ? { ...e, category_id: null } : e))
      })
    },
    async list(first, last) {
      return readLocalExpenses().expenses.filter((e) => e.date >= first && e.date <= last).sort(byDate)
    },
    async save(e, id) {
      const c = check(e)
      const db = readLocalExpenses()
      const category = db.categories.find((x) => x.id === c.category_id)
      if (!category) throw new Error(tr().errExpenseCategory)
      if (!id) {
        if (c.mode === 'cash') {
          const { cash } = await import('./cash')
          // The Fond de sortie creates the expense too (see cash.ts), as in the database.
          const m = await cash.addMovement({ kind: 'out', amount: c.amount, reason: c.note || category.name, expense_category_id: category.id })
          return readLocalExpenses().expenses.find((x) => x.cash_movement_id === m.id)!
        }
        const row: Expense = {
          id: newId(), category_id: category.id, category_name: category.name, amount: c.amount, date: c.date, mode: c.mode, note: c.note,
          cash_movement_id: null, user_name: await localUserName(), created_at: nowIso(),
        }
        edit((d) => d.expenses.push(row))
        return row
      }
      const old = db.expenses.find((x) => x.id === id)
      if (!old) throw new Error(tr().errExpenseCategory)
      // Like save_expense: the drawer movement follows the mode and the amount while its day is open.
      let moveId = old.cash_movement_id
      let date = old.cash_movement_id ? old.date : c.date
      if (old.cash_movement_id && c.mode === 'other') {
        const { removeLocalMovement } = await import('./cash')
        removeLocalMovement(old.cash_movement_id)
        moveId = null
        date = c.date
      } else if (old.cash_movement_id && old.amount !== c.amount) {
        const { setLocalMovementAmount } = await import('./cash')
        setLocalMovementAmount(old.cash_movement_id, c.amount)
      } else if (!old.cash_movement_id && c.mode === 'cash') {
        const { cash } = await import('./cash')
        moveId = (await cash.addMovement({ kind: 'out', amount: c.amount, reason: c.note || category.name })).id
        date = localIsoDay()
      }
      const row = { ...readLocalExpenses().expenses.find((x) => x.id === id)!, category_id: category.id, category_name: category.name, amount: c.amount, note: c.note, mode: c.mode, cash_movement_id: moveId, date }
      edit((d) => { d.expenses = d.expenses.map((x) => (x.id === id ? row : x)) })
      return row
    },
    async remove(id) {
      const old = readLocalExpenses().expenses.find((x) => x.id === id)
      if (!old) return
      if (old.cash_movement_id) {
        const { cash } = await import('./cash')
        await cash.deleteMovement(old.cash_movement_id)
      } else {
        edit((d) => { d.expenses = d.expenses.filter((x) => x.id !== id) })
      }
    },
    async profitCosts(from, to, first, last) {
      const f = from.toISOString()
      const e = to.toISOString()
      const { charges, byReason, loss } = editLocalStock((s) => {
        const prices = lastPrices(s.movements)
        let charges = 0
        let loss = 0
        const byReason: Record<string, number> = {}
        for (const m of s.movements) {
          if (m.created_at < f || m.created_at >= e || !m.stock_item_id) continue
          const cost = m.quantity * (m.unit_cost ?? prices.get(m.stock_item_id) ?? 0)
          if (m.type === 'charge') {
            charges += cost
            const r = m.reason ?? 'other'
            byReason[r] = round2((byReason[r] ?? 0) + cost)
          } else if (m.type === 'adjustment' && m.inventory_id && m.from_location) loss += cost
        }
        return { charges: round2(charges), byReason, loss: round2(loss) }
      })
      let salaries = 0
      // Like profit_summary: only the elapsed days, up to today included.
      const lastPaid = last < localIsoDay() ? last : localIsoDay()
      try {
        const payroll = JSON.parse(localStorage.getItem('smile.payroll.v1') ?? 'null') as { salaries?: Record<string, number> } | null
        const monthly = loadLocalUsers().filter((u) => u.active).reduce((s, u) => s + (payroll?.salaries?.[u.id] ?? 0), 0)
        salaries = lastPaid < first ? 0 : round2(prorate(monthly, first, lastPaid))
      } catch {
        // No demo payroll.
      }
      const expenses = readLocalExpenses().expenses.filter((x) => x.date >= first && x.date <= last)
      const byCategory: Record<string, number> = {}
      for (const x of expenses) byCategory[x.category_name] = round2((byCategory[x.category_name] ?? 0) + x.amount)
      return {
        charges, charges_by_reason: byReason, inventory_loss: loss, salaries,
        salary_days: lastPaid < first ? 0 : daysBetween(first, lastPaid), period_days: daysBetween(first, last),
        expenses: round2(expenses.reduce((s, x) => s + x.amount, 0)), expenses_by_category: byCategory,
      }
    },
    subscribe(onChange) {
      const l = () => onChange()
      expenseListeners.add(l)
      return () => {
        expenseListeners.delete(l)
      }
    },
  }
}

/** A monthly amount over the days [first, last]: each day counts 1 / (days of its month). Same rule as profit_summary(). */
/** Days from first to last, both included (ISO dates). */
export function daysBetween(first: string, last: string): number {
  const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))
  return Math.round((day(last) - day(first)) / 86_400_000) + 1
}

export function prorate(monthly: number, first: string, last: string): number {
  if (!(monthly > 0)) return 0
  // Calendar days only (no time zone involved): counted on UTC dates.
  const [y, m, d] = first.split('-').map(Number)
  const day = new Date(Date.UTC(y, m - 1, d))
  const iso = (x: Date) => x.toISOString().slice(0, 10)
  let total = 0
  for (let i = 0; i < 400 && iso(day) <= last; i++) {
    total += monthly / daysInMonth(day.getUTCFullYear(), day.getUTCMonth())
    day.setUTCDate(day.getUTCDate() + 1)
  }
  return total
}

/** Demo: cost of one portion of each line of a paid order, fixed once (fiches techniques × last purchase price). */
async function snapshotLocalCosts(orderId: string, lines: OrderLine[]) {
  let recipe: RecipeLine[] = []
  try {
    recipe = (JSON.parse(localStorage.getItem('smile.recipes.v1') ?? 'null') as { lines?: RecipeLine[] } | null)?.lines ?? []
  } catch {
    // No demo fiches.
  }
  const menu = await repo.getMenu({ includeHidden: true })
  const prices = editLocalStock((s) => lastPrices(s.movements))
  const costs = new Map<string, { cost: number; status: CostStatus }>()
  for (const l of lines) {
    const needs = consumptionNeeds([{ ...l, quantity: 1 }], menu.groups, recipe)
    let cost = 0
    let missing = false
    for (const [id, q] of needs) {
      const p = prices.get(id)
      if (p == null) missing = true
      else cost += q * p
    }
    costs.set(l.id, { cost: Math.round(cost * 10000) / 10000, status: !needs.size ? 'no_recipe' : missing ? 'no_price' : 'ok' })
  }
  const raw = localStorage.getItem('smile.orders.v1')
  if (!raw) return
  const db = JSON.parse(raw) as { lines: OrderLine[] }
  db.lines = db.lines.map((l) => (l.order_id === orderId && l.unit_cost == null && costs.has(l.id)
    ? { ...l, unit_cost: costs.get(l.id)!.cost, cost_status: costs.get(l.id)!.status } : l))
  localStorage.setItem('smile.orders.v1', JSON.stringify(db))
}

export const expenses: ExpensesService = supabase ? supabaseExpenses(supabase) : localExpenses()

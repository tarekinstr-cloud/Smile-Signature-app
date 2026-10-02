import type { SupabaseClient } from '@supabase/supabase-js'
import { sharedChannel, supabase } from './repo'
import { tr } from './i18n'
import { loadCustomers } from './customerStore'
import { newId } from './id'
import { localUserName } from './backoffice'
import { purchases } from './purchases'
import { localIsoDay, readLocalExpenses, writeLocalExpenses } from './expenses'
import { normalizeAdjustments } from './billing'
import { money } from './format'
import type { CashDay, CashMovement, CustomerSettlement, DayReport, NewCashMovement, NumberReset, Order, OrderLine, Payment, SalesData } from './types'
import { nowIso } from './tz'

/**
 * Caisse (menu Statistiques / bénéfice): working days (Fond de caisse → clôture), Fonds d'entrée / de sortie, the
 * reset of the order numbers, and the raw sales of a period for the reports. Supabase tables cash_days, cash_movements,
 * order_number_resets written only through RPCs (migration 20260930110000_cash_register.sql), or localStorage in demo mode.
 */
export interface CashService {
  /** The working day in progress, or null when the drawer is not open. */
  currentDay(): Promise<CashDay | null>
  /** Whether a working day is open, for every account (payments need one; employees cannot read the days). */
  isOpen(): Promise<boolean>
  /** Closed days whose closing falls in [from, to), newest first. */
  closedDays(from: Date, to: Date): Promise<CashDay[]>
  /** Fond de caisse: opens the day (and resets the order numbers to 1). */
  openDay(float: number): Promise<CashDay>
  /** Corrects the Fond de caisse of the open day. */
  setFloat(float: number): Promise<CashDay>
  addMovement(m: NewCashMovement): Promise<CashMovement>
  /** Removes an entry typed by mistake (open day only, not when it paid a supplier invoice). */
  deleteMovement(id: string): Promise<void>
  /** Movements of one day, or made during [from, to); oldest first. */
  movements(q: { dayId: string } | { from: Date; to: Date }): Promise<CashMovement[]>
  /** Clôturer la journée: the database computes the expected cash and the gap; the report is kept as the rapport Z. */
  closeDay(dayId: string, counted: number, report: DayReport, note: string): Promise<CashDay>
  /** Re-Initialiser le N° des Commandes: tickets, takeaway and delivery numbers start again at 1. */
  resetNumbers(): Promise<NumberReset>
  lastResets(): Promise<NumberReset[]>
  /** Orders paid in [from, to) with their lines, payments made in [from, to), and the orders still open. */
  sales(from: Date, to: Date): Promise<SalesData>
  /** Calls onChange when the drawer changes on any device (shared « cash » channel). */
  subscribe(onChange: () => void): () => void
}

const round2 = (n: number) => Math.round(n * 100) / 100
const validAmount = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1e9

/** « Espèces insuffisantes en caisse (disponible : X DA)… » from the database error insufficient_cash:<available>. */
export function insufficientCash(message: string): Error | null {
  const m = /insufficient_cash:(-?[\d.]+)/.exec(message)
  return m ? new Error(tr().errCashShort(money(Number(m[1])))) : null
}

function cashError(message: string): Error {
  const t = tr()
  const short = insufficientCash(message)
  if (short) return short
  if (/cash_days|cash_movements|order_number_resets|open_cash_day|close_cash_day|add_cash_movement|reset_order_numbers/.test(message)
    && /does not exist|schema cache|Could not find/i.test(message)) return new Error(t.errMigrationCash)
  if (/no_permission|row-level security|permission denied/i.test(message)) return new Error(t.errNoPermission)
  if (message.includes('category_not_found')) return new Error(t.errExpenseCategory)
  if (message.includes('drop_not_expense')) return new Error(t.errDropNotExpense)
  if (/p_is_drop|is_drop/.test(message) && /does not exist|schema cache|Could not find/i.test(message)) return new Error(t.errMigrationDashboard)
  if (message.includes('day_already_open')) return new Error(t.errDayAlreadyOpen)
  if (message.includes('day_already_closed')) return new Error(t.errDayAlreadyClosed)
  if (message.includes('no_open_day')) return new Error(t.errNoOpenDay)
  if (message.includes('day_closed')) return new Error(t.errDayClosed)
  if (message.includes('movement_has_invoice')) return new Error(t.errMovementInvoice)
  if (message.includes('bad_paid_amount')) return new Error(t.errPayAmount)
  if (message.includes('invoice_not_found')) return new Error(t.errInvoiceGone)
  if (message.includes('bad_amount')) return new Error(t.errCashAmount)
  return new Error(message)
}

function checkMovement(m: NewCashMovement): NewCashMovement {
  const t = tr()
  if (!(validAmount(m.amount) && m.amount > 0)) throw new Error(t.errCashAmount)
  const reason = m.reason.trim().slice(0, 300)
  if (!reason && !m.supplier_invoice_id && !m.is_drop) throw new Error(t.errCashReason)
  if ((m.supplier_invoice_id || m.expense_category_id) && m.kind !== 'out') throw new Error(t.errCashAmount)
  if (m.supplier_invoice_id && m.expense_category_id) throw new Error(t.errCashAmount)
  // A vidange (coffre) is never an expense nor an invoice payment.
  if (m.is_drop && (m.kind !== 'out' || m.supplier_invoice_id || m.expense_category_id)) throw new Error(t.errDropNotExpense)
  return {
    kind: m.kind, amount: round2(m.amount), reason, supplier_invoice_id: m.supplier_invoice_id ?? null, expense_category_id: m.expense_category_id ?? null,
    is_drop: !!m.is_drop,
  }
}

const num = (v: unknown) => (v == null ? null : Number(v))
export const normDay = (d: CashDay): CashDay => ({
  ...d, day_no: Number(d.day_no), opening_float: Number(d.opening_float),
  cash_sales: num(d.cash_sales), cash_in: num(d.cash_in), cash_out: num(d.cash_out),
  expected_cash: num(d.expected_cash), counted_cash: num(d.counted_cash), difference: num(d.difference),
  report: d.report ?? null, note: d.note ?? '',
})
const normMove = (m: CashMovement): CashMovement => ({ ...m, amount: Number(m.amount), is_drop: !!m.is_drop })
const normReset = (r: NumberReset): NumberReset => ({
  ...r, last_ticket_no: num(r.last_ticket_no), last_takeaway_no: num(r.last_takeaway_no), last_delivery_no: num(r.last_delivery_no),
})
const normOrder = (o: SalesData['orders'][number]): SalesData['orders'][number] => ({
  ...normalizeAdjustments(o), order_type: o.order_type ?? 'dine_in', total: num(o.total), delivery_fee: Number(o.delivery_fee ?? 0),
})
const normLine = (l: OrderLine): OrderLine => ({
  ...normalizeAdjustments(l),
  unit_price: Number(l.unit_price),
  quantity: Number(l.quantity),
  unit_cost: l.unit_cost == null ? null : Number(l.unit_cost),
})
const normVoid = (o: NonNullable<SalesData['voids']>[number]) => ({
  ...o, void_cash: Number(o.void_cash ?? 0), cancelled_total: o.cancelled_total == null ? null : Number(o.cancelled_total),
})
const normPayment = (p: Payment): Payment => ({ ...p, amount: Number(p.amount), received: Number(p.received), change_amount: Number(p.change_amount) })

function supabaseCash(sb: SupabaseClient): CashService {
  const check = <T>(res: { data: T; error: { message: string } | null }): T => {
    if (res.error) throw cashError(res.error.message)
    return res.data
  }
  return {
    async isOpen() {
      const res = await sb.rpc('cash_day_is_open')
      // Before migration 20260930130000_payments_need_open_day.sql the server does not check: do not block the service.
      if (res.error) return /does not exist|schema cache|Could not find/i.test(res.error.message) ? true : Promise.reject(cashError(res.error.message))
      return !!res.data
    },
    async currentDay() {
      const rows = check(await sb.from('cash_days').select('*').is('closed_at', null).limit(1)) as CashDay[]
      return rows[0] ? normDay(rows[0]) : null
    },
    async closedDays(from, to) {
      const rows = check(await sb.from('cash_days').select('*').not('closed_at', 'is', null)
        .gte('closed_at', from.toISOString()).lt('closed_at', to.toISOString()).order('closed_at', { ascending: false })) as CashDay[]
      return rows.map(normDay)
    },
    async openDay(float) {
      if (!validAmount(float)) throw new Error(tr().errCashAmount)
      return normDay(check(await sb.rpc('open_cash_day', { p_float: round2(float) })) as CashDay)
    },
    async setFloat(float) {
      if (!validAmount(float)) throw new Error(tr().errCashAmount)
      return normDay(check(await sb.rpc('set_opening_float', { p_float: round2(float) })) as CashDay)
    },
    async addMovement(m) {
      const c = checkMovement(m)
      return normMove(check(await sb.rpc('add_cash_movement', {
        p_kind: c.kind, p_amount: c.amount, p_reason: c.reason, p_supplier_invoice_id: c.supplier_invoice_id,
        p_expense_category_id: c.expense_category_id,
        // Only sent for a vidange, so a database without the dashboard migration still takes the other movements.
        ...(c.is_drop && { p_is_drop: true }),
      })) as CashMovement)
    },
    async deleteMovement(id) {
      check(await sb.rpc('delete_cash_movement', { p_id: id }))
    },
    async movements(q) {
      let query = sb.from('cash_movements').select('*').order('created_at')
      query = 'dayId' in q ? query.eq('day_id', q.dayId) : query.gte('created_at', q.from.toISOString()).lt('created_at', q.to.toISOString())
      return (check(await query) as CashMovement[]).map(normMove)
    },
    async closeDay(dayId, counted, report, note) {
      if (!validAmount(counted)) throw new Error(tr().errCashAmount)
      return normDay(check(await sb.rpc('close_cash_day', {
        p_day_id: dayId, p_counted: round2(counted), p_report: report, p_note: note.trim(),
      })) as CashDay)
    },
    async resetNumbers() {
      return normReset(check(await sb.rpc('reset_order_numbers')) as NumberReset)
    },
    async lastResets() {
      return (check(await sb.from('order_number_resets').select('*').order('created_at', { ascending: false }).limit(10)) as NumberReset[]).map(normReset)
    },
    async sales(from, to) {
      const [paid, pays, open] = await Promise.all([
        sb.from('orders').select('*').eq('status', 'paid').gte('closed_at', from.toISOString()).lt('closed_at', to.toISOString()),
        sb.from('payments').select('*').gte('created_at', from.toISOString()).lt('created_at', to.toISOString()),
        sb.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'open'),
      ])
      const orders = (check(paid) as SalesData['orders']).map(normOrder)
      if (open.error) throw cashError(open.error.message)
      const lines: OrderLine[] = []
      // URL-sized batches rather than one huge `in (…)` on busy periods.
      for (let i = 0; i < orders.length; i += 100) {
        const ids = orders.slice(i, i + 100).map((o) => o.id)
        lines.push(...(check(await sb.from('order_items').select('*').in('order_id', ids)) as OrderLine[]).map(normLine))
      }
      // Tickets cancelled after payment (migration 20260930140000_control.sql; none before it).
      const voided = await sb.from('orders').select('*').eq('status', 'cancelled').eq('voided', true)
        .gte('cancelled_at', from.toISOString()).lt('cancelled_at', to.toISOString())
      const voids = voided.error ? [] : (voided.data as NonNullable<SalesData['voids']>).map(normVoid)
      // Règlements crédit reçus (menu Clients, migration 20261009000000; none before it).
      const settled = await sb.from('customer_settlements').select('*').gte('created_at', from.toISOString()).lt('created_at', to.toISOString())
      const settlements = settled.error ? [] : (settled.data as CustomerSettlement[]).map((x) => ({ ...x, amount: Number(x.amount) }))
      return { orders, lines, payments: (check(pays) as Payment[]).map(normPayment), openOrders: open.count ?? 0, voids, settlements }
    },
    subscribe: sharedChannel(sb, 'cash', ['cash_days', 'cash_movements']),
  }
}

// ───────────── Demo mode (localStorage) ─────────────

const KEY = 'smile.cash.v1'
/** Demo orders (repo.ts), read for the reports and to reset their numbers. */
const ORDERS_KEY = 'smile.orders.v1'

interface LocalCash {
  days: CashDay[]
  movements: CashMovement[]
  resets: NumberReset[]
}

function readOrders(): LocalOrders {
  try {
    return (JSON.parse(localStorage.getItem(ORDERS_KEY) ?? 'null') as LocalOrders | null) ?? {}
  } catch {
    return {}
  }
}

interface LocalOrders {
  orders?: (Order & { total?: number | null; closed_at?: string | null })[]
  lines?: OrderLine[]
  payments?: Payment[]
  lastTicket?: number
  lastTakeaway?: number
  lastDelivery?: number
}

const localListeners = new Set<() => void>()
const readLocalCash = (): LocalCash => {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<LocalCash> | null
    return { days: (saved?.days ?? []).map(normDay), movements: (saved?.movements ?? []).map(normMove), resets: saved?.resets ?? [] }
  } catch {
    return { days: [], movements: [], resets: [] }
  }
}
const writeLocalCash = (db: LocalCash) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(db))
  } catch {
    // Not persisted (private mode); the change is lost on reload.
  }
  localListeners.forEach((l) => l())
}

/** Demo mode: cash taken from the drawer for a supplier invoice (its Fonds de sortie − what already came back). */
export function localSupplierCash(invoiceId: string): number {
  return round2(readLocalCash().movements
    .filter((m) => m.supplier_invoice_id === invoiceId)
    .reduce((s, m) => s + (m.kind === 'out' ? m.amount : -m.amount), 0))
}

/**
 * Demo mode, like cancel_supplier_invoice(): the cash paid from the drawer for a cancelled supplier invoice comes back
 * as a Fond d'entrée of the open day. `check` only verifies that a day is open. Returns the amount.
 */
export function localSupplierRefund(invoiceId: string, reason: string, supplier: string, user: string, check = false): number {
  const amount = localSupplierCash(invoiceId)
  if (amount <= 0) return 0
  const db = readLocalCash()
  const day = db.days.find((d) => !d.closed_at)
  if (!day) throw new Error(tr().errRefundNoOpenDay)
  if (check) return amount
  db.movements.push({
    id: newId(), day_id: day.id, kind: 'in', amount, reason, supplier_invoice_id: invoiceId, supplier_name: supplier, user_name: user,
    created_at: nowIso(),
  })
  writeLocalCash(db)
  return amount
}

/** Demo mode, like replace_supplier_invoice(): the drawer payments of a corrected invoice now belong to its replacement. */
export function localMoveSupplierCash(fromId: string, toId: string) {
  const db = readLocalCash()
  if (!db.movements.some((m) => m.supplier_invoice_id === fromId)) return
  for (const m of db.movements) if (m.supplier_invoice_id === fromId) m.supplier_invoice_id = toId
  writeLocalCash(db)
}

function localCash(): CashService {
  const listeners = localListeners
  const read = readLocalCash
  const write = writeLocalCash
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) listeners.forEach((l) => l())
  })
  /**
   * Numbers back to 1. At the opening (`since` = the day's period_start), the numbers already given since the previous
   * closing go on, like open_cash_day(): a sale paid while the drawer was closed belongs to the day and keeps its number.
   */
  const reset = (reason: NumberReset['reason'], user: string, since?: string): NumberReset => {
    const o = readOrders()
    const row: NumberReset = {
      id: newId(), reason, last_ticket_no: o.lastTicket ?? null, last_takeaway_no: o.lastTakeaway ?? null, last_delivery_no: o.lastDelivery ?? null,
      user_name: user, created_at: nowIso(),
    }
    const max = (f: (x: NonNullable<LocalOrders['orders']>[number]) => number | null | undefined) =>
      since ? (o.orders ?? []).reduce((m, x) => Math.max(m, Number(f(x) ?? 0) || 0), 0) : 0
    const after = (iso: string | null | undefined) => !!iso && !!since && iso >= since
    try {
      localStorage.setItem(ORDERS_KEY, JSON.stringify({
        ...o,
        lastTicket: max((x) => (after(x.closed_at) ? (x as { ticket_no?: number | null }).ticket_no : 0)),
        lastTakeaway: max((x) => (after(x.created_at) ? x.takeaway_no : 0)),
        lastDelivery: max((x) => (after(x.created_at) ? x.delivery_no : 0)),
      }))
    } catch {
      // Storage blocked: the numbers go on.
    }
    return row
  }
  const openDay = (db: LocalCash) => db.days.find((d) => !d.closed_at) ?? null
  const now = () => nowIso()

  return {
    async currentDay() {
      return openDay(read())
    },
    async isOpen() {
      return !!openDay(read())
    },
    async closedDays(from, to) {
      return read().days
        .filter((d) => d.closed_at && new Date(d.closed_at) >= from && new Date(d.closed_at) < to)
        .sort((a, b) => b.closed_at!.localeCompare(a.closed_at!))
    },
    async openDay(float) {
      if (!validAmount(float)) throw new Error(tr().errCashAmount)
      const user = await localUserName()
      const db = read()
      if (openDay(db)) throw new Error(tr().errDayAlreadyOpen)
      const lastClose = db.days.map((d) => d.closed_at ?? '').sort().at(-1)
      const day: CashDay = {
        id: newId(), day_no: db.days.reduce((n, d) => Math.max(n, d.day_no), 0) + 1, period_start: lastClose || now(), opened_at: now(),
        opened_by_name: user, opening_float: round2(float), float_updated_at: null, float_updated_by_name: null,
        closed_at: null, closed_by_name: null, cash_sales: null, cash_in: null, cash_out: null, expected_cash: null, counted_cash: null,
        difference: null, report: null, note: '',
      }
      db.days.push(day)
      db.resets.push(reset('day_open', user, day.period_start))
      write(db)
      return day
    },
    async setFloat(float) {
      if (!validAmount(float)) throw new Error(tr().errCashAmount)
      const user = await localUserName()
      const db = read()
      const day = openDay(db)
      if (!day) throw new Error(tr().errNoOpenDay)
      if (round2(float) < day.opening_float) requireLocalCash(db, day, day.opening_float - round2(float))
      Object.assign(day, { opening_float: round2(float), float_updated_at: now(), float_updated_by_name: user })
      write(db)
      return day
    },
    async addMovement(m) {
      const c = checkMovement(m)
      const user = await localUserName()
      const db = read()
      const day = openDay(db)
      if (!day) throw new Error(tr().errNoOpenDay)
      if (c.kind === 'out') requireLocalCash(db, day, c.amount)
      let supplier: string | null = null
      if (c.supplier_invoice_id) supplier = (await purchases.pay(c.supplier_invoice_id, c.amount, now().slice(0, 10))).supplier_name
      const row: CashMovement = {
        id: newId(), day_id: day.id, kind: c.kind, amount: c.amount, reason: c.reason || (c.is_drop ? tr().dropReason : ''), supplier_invoice_id: c.supplier_invoice_id ?? null,
        supplier_name: supplier, user_name: user, created_at: now(), is_drop: !!c.is_drop,
      }
      const fresh = read()
      fresh.movements.push(row)
      write(fresh)
      if (c.expense_category_id) {
        const ex = readLocalExpenses()
        const category = ex.categories.find((x) => x.id === c.expense_category_id)
        if (category) {
          ex.expenses.push({
            id: newId(), category_id: category.id, category_name: category.name, amount: row.amount, date: localIsoDay(), mode: 'cash',
            note: row.reason, cash_movement_id: row.id, user_name: user, created_at: row.created_at,
          })
          writeLocalExpenses(ex)
        }
      }
      return row
    },
    async deleteMovement(id) {
      const db = read()
      const row = db.movements.find((m) => m.id === id)
      if (!row) return
      if (db.days.find((d) => d.id === row.day_id)?.closed_at) throw new Error(tr().errDayClosed)
      if (row.supplier_invoice_id) throw new Error(tr().errMovementInvoice)
      if (row.kind === 'in') requireLocalCash(db, db.days.find((d) => d.id === row.day_id)!, row.amount)
      db.movements = db.movements.filter((m) => m.id !== id)
      write(db)
      // Like the database: the expense paid by this movement goes with it.
      const ex = readLocalExpenses()
      if (ex.expenses.some((e) => e.cash_movement_id === id)) {
        ex.expenses = ex.expenses.filter((e) => e.cash_movement_id !== id)
        writeLocalExpenses(ex)
      }
    },
    async movements(q) {
      return read().movements
        .filter((m) => ('dayId' in q ? m.day_id === q.dayId : new Date(m.created_at) >= q.from && new Date(m.created_at) < q.to))
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
    },
    async closeDay(dayId, counted, report, note) {
      if (!validAmount(counted)) throw new Error(tr().errCashAmount)
      const user = await localUserName()
      const db = read()
      const day = db.days.find((d) => d.id === dayId)
      if (!day) throw new Error(tr().errNoOpenDay)
      if (day.closed_at) throw new Error(tr().errDayAlreadyClosed)
      const closedAt = now()
      const sales = round2((readOrders().payments ?? [])
        .filter((p) => p.method === 'cash' && p.created_at >= day.period_start && p.created_at < closedAt)
        .reduce((s, p) => s + Number(p.amount), 0))
      const mine = db.movements.filter((m) => m.day_id === day.id)
      const sum = (k: 'in' | 'out') => round2(mine.filter((m) => m.kind === k).reduce((s, m) => s + m.amount, 0))
      const expected = round2(day.opening_float + sales + sum('in') - sum('out'))
      Object.assign(day, {
        closed_at: closedAt, closed_by_name: user, cash_sales: sales, cash_in: sum('in'), cash_out: sum('out'), expected_cash: expected,
        counted_cash: round2(counted), difference: round2(counted - expected), report, note: note.trim(),
      })
      write(db)
      return day
    },
    async resetNumbers() {
      const db = read()
      const row = reset('manual', await localUserName())
      db.resets.push(row)
      write(db)
      return row
    },
    async lastResets() {
      return [...read().resets].reverse().slice(0, 10).map(normReset)
    },
    async sales(from, to) {
      const o = readOrders()
      const inRange = (iso?: string | null) => !!iso && new Date(iso) >= from && new Date(iso) < to
      const orders = (o.orders ?? [])
        .filter((x) => x.status === 'paid' && inRange(x.closed_at))
        .map((x) => normOrder({ ...x, total: x.total ?? null, closed_at: x.closed_at ?? null }))
      const ids = new Set(orders.map((x) => x.id))
      return {
        orders,
        lines: (o.lines ?? []).filter((l) => ids.has(l.order_id)).map(normLine),
        payments: (o.payments ?? []).filter((p) => inRange(p.created_at)).map(normPayment),
        openOrders: (o.orders ?? []).filter((x) => x.status === 'open').length,
        voids: (o.orders ?? []).filter((x) => x.status === 'cancelled' && x.voided && inRange(x.cancelled_at))
          .map((x) => normVoid({ ...x, cancelled_at: x.cancelled_at ?? null })),
        settlements: loadCustomers().settlements.filter((x) => inRange(x.created_at)).map(({ items: _, ...x }) => x),
      }
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

/** Demo mode: an expense paid from the drawer changed its amount while its day is open (the database does it in save_expense). */
export function setLocalMovementAmount(id: string, amount: number) {
  const raw = localStorage.getItem(KEY)
  const db = raw ? (JSON.parse(raw) as LocalCash) : null
  const m = db?.movements.find((x) => x.id === id)
  if (!db || !m) return
  const day = db.days.find((d) => d.id === m.day_id)
  if (!day || day.closed_at) throw new Error(tr().errExpenseDayClosed)
  if (round2(amount) > m.amount) requireLocalCash(db, day, round2(amount) - m.amount)
  m.amount = round2(amount)
  localStorage.setItem(KEY, JSON.stringify(db))
  window.dispatchEvent(new StorageEvent('storage', { key: KEY }))
}

/** Demo mode: an expense paid from the drawer switched to « Autre » while its day is open: its Fond de sortie goes, the expense stays. */
export function removeLocalMovement(id: string) {
  const raw = localStorage.getItem(KEY)
  const db = raw ? (JSON.parse(raw) as LocalCash) : null
  const m = db?.movements.find((x) => x.id === id)
  if (!db || !m) return
  if (db.days.find((d) => d.id === m.day_id)?.closed_at) throw new Error(tr().errExpenseDayClosed)
  db.movements = db.movements.filter((x) => x.id !== id)
  localStorage.setItem(KEY, JSON.stringify(db))
  window.dispatchEvent(new StorageEvent('storage', { key: KEY }))
}

/** Demo mode: cash expected in the drawer now (float + cash sales + entrées − sorties), as cash_available() does. */
function localAvailable(db: LocalCash, day: CashDay): number {
  const sales = (readOrders().payments ?? [])
    .filter((p) => p.method === 'cash' && p.created_at >= day.period_start)
    .reduce((s, p) => s + Number(p.amount), 0)
  const mine = db.movements.filter((m) => m.day_id === day.id)
  const moves = mine.reduce((s, m) => s + (m.kind === 'in' ? m.amount : -m.amount), 0)
  return round2(day.opening_float + sales + moves)
}

function requireLocalCash(db: LocalCash, day: CashDay, amount: number) {
  const available = localAvailable(db, day)
  if (round2(amount) > available) throw new Error(tr().errCashShort(money(available)))
}

export const cash: CashService = supabase ? supabaseCash(supabase) : localCash()

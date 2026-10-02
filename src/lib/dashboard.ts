import { cash } from './cash'
import { repo } from './repo'
import { customers } from './customers'
import { payroll } from './payroll'
import { purchases, isCancelled, netTotal } from './purchases'
import { expenses, localIsoDay } from './expenses'
import { computeBill, splitTva } from './billing'
import { categoryOfItems, computeDayReport } from './dayReport'
import { computeProfit, type ProfitReport } from './profit'
import { loadLive } from './liveDay'
import { da } from './format'
import type {
  CancelledOrder, CashDay, CashMovement, DayReport, Menu, Order, OrderType, Payment, ProfitCosts, ReceiptSettings, SalesData,
} from './types'

/**
 * Tableau de bord: everything of a period in one place, computed with the existing reports (Statistique Journalier,
 * Bénéfice, caisse, Clients) rather than new formulas. Loaded once per period; the filters are applied in memory.
 */

/** Type filter: an order type, or « Vidanges » (the list shows the cash drops of the period). */
export type DashType = 'all' | OrderType | 'drops'
export interface DashFilters {
  type: DashType
  /** Payment mode code; '' for all. */
  method: string
  /** Commande lancée par (order's waiter); '' for all. */
  launchedBy: string
  /** Encaissée par (employee who took a payment); '' for all. */
  cashedBy: string
  /** Optional hours, HH:MM (e.g. 18:00–23:00); an end before the start goes over midnight. */
  hourFrom: string
  hourTo: string
}
export const noFilters = (): DashFilters => ({ type: 'all', method: '', launchedBy: '', cashedBy: '', hourFrom: '', hourTo: '' })

export interface DashboardData {
  from: Date
  to: Date
  sales: SalesData
  cancelled: CancelledOrder[]
  moves: CashMovement[]
  /** Working days of the period (closed in it, plus the day in progress). */
  days: CashDay[]
  /** Espèces attendues of the day in progress (live), null without an open day. */
  liveExpected: number | null
  /** Dettes clients: what customers owe now (credit not settled). */
  debts: number
  /** Salary advances paid in the period. */
  advances: number
  /** Supplier purchases dated in the period (net of returns, cancelled ones left out). */
  purchases: number
  costs: ProfitCosts | null
  menu: Menu | null
  receipt: ReceiptSettings | null
}

const isoDay = (d: Date) => localIsoDay(d)
/** Last day included in [from, to): the day before `to`. */
const lastDay = (to: Date) => isoDay(new Date(to.getTime() - 1))

/** Months (YYYY-MM) touched by [from, to). */
function months(from: Date, to: Date): string[] {
  const out: string[] = []
  const d = new Date(from.getFullYear(), from.getMonth(), 1)
  while (d < to && out.length < 36) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
    d.setMonth(d.getMonth() + 1)
  }
  return out
}

/** A part of the dashboard the account may not read (or not migrated yet) is shown empty, not as a failure. */
const soft = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback)

export async function loadDashboard(from: Date, to: Date): Promise<DashboardData> {
  const [first, last] = [isoDay(from), lastDay(to)]
  const [sales, cancelled, moves, current, closed, balances, advanceLists, invoices, costs, menu, receipt] = await Promise.all([
    cash.sales(from, to),
    soft(repo.listCancelled(from, to), []),
    soft(cash.movements({ from, to }), []),
    soft(cash.currentDay(), null),
    soft(cash.closedDays(from, to), []),
    soft(customers.balances(), []),
    Promise.all(months(from, to).map((m) => soft(payroll.advances(m), []))),
    soft(purchases.listInvoices(), []),
    soft(expenses.profitCosts(from, to, first, last), null),
    soft(repo.getMenu({ includeHidden: true }), null),
    soft(repo.getReceiptSettings(), null),
  ])
  // The day in progress counts when it overlaps the period (opened before its end).
  const days = [...closed]
  if (current && new Date(current.opened_at) < to && !days.some((d) => d.id === current.id)) days.push(current)
  const liveExpected = current && days.some((d) => d.id === current.id) ? await soft(loadLive().then((l) => l.report.cash?.expected ?? null), null) : null
  return {
    from, to, sales, cancelled, moves, days, liveExpected, menu, receipt, costs,
    debts: da(balances.reduce((s, b) => s + b.due, 0)),
    advances: da(advanceLists.flat().filter((a) => a.date >= first && a.date <= last).reduce((s, a) => s + Number(a.amount), 0)),
    purchases: da(invoices.filter((i) => !isCancelled(i) && i.date >= first && i.date <= last).reduce((s, i) => s + netTotal(i), 0)),
  }
}

const minutes = (hhmm: string) => {
  if (!hhmm.trim()) return null
  const [h, m] = hhmm.split(':').map(Number)
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : null
}

/** Whether an instant is in the hours of the filter (local time); always true without hours. */
export function inHours(iso: string | null | undefined, f: Pick<DashFilters, 'hourFrom' | 'hourTo'>): boolean {
  const a = minutes(f.hourFrom)
  const b = minutes(f.hourTo)
  if (a === null && b === null) return true
  if (!iso) return false
  const d = new Date(iso)
  const m = d.getHours() * 60 + d.getMinutes()
  const start = a ?? 0
  const end = b ?? 24 * 60
  return start <= end ? m >= start && m < end : m >= start || m < end
}

const filtersActive = (f: DashFilters) => f.type !== 'all' && f.type !== 'drops' || !!(f.method || f.launchedBy || f.cashedBy || f.hourFrom || f.hourTo)

/** The period's sales with the dashboard filters applied (orders, their lines and payments). */
export function filterSales(sales: SalesData, f: DashFilters): SalesData {
  if (!filtersActive(f)) return sales
  const paysOf = new Map<string, Payment[]>()
  for (const p of sales.payments) (paysOf.get(p.order_id) ?? paysOf.set(p.order_id, []).get(p.order_id)!).push(p)
  const orders = sales.orders.filter((o) => {
    if (f.type !== 'all' && f.type !== 'drops' && o.order_type !== f.type) return false
    if (f.launchedBy && (o.created_by_name ?? '') !== f.launchedBy) return false
    const pays = paysOf.get(o.id) ?? []
    if (f.method && !pays.some((p) => p.method === f.method)) return false
    if (f.cashedBy && !pays.some((p) => (p.created_by_name ?? '') === f.cashedBy)) return false
    return inHours(o.closed_at, f)
  })
  const ids = new Set(orders.map((o) => o.id))
  return {
    ...sales, orders,
    lines: sales.lines.filter((l) => ids.has(l.order_id)),
    payments: sales.payments.filter((p) => ids.has(p.order_id) && (!f.method || p.method === f.method) && (!f.cashedBy || (p.created_by_name ?? '') === f.cashedBy)),
    voids: (sales.voids ?? []).filter((v) => (f.type === 'all' || f.type === 'drops' || v.order_type === f.type) && inHours(v.cancelled_at, f)),
  }
}

/** One paid order in the list of the dashboard. */
export interface DashOrder {
  order: SalesData['orders'][number]
  /** Normal price of the lines (before discounts and offers). */
  gross: number
  /** Discounts and offers. */
  discount: number
  delivery: number
  net: number
  methods: string[]
  cashiers: string[]
}

export function orderRows(sales: SalesData): DashOrder[] {
  const linesOf = new Map<string, SalesData['lines']>()
  for (const l of sales.lines) (linesOf.get(l.order_id) ?? linesOf.set(l.order_id, []).get(l.order_id)!).push(l)
  const paysOf = new Map<string, Payment[]>()
  for (const p of sales.payments) (paysOf.get(p.order_id) ?? paysOf.set(p.order_id, []).get(p.order_id)!).push(p)
  return sales.orders.map((o) => {
    const bill = computeBill(o, linesOf.get(o.id) ?? [])
    const net = da(o.total ?? bill.total)
    const pays = paysOf.get(o.id) ?? []
    return {
      order: o, gross: da(bill.gross), delivery: da(bill.delivery), net,
      discount: da(bill.gross + bill.delivery - net),
      methods: [...new Set(pays.map((p) => p.method))],
      cashiers: [...new Set(pays.map((p) => p.created_by_name ?? '').filter(Boolean))],
    }
  })
}

export type ChartMode = 'day' | 'week' | 'month' | 'weekday' | 'hour'
export interface ChartPoint {
  key: string
  amount: number
  orders: number
}

const pad = (n: number) => String(n).padStart(2, '0')

/** CA of the orders grouped by day, week (from Monday), month, day of the week (Monday first) or hour. */
export function chartSeries(rows: DashOrder[], mode: ChartMode, from: Date, to: Date): ChartPoint[] {
  const keyOf = (iso: string) => {
    const d = new Date(iso)
    if (mode === 'hour') return pad(d.getHours())
    if (mode === 'weekday') return String((d.getDay() + 6) % 7)
    if (mode === 'month') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
    if (mode === 'week') {
      const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
      return isoDay(monday)
    }
    return isoDay(d)
  }
  const map = new Map<string, ChartPoint>()
  // Every slot of the period, so a day without sales shows as zero.
  const slots: string[] = []
  if (mode === 'hour') for (let h = 0; h < 24; h++) slots.push(pad(h))
  else if (mode === 'weekday') for (let w = 0; w < 7; w++) slots.push(String(w))
  else {
    const d = new Date(from)
    while (d < to && slots.length < 400) {
      const k = keyOf(d.toISOString())
      if (!slots.includes(k)) slots.push(k)
      d.setDate(d.getDate() + 1)
    }
  }
  for (const k of slots) map.set(k, { key: k, amount: 0, orders: 0 })
  for (const r of rows) {
    if (!r.order.closed_at) continue
    const k = keyOf(r.order.closed_at)
    const p = map.get(k) ?? { key: k, amount: 0, orders: 0 }
    p.amount += r.net
    p.orders++
    map.set(k, p)
  }
  const out = [...map.values()]
  return mode === 'hour' || mode === 'weekday' ? out : out.sort((a, b) => a.key.localeCompare(b.key))
}

/** One employee in the Rapport Serveur / Rapport Caissier. */
export interface StaffRow {
  name: string
  orders: number
  sales: number
  discounts: number
  offered: number
  cancelled: number
  cancelledAmount: number
  /** Encaissements by payment mode. */
  payments: Record<string, number>
}

/**
 * Rapport Serveur (by who launched the orders) or Rapport Caissier (by who took the payments): orders, CA, discounts,
 * offers, cancellations and payments by mode.
 */
export function staffReport(kind: 'server' | 'cashier', sales: SalesData, cancelled: CancelledOrder[], unknown: string): StaffRow[] {
  const rows = new Map<string, StaffRow>()
  const row = (name: string) => {
    const k = name.trim() || unknown
    const r = rows.get(k) ?? { name: k, orders: 0, sales: 0, discounts: 0, offered: 0, cancelled: 0, cancelledAmount: 0, payments: {} }
    rows.set(k, r)
    return r
  }
  const linesOf = new Map<string, SalesData['lines']>()
  for (const l of sales.lines) (linesOf.get(l.order_id) ?? linesOf.set(l.order_id, []).get(l.order_id)!).push(l)
  const paysOf = new Map<string, Payment[]>()
  for (const p of sales.payments) (paysOf.get(p.order_id) ?? paysOf.set(p.order_id, []).get(p.order_id)!).push(p)
  for (const o of sales.orders) {
    const bill = computeBill(o, linesOf.get(o.id) ?? [])
    const pays = paysOf.get(o.id) ?? []
    // A cashier is credited with the order they closed (the last payment).
    const who = kind === 'server' ? o.created_by_name ?? '' : pays.at(-1)?.created_by_name ?? ''
    const r = row(who)
    r.orders++
    r.sales += o.total ?? bill.total
    r.discounts += bill.lineDiscounts + bill.orderDiscount
    r.offered += bill.offered
  }
  for (const p of sales.payments) {
    const o = sales.orders.find((x) => x.id === p.order_id)
    const who = kind === 'server' ? o?.created_by_name ?? '' : p.created_by_name ?? ''
    const r = row(who)
    r.payments[p.method] = (r.payments[p.method] ?? 0) + p.amount
  }
  for (const c of cancelled) {
    const r = row(kind === 'server' ? c.created_by_name ?? '' : c.cancelled_by_name ?? '')
    r.cancelled++
    r.cancelledAmount += c.cancelled_total ?? 0
  }
  return [...rows.values()]
    .map((r) => ({ ...r, sales: da(r.sales), discounts: da(r.discounts), offered: da(r.offered), cancelledAmount: da(r.cancelledAmount), payments: Object.fromEntries(Object.entries(r.payments).map(([k, v]) => [k, da(v)])) }))
    .sort((a, b) => b.sales - a.sales)
}

/** Everything shown on the dashboard for the data and the filters. */
export interface DashboardView {
  sales: SalesData
  report: DayReport
  profit: ProfitReport | null
  rows: DashOrder[]
  tiles: {
    float: number
    guests: number
    sales: number
    cashIn: number
    expectedCash: number | null
    debts: number
    staff: number
    purchases: number
    cashOut: number
    drops: number
    profit: number | null
    cancelledCount: number
    cancelledAmount: number
  }
  drops: CashMovement[]
  cancelled: CancelledOrder[]
  totals: { discounts: number; delivery: number; net: number }
  tva: { ht: number; tva: number; ttc: number; rate: number } | null
  /** Names for the filters. */
  waiters: string[]
  cashiers: string[]
}

export function dashboardView(data: DashboardData, f: DashFilters): DashboardView {
  const sales = filterSales(data.sales, f)
  const report = computeDayReport(sales, categoryOfItems(data.menu), data.from.toISOString(), data.to.toISOString(), null, null)
  const profit = data.costs ? computeProfit(sales, data.menu, data.costs) : null
  const rows = orderRows(sales)
  const moves = data.moves.filter((m) => inHours(m.created_at, f))
  const drops = moves.filter((m) => m.kind === 'out' && m.is_drop)
  const cancelled = data.cancelled.filter((c) => (f.type === 'all' || f.type === 'drops' || c.order_type === f.type)
    && (!f.launchedBy || (c.created_by_name ?? '') === f.launchedBy) && inHours(c.cancelled_at, f))
  const sum = (list: CashMovement[]) => da(list.reduce((s, m) => s + m.amount, 0))
  const closedExpected = data.days.filter((d) => d.closed_at).reduce((s, d) => s + (d.expected_cash ?? 0), 0)
  const rate = data.receipt?.tva_enabled ? data.receipt.tva_rate ?? 0 : null
  return {
    sales, report, profit, rows, drops, cancelled,
    tiles: {
      float: da(data.days.reduce((s, d) => s + d.opening_float, 0)),
      guests: report.guests ?? 0,
      sales: report.net,
      cashIn: sum(moves.filter((m) => m.kind === 'in')),
      expectedCash: data.days.length ? da(closedExpected + (data.liveExpected ?? 0)) : null,
      debts: data.debts,
      staff: data.advances,
      purchases: data.purchases,
      cashOut: sum(moves.filter((m) => m.kind === 'out' && !m.is_drop)),
      drops: sum(drops),
      profit: profit ? profit.netProfit : null,
      cancelledCount: cancelled.length,
      cancelledAmount: da(cancelled.reduce((s, c) => s + (c.cancelled_total ?? 0), 0)),
    },
    totals: {
      discounts: da(rows.reduce((s, r) => s + r.discount, 0)),
      delivery: da(rows.reduce((s, r) => s + r.delivery, 0)),
      net: da(rows.reduce((s, r) => s + r.net, 0)),
    },
    tva: rate === null ? null : { ...splitTva(report.net, rate), rate },
    waiters: [...new Set(data.sales.orders.map((o) => o.created_by_name ?? '').filter(Boolean))].sort(),
    cashiers: [...new Set(data.sales.payments.map((p) => p.created_by_name ?? '').filter(Boolean))].sort(),
  }
}

/** Order N° shown in the list: the ticket, else the takeaway / delivery number. */
export const dashOrderNo = (o: Order & { ticket_no?: number | null }) => o.ticket_no ?? o.takeaway_no ?? o.delivery_no ?? null

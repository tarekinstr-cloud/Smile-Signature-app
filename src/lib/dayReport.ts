import { computeBill } from './billing'
import { csvDa, da } from './format'
import { tr } from './i18n'
import type { CashSummary, DayReport, Menu, OrderLine, OrderType, SalesData, SalesRow } from './types'

const cents = (n: number) => Math.round(n * 100) / 100

/**
 * People served by a table order: its couverts, or 1 when they were not given. Takeaway and delivery orders have no
 * number of people: 0.
 */
export const guestsOf = (o: { guests?: number | null; order_type?: string | null }) => {
  if (o.order_type && o.order_type !== 'dine_in') return 0
  const n = Math.round(Number(o.guests ?? 0))
  return n >= 1 ? n : 1
}

/** Category name of each menu item (hidden ones included), for "ventes par catégorie". */
export function categoryOfItems(menu: Menu | null): Map<string, string> {
  const cats = new Map((menu?.categories ?? []).map((c) => [c.id, c.name]))
  return new Map((menu?.items ?? []).map((i) => [i.id, cats.get(i.category_id) ?? '']))
}

/** Espèces attendues en caisse, in whole dinars. */
export function cashSummary(opening: number, sales: number, cashIn: number, cashOut: number): CashSummary {
  const [o, s, i, x] = [da(opening), da(sales), da(cashIn), da(cashOut)]
  return { opening: o, sales: s, in: i, out: x, expected: o + s + i - x }
}

const add = (map: Map<string, SalesRow>, key: string, row: Omit<SalesRow, 'quantity' | 'amount' | 'orders'>, quantity: number, amount: number, orders = 0) => {
  const r = map.get(key) ?? { ...row, quantity: 0, amount: 0 }
  r.quantity = cents(r.quantity + quantity)
  r.amount = r.amount + amount
  if (orders) r.orders = (r.orders ?? 0) + orders
  map.set(key, r)
}
/**
 * Rows in whole dinars that still add up to their rounded total (largest remainder): shares of an order discount
 * can leave centimes on each line.
 */
function wholeDinars(rows: SalesRow[]): SalesRow[] {
  const target = da(rows.reduce((s, r) => s + r.amount, 0))
  const out = rows.map((r) => ({ ...r, amount: Math.floor(r.amount) }))
  let left = target - out.reduce((s, r) => s + r.amount, 0)
  const order = rows.map((r, i) => ({ i, frac: r.amount - Math.floor(r.amount) })).sort((a, b) => b.frac - a.frac)
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k].i].amount += 1
  return out
}
const byAmount = (a: SalesRow, b: SalesRow) => b.amount - a.amount || b.quantity - a.quantity || a.name.localeCompare(b.name)

/**
 * Figures of a period from its paid orders, their lines and its payments (Statistique Journalier, rapport Z).
 * Line amounts are what the customer paid for them: their own discount and offer, then their share of the order's
 * discount, so items and categories add up to the net sales (delivery fees apart).
 */
/**
 * Report of a period. `openedAt`: when the drawer was opened; orders paid and cash taken before it (drawer closed)
 * are counted and flagged as « ventes encaissées caisse fermée ».
 */
export function computeDayReport(
  data: SalesData, categories: Map<string, string>, from: string, to: string, cash: CashSummary | null, openedAt?: string | null,
): DayReport {
  const t = tr()
  const byOrder = new Map<string, OrderLine[]>()
  for (const l of data.lines) (byOrder.get(l.order_id) ?? byOrder.set(l.order_id, []).get(l.order_id)!).push(l)
  const items = new Map<string, SalesRow>()
  const cats = new Map<string, SalesRow>()
  const employees = new Map<string, SalesRow>()
  const drivers = new Map<string, SalesRow>()
  const byType: DayReport['byType'] = { dine_in: { orders: 0, amount: 0, guests: 0 }, takeaway: { orders: 0, amount: 0 }, delivery: { orders: 0, amount: 0 } }
  let guests = 0
  /** Sales of the tables: the ticket moyen par personne counts only them (the others have no number of people). */
  let dineNet = 0
  let gross = 0, discounts = 0, offered = 0, delivery = 0, net = 0

  for (const o of data.orders) {
    const bill = computeBill(o, byOrder.get(o.id) ?? [])
    const total = o.total ?? bill.total
    gross += bill.gross
    offered += bill.offered
    discounts += bill.lineDiscounts + bill.orderDiscount
    delivery += bill.delivery
    net += total
    const type: OrderType = o.order_type ?? 'dine_in'
    byType[type].orders += 1
    // An order without its number of people counts as one person.
    const people = guestsOf(o)
    if (type === 'dine_in') byType[type].guests = (byType[type].guests ?? 0) + people
    guests += people
    if (type === 'dine_in') dineNet += total
    byType[type].amount = da(byType[type].amount + total)
    const who = o.created_by_name?.trim() || t.dayUnknownEmployee
    add(employees, who, { name: who }, 0, total, 1)
    if (type === 'delivery') {
      const driver = o.driver_name?.trim() || t.dayNoDriver
      add(drivers, driver, { name: driver }, 0, total, 1)
    }
    // Share of the order discount on each line, so the lines add up to what was paid for the food.
    const ratio = bill.subtotal > 0 ? (bill.subtotal - bill.orderDiscount) / bill.subtotal : 0
    for (const b of bill.lines) {
      const amount = b.net * ratio
      const category = (b.line.item_id && categories.get(b.line.item_id)) || t.dayOtherCategory
      add(items, `${category}\u0000${b.line.name}`, { name: b.line.name, category }, b.line.quantity, amount)
      add(cats, category, { name: category }, b.line.quantity, amount)
    }
  }

  const payments: Record<string, number> = {}
  for (const p of data.payments) payments[p.method] = da((payments[p.method] ?? 0) + p.amount)

  const orders = data.orders.length
  let closedSales: DayReport['closedSales'] = null
  if (openedAt) {
    const before = (iso: string | null | undefined) => !!iso && new Date(iso).getTime() < new Date(openedAt).getTime()
    const early = data.orders.filter((o) => before(o.closed_at))
    const earlyCash = data.payments.filter((p) => p.method === 'cash' && before(p.created_at))
    if (early.length || earlyCash.length) {
      closedSales = {
        orders: early.length,
        amount: da(early.reduce((s, o) => s + (o.total ?? 0), 0)),
        cash: da(earlyCash.reduce((s, p) => s + p.amount, 0)),
      }
    }
  }
  const voidList = data.voids ?? []
  const voids = voidList.length
    ? {
        orders: voidList.length,
        amount: da(voidList.reduce((s, o) => s + (o.cancelled_total ?? 0), 0)),
        cash: da(voidList.reduce((s, o) => s + (o.void_cash ?? 0), 0)),
      }
    : null
  // Ventes à crédit (already in the net: counted when sold) and Règlements crédit reçus, by method.
  const settledBy: Record<string, number> = {}
  for (const st of data.settlements ?? []) settledBy[st.method] = da((settledBy[st.method] ?? 0) + st.amount)
  const settled = da(Object.values(settledBy).reduce((s, v) => s + v, 0))
  const credit = payments.credit || settled ? { sales: payments.credit ?? 0, settlements: settledBy, settled } : null
  return {
    from, to,
    gross: da(gross), discounts: da(discounts), offered: da(offered), delivery: da(delivery), net: da(net),
    orders, avgTicket: orders ? da(net / orders) : 0, guests, avgPerGuest: guests ? da(dineNet / guests) : 0, openOrders: data.openOrders,
    payments, byType,
    items: wholeDinars([...items.values()]).sort(byAmount),
    categories: wholeDinars([...cats.values()]).sort(byAmount),
    employees: wholeDinars([...employees.values()]).sort(byAmount),
    drivers: wholeDinars([...drivers.values()]).sort(byAmount),
    cash,
    closedSales,
    voids,
    credit,
  }
}

/** Rows of a report for a CSV file (Excel): a summary block, then the sales by category, item and employee. */
export function reportCsvRows(r: DayReport): Record<string, unknown>[] {
  const t = tr()
  const rows: Record<string, unknown>[] = []
  const line = (section: string, name: string, quantity: number | string, amount: number | string) =>
    rows.push({ [t.csvSection]: section, [t.csvName]: name, [t.colQty]: quantity, [t.colAmount]: typeof amount === 'number' ? csvDa(amount) : amount })
  line(t.daySummary, t.dayGross, '', r.gross)
  line(t.daySummary, t.dayDiscounts, '', r.discounts)
  line(t.daySummary, t.dayOffered, '', r.offered)
  if (r.delivery) line(t.daySummary, t.dayDelivery, '', r.delivery)
  line(t.daySummary, t.dayNet, '', r.net)
  line(t.daySummary, t.paidOrders, r.orders, '')
  line(t.daySummary, t.avgTicket, '', r.avgTicket)
  if (r.guests != null) {
    line(t.daySummary, t.dayGuests, r.guests, '')
    line(t.daySummary, t.avgPerGuest, '', r.avgPerGuest ?? '')
  }
  if (r.closedSales) line(t.daySummary, t.dayClosedSales, r.closedSales.orders, r.closedSales.amount)
  if (r.voids) line(t.daySummary, t.dayVoids, r.voids.orders, -r.voids.cash)
  if (r.credit) {
    line(t.daySummary, t.dayCreditSales, '', r.credit.sales)
    line(t.daySummary, t.dayCreditSettled, '', r.credit.settled)
  }
  for (const [m, v] of Object.entries(r.payments)) line(t.dayPayments, (t.payMethod as Record<string, string>)[m] ?? m, '', v)
  for (const type of ['dine_in', 'takeaway', 'delivery'] as const) {
    line(t.dayByType, t.dayTypes[type], r.byType[type].orders, r.byType[type].amount)
    if (r.byType[type].guests != null) line(t.dayByType, `${t.dayTypes[type]} · ${t.dayGuests}`, r.byType[type].guests!, '')
  }
  if (r.cash) {
    line(t.dayCash, t.cashOpening, '', r.cash.opening)
    line(t.dayCash, t.cashSales, '', r.cash.sales)
    line(t.dayCash, t.cashInTotal, '', r.cash.in)
    line(t.dayCash, t.cashOutTotal, '', r.cash.out)
    line(t.dayCash, t.cashExpected, '', r.cash.expected)
  }
  for (const c of r.categories) line(t.dayByCategory, c.name, c.quantity, c.amount)
  for (const i of r.items) line(t.dayByItem, `${i.name} (${i.category})`, i.quantity, i.amount)
  for (const e of r.employees) line(t.dayByEmployee, e.name, e.orders ?? 0, e.amount)
  for (const d of r.drivers ?? []) line(t.dayByDriver, d.name, d.orders ?? 0, d.amount)
  return rows
}

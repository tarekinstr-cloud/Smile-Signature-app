import { computeBill } from './billing'
import { tr } from './i18n'
import type { CashSummary, DayReport, Menu, OrderLine, OrderType, SalesData, SalesRow } from './types'

const cents = (n: number) => Math.round(n * 100) / 100

/** Category name of each menu item (hidden ones included), for "ventes par catégorie". */
export function categoryOfItems(menu: Menu | null): Map<string, string> {
  const cats = new Map((menu?.categories ?? []).map((c) => [c.id, c.name]))
  return new Map((menu?.items ?? []).map((i) => [i.id, cats.get(i.category_id) ?? '']))
}

/** Espèces attendues en caisse. */
export function cashSummary(opening: number, sales: number, cashIn: number, cashOut: number): CashSummary {
  return { opening, sales: cents(sales), in: cents(cashIn), out: cents(cashOut), expected: cents(opening + sales + cashIn - cashOut) }
}

const add = (map: Map<string, SalesRow>, key: string, row: Omit<SalesRow, 'quantity' | 'amount' | 'orders'>, quantity: number, amount: number, orders = 0) => {
  const r = map.get(key) ?? { ...row, quantity: 0, amount: 0 }
  r.quantity = cents(r.quantity + quantity)
  r.amount = cents(r.amount + amount)
  if (orders) r.orders = (r.orders ?? 0) + orders
  map.set(key, r)
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
  const byType: DayReport['byType'] = { dine_in: { orders: 0, amount: 0 }, takeaway: { orders: 0, amount: 0 }, delivery: { orders: 0, amount: 0 } }
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
    byType[type].amount = cents(byType[type].amount + total)
    const who = o.created_by_name?.trim() || t.dayUnknownEmployee
    add(employees, who, { name: who }, 0, total, 1)
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
  for (const p of data.payments) payments[p.method] = cents((payments[p.method] ?? 0) + p.amount)

  const orders = data.orders.length
  let closedSales: DayReport['closedSales'] = null
  if (openedAt) {
    const before = (iso: string | null | undefined) => !!iso && new Date(iso).getTime() < new Date(openedAt).getTime()
    const early = data.orders.filter((o) => before(o.closed_at))
    const earlyCash = data.payments.filter((p) => p.method === 'cash' && before(p.created_at))
    if (early.length || earlyCash.length) {
      closedSales = {
        orders: early.length,
        amount: cents(early.reduce((s, o) => s + (o.total ?? 0), 0)),
        cash: cents(earlyCash.reduce((s, p) => s + p.amount, 0)),
      }
    }
  }
  return {
    from, to,
    gross: cents(gross), discounts: cents(discounts), offered: cents(offered), delivery: cents(delivery), net: cents(net),
    orders, avgTicket: orders ? cents(net / orders) : 0, openOrders: data.openOrders,
    payments, byType,
    items: [...items.values()].sort(byAmount),
    categories: [...cats.values()].sort(byAmount),
    employees: [...employees.values()].sort(byAmount),
    cash,
    closedSales,
  }
}

/** Rows of a report for a CSV file (Excel): a summary block, then the sales by category, item and employee. */
export function reportCsvRows(r: DayReport): Record<string, unknown>[] {
  const t = tr()
  const rows: Record<string, unknown>[] = []
  const line = (section: string, name: string, quantity: number | string, amount: number | string) =>
    rows.push({ [t.csvSection]: section, [t.csvName]: name, [t.colQty]: quantity, [t.colAmount]: amount })
  line(t.daySummary, t.dayGross, '', r.gross)
  line(t.daySummary, t.dayDiscounts, '', r.discounts)
  line(t.daySummary, t.dayOffered, '', r.offered)
  if (r.delivery) line(t.daySummary, t.dayDelivery, '', r.delivery)
  line(t.daySummary, t.dayNet, '', r.net)
  line(t.daySummary, t.paidOrders, r.orders, '')
  line(t.daySummary, t.avgTicket, '', r.avgTicket)
  if (r.closedSales) line(t.daySummary, t.dayClosedSales, r.closedSales.orders, r.closedSales.amount)
  for (const [m, v] of Object.entries(r.payments)) line(t.dayPayments, (t.payMethod as Record<string, string>)[m] ?? m, '', v)
  for (const type of ['dine_in', 'takeaway', 'delivery'] as const) line(t.dayByType, t.dayTypes[type], r.byType[type].orders, r.byType[type].amount)
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
  return rows
}

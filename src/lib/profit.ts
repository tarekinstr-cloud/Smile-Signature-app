import { computeBill } from './billing'
import { sizeGroup } from './recipes'
import { da } from './format'
import type { Menu, OrderLine, ProfitCosts, SalesData } from './types'

const roundAll = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, da(Number(v))]))

/** Costs of the period in whole dinars (salaries prorated to the day, stock at its exact cost). */
export function roundCosts(c: ProfitCosts): ProfitCosts {
  return {
    ...c, charges: da(c.charges), charges_by_reason: roundAll(c.charges_by_reason ?? {}), inventory_loss: da(c.inventory_loss),
    salaries: da(c.salaries), expenses: da(c.expenses), expenses_by_category: roundAll(c.expenses_by_category ?? {}),
  }
}

/** One item (and size) on the page Bénéfice. */
export interface ProfitRow {
  key: string
  name: string
  /** Size sold (first required pick-one group, as on the order screen), or ''. */
  size: string
  quantity: number
  /** What customers paid for it (order discounts shared out). */
  sales: number
  /** Fixed cost of the portions sold. */
  cost: number
  margin: number
  /** Margin in % of the sales; null when nothing was paid (offered only) or no portion has a known cost. */
  marginPct: number | null
  /** Portions sold without a known cost (no fiche technique, or paid before costs were recorded). */
  unknown: number
  /** Portions whose fiche has an ingredient never bought (counted 0). */
  noPrice: number
}

export interface ProfitReport {
  /** CA net: what customers paid (delivery fees included). */
  net: number
  /** Coût matière théorique: fixed costs of the lines sold. */
  material: number
  grossMargin: number
  grossMarginPct: number | null
  costs: ProfitCosts
  netProfit: number
  netProfitPct: number | null
  rows: ProfitRow[]
  /** Portions sold with an unknown cost, over all items. */
  unknown: number
  orders: number
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null)

/** Size of a line: its option from the item's size group, found by id or else by group and name. */
function sizeOf(line: OrderLine, menu: Menu | null): string {
  const g = line.item_id ? sizeGroup(menu?.groups[line.item_id] ?? []) : undefined
  if (!g) return ''
  const o = (line.options ?? []).find((c) => (c.option_id ? g.options.some((x) => x.id === c.option_id) : c.group.trim().toLowerCase() === g.name.trim().toLowerCase()))
  return o?.name ?? ''
}

/**
 * Compte de résultat of a period: CA net − coût matière = marge brute; − charges cuisine − écarts d'inventaire −
 * salaires − dépenses = bénéfice net. Offered portions have no sales but still cost their ingredients.
 */
export function computeProfit(data: SalesData, menu: Menu | null, costs: ProfitCosts): ProfitReport {
  const byOrder = new Map<string, OrderLine[]>()
  for (const l of data.lines) (byOrder.get(l.order_id) ?? byOrder.set(l.order_id, []).get(l.order_id)!).push(l)
  const rows = new Map<string, ProfitRow>()
  let net = 0
  let material = 0
  let unknown = 0
  for (const o of data.orders) {
    const bill = computeBill(o, byOrder.get(o.id) ?? [])
    net += o.total ?? bill.total
    const ratio = bill.subtotal > 0 ? (bill.subtotal - bill.orderDiscount) / bill.subtotal : 0
    for (const b of bill.lines) {
      const l = b.line
      const size = sizeOf(l, menu)
      const key = `${l.item_id ?? l.name}\u0000${size}`
      const r = rows.get(key) ?? { key, name: l.name, size, quantity: 0, sales: 0, cost: 0, margin: 0, marginPct: null, unknown: 0, noPrice: 0 }
      const cost = (l.unit_cost ?? 0) * l.quantity
      r.quantity += l.quantity
      r.sales += b.net * ratio
      r.cost += cost
      if (l.unit_cost == null || l.cost_status === 'no_recipe') {
        r.unknown += l.quantity
        unknown += l.quantity
      } else if (l.cost_status === 'no_price') r.noPrice += l.quantity
      material += cost
      rows.set(key, r)
    }
  }
  // Whole dinars (no centimes): each row is rounded, and the coût matière is the sum of the rounded rows, so the
  // table adds up to the statement.
  const list = [...rows.values()].map((r) => {
    const sales = da(r.sales)
    const cost = da(r.cost)
    // Every portion without a known cost: no meaningful margin rate.
    return { ...r, sales, cost, margin: sales - cost, marginPct: r.unknown >= r.quantity ? null : pct(sales - cost, sales) }
  })
  net = da(net)
  material = list.reduce((s, r) => s + r.cost, 0)
  const grossMargin = net - material
  const c = roundCosts(costs)
  const netProfit = grossMargin - c.charges - c.inventory_loss - c.salaries - c.expenses
  return {
    net, material, grossMargin, grossMarginPct: pct(grossMargin, net), costs: c, netProfit, netProfitPct: pct(netProfit, net),
    rows: list, unknown, orders: data.orders.length,
  }
}

import { computeBill } from './billing'
import { sizeGroup } from './recipes'
import type { Menu, OrderLine, ProfitCosts, SalesData } from './types'

const cents = (n: number) => Math.round(n * 100) / 100

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
  const list = [...rows.values()].map((r) => {
    const sales = cents(r.sales)
    const cost = cents(r.cost)
    // Every portion without a known cost: no meaningful margin rate.
    return { ...r, sales, cost, margin: cents(sales - cost), marginPct: r.unknown >= r.quantity ? null : pct(sales - cost, sales) }
  })
  net = cents(net)
  material = cents(material)
  const grossMargin = cents(net - material)
  const netProfit = cents(grossMargin - costs.charges - costs.inventory_loss - costs.salaries - costs.expenses)
  return {
    net, material, grossMargin, grossMarginPct: pct(grossMargin, net), costs, netProfit, netProfitPct: pct(netProfit, net),
    rows: list, unknown, orders: data.orders.length,
  }
}

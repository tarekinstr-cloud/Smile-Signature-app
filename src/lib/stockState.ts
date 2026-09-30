import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from './repo'
import { backOffice, editLocalStock, localMovement, localUserName, normStock, stockRpcError } from './backoffice'
import { purchases } from './purchases'
import { tr } from './i18n'
import type {
  InventoryCount, StockInventory, StockInventoryLine, StockLocation, StockMovement, StockReportRow, StockStateRow,
} from './types'
import { newId } from './id'

/**
 * État du stock (menu Gestion du Stock): overview with values, Mouvements par période and Inventaire physique.
 * Supabase functions stock_state, stock_report and record_inventory (migration 20260930090000_stock_state.sql), all
 * computed from stock_items and stock_movements, or localStorage in demo mode, like `repo`.
 */
export interface StockStateService {
  /** Every item with its quantities, stock minimum, last purchase price and suppliers. */
  overview(): Promise<StockStateRow[]>
  /** Mouvements par période over [from, to[. */
  report(from: Date, to: Date): Promise<StockReportRow[]>
  /** Validates an inventaire physique: each gap becomes an « adjustment » movement, all in one step. */
  recordInventory(counts: InventoryCount[], note: string): Promise<StockInventory>
  /** History of the inventories, newest first. */
  listInventories(): Promise<StockInventory[]>
  inventoryLines(inventoryId: string): Promise<StockInventoryLine[]>
  /** Same shared « stock » channel as the other stock pages. */
  subscribe(onChange: () => void): () => void
}

/** At most this many inventories in the history. */
export const INVENTORY_LIMIT = 200

const round3 = (n: number) => Math.round(n * 1000) / 1000
const round2 = (n: number) => Math.round(n * 100) / 100

export const totalQty = (s: { quantity: number; kitchen_quantity: number }) => round3(s.quantity + s.kitchen_quantity)

export type StockLevel = 'ok' | 'low' | 'out'
/** Rupture: nothing left (Dépôt + Cuisine). Stock bas: at or under the stock minimum. */
export function stockLevel(s: { quantity: number; kitchen_quantity: number; min_quantity: number | null }): StockLevel {
  const total = totalQty(s)
  if (total <= 0) return 'out'
  if (s.min_quantity != null && s.min_quantity > 0 && total <= s.min_quantity) return 'low'
  return 'ok'
}

/** Stock négatif: the sales took more than the Cuisine held (a sale is never refused), or the Dépôt is below 0. */
export const isNegative = (s: { quantity: number; kitchen_quantity: number }) => s.quantity < 0 || s.kitchen_quantity < 0

/** Quantity × last purchase price; null when the item was never bought. */
export const stockValue = (qty: number, price: number | null) => (price == null ? null : round2(qty * price))

/** The inventory refused because the stock moved while counting: which item, where, what was shown and what it is now. */
export class InventoryStaleError extends Error {
  constructor(
    readonly item: string,
    readonly location: StockLocation,
    readonly expected: number,
    readonly current: number,
    unit: string,
  ) {
    const t = tr()
    const q = (n: number) => `${round3(n)}${unit ? ` ${unit}` : ''}`
    super(t.errInventoryStale(item, t.stockLocation[location], q(expected), q(current)))
  }
}

/** Movement effect on each place: + what comes in, − what goes out. */
const delta = (m: Pick<StockMovement, 'quantity' | 'from_location' | 'to_location'>, l: StockLocation) =>
  (m.to_location === l ? m.quantity : 0) - (m.from_location === l ? m.quantity : 0)

/**
 * Mouvements par période from the current quantities and the movements since `from`, as the database does: the stock at a
 * date is the current stock minus what moved since then, so the report stays right even when old movements are missing.
 */
export function computeReport(
  items: { id: string; name: string; unit: string; quantity: number; kitchen_quantity: number }[],
  movements: StockMovement[],
  from: Date,
  to: Date,
): StockReportRow[] {
  const f = from.toISOString()
  const e = to.toISOString()
  const rows = new Map<string, StockReportRow>(items.map((s) => [s.id, {
    id: s.id, name: s.name, unit: s.unit, initial_depot: s.quantity, initial_kitchen: s.kitchen_quantity,
    purchases: 0, transfers: 0, returns: 0, charges: 0, consumption: 0, adjustments: 0, final_depot: s.quantity, final_kitchen: s.kitchen_quantity,
  }]))
  for (const m of movements) {
    const r = m.stock_item_id ? rows.get(m.stock_item_id) : undefined
    if (!r || m.created_at < f) continue
    r.initial_depot -= delta(m, 'depot')
    r.initial_kitchen -= delta(m, 'kitchen')
    if (m.created_at >= e) {
      r.final_depot -= delta(m, 'depot')
      r.final_kitchen -= delta(m, 'kitchen')
      continue
    }
    if (m.type === 'purchase') r.purchases += m.quantity
    else if (m.type === 'transfer') r.transfers += m.quantity
    else if (m.type === 'return') r.returns += m.quantity
    else if (m.type === 'charge') r.charges += m.quantity
    else if (m.type === 'consumption') r.consumption += m.quantity
    else r.adjustments += delta(m, 'depot') + delta(m, 'kitchen')
  }
  return [...rows.values()]
    .map((r) => ({
      ...r, initial_depot: round3(r.initial_depot), initial_kitchen: round3(r.initial_kitchen), purchases: round3(r.purchases),
      transfers: round3(r.transfers), returns: round3(r.returns), charges: round3(r.charges), consumption: round3(r.consumption),
      adjustments: round3(r.adjustments),
      final_depot: round3(r.final_depot), final_kitchen: round3(r.final_kitchen),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Checks the counts before they are sent: a place of an item counted once, quantities ≥ 0. */
function checkCounts(counts: InventoryCount[]): InventoryCount[] {
  const t = tr()
  if (!counts.length) throw new Error(t.errInventoryEmpty)
  const seen = new Set<string>()
  return counts.map((c) => {
    if (!c.stock_item_id) throw new Error(t.errStockGone)
    if (!(Number.isFinite(c.counted) && c.counted >= 0)) throw new Error(t.errQuantity)
    const key = `${c.stock_item_id}:${c.location}`
    if (seen.has(key)) throw new Error(t.errQuantity)
    seen.add(key)
    return { ...c, counted: round3(c.counted), expected: round3(c.expected) }
  })
}

function stateError(message: string): Error {
  const t = tr()
  if (/stock_state|stock_report|record_inventory|stock_inventor|min_quantity/.test(message) && /does not exist|schema cache|Could not find/i.test(message)) {
    return new Error(t.errMigrationStockState)
  }
  const stale = /inventory_stale (\{.*\})/.exec(message)
  if (stale) {
    try {
      const d = JSON.parse(stale[1]) as { item: string; unit: string; location: StockLocation; expected: number; current: number }
      return new InventoryStaleError(d.item, d.location, Number(d.expected), Number(d.current), d.unit)
    } catch {
      return new Error(t.errInventoryChanged)
    }
  }
  if (message.includes('bad_period')) return new Error(t.errPeriod)
  return stockRpcError(message) ?? new Error(message)
}

const num = (v: unknown) => Number(v ?? 0)
const numOrNull = (v: unknown) => (v == null ? null : Number(v))

function supabaseState(sb: SupabaseClient): StockStateService {
  const check = <T>(res: { data: T; error: { message: string } | null }): T => {
    if (res.error) throw stateError(res.error.message)
    return res.data
  }
  const normInventory = (i: StockInventory): StockInventory => ({ ...i, gap_value: num(i.gap_value), note: i.note ?? '', user_name: i.user_name ?? '' })
  return {
    async overview() {
      return (check(await sb.rpc('stock_state')) as StockStateRow[]).map((r) => {
        const byId = new Map<string, { id: string; name: string }>()
        for (const s of r.suppliers ?? []) if (s?.id) byId.set(s.id, s)
        return {
          ...normStock(r), last_price: numOrNull(r.last_price), last_supplier_id: r.last_supplier_id ?? null,
          last_supplier_name: r.last_supplier_name ?? null, suppliers: [...byId.values()],
        }
      })
    },
    async report(from, to) {
      const rows = check(await sb.rpc('stock_report', { p_from: from.toISOString(), p_to: to.toISOString() })) as StockReportRow[]
      return rows.map((r) => ({
        ...r, unit: r.unit ?? '', initial_depot: num(r.initial_depot), initial_kitchen: num(r.initial_kitchen), purchases: num(r.purchases),
        transfers: num(r.transfers), returns: num(r.returns), charges: num(r.charges), consumption: num(r.consumption), adjustments: num(r.adjustments),
        final_depot: num(r.final_depot), final_kitchen: num(r.final_kitchen),
      }))
    },
    async recordInventory(counts, note) {
      return normInventory(check(await sb.rpc('record_inventory', { p_lines: checkCounts(counts), p_note: note.trim() })) as StockInventory)
    },
    async listInventories() {
      return (check(await sb.from('stock_inventories').select('*').order('created_at', { ascending: false }).limit(INVENTORY_LIMIT)) as StockInventory[])
        .map(normInventory)
    },
    async inventoryLines(inventoryId) {
      return (check(await sb.from('stock_inventory_lines').select('*').eq('inventory_id', inventoryId).order('position')) as StockInventoryLine[])
        .map((l) => ({ ...l, theoretical: num(l.theoretical), counted: num(l.counted), gap: num(l.gap), unit_cost: numOrNull(l.unit_cost) }))
    },
    subscribe: (onChange) => backOffice.subscribeStock(onChange),
  }
}

// ───────────── Demo mode (localStorage, same store as the stock) ─────────────

function localState(): StockStateService {
  /** Last purchase movement of each item (unit price and invoice), from the demo movements. */
  const lastPurchases = (moves: StockMovement[]) => {
    const last = new Map<string, StockMovement>()
    for (const m of moves) if (m.type === 'purchase' && m.stock_item_id && m.unit_cost != null) last.set(m.stock_item_id, m)
    return last
  }
  return {
    async overview() {
      const invoices = await purchases.listInvoices().catch(() => [])
      const supplierOf = new Map(invoices.map((i) => [i.id, { id: i.supplier_id ?? '', name: i.supplier_name }]))
      return editLocalStock((db) => {
        const last = lastPurchases(db.movements)
        return [...db.stock].sort((a, b) => a.name.localeCompare(b.name)).map((s) => {
          const lp = last.get(s.id)
          const sup = lp?.invoice_id ? supplierOf.get(lp.invoice_id) : undefined
          const all = new Map<string, { id: string; name: string }>()
          for (const m of db.movements) {
            const x = m.type === 'purchase' && m.stock_item_id === s.id && m.invoice_id ? supplierOf.get(m.invoice_id) : undefined
            if (x?.id) all.set(x.id, x)
          }
          return {
            ...normStock(s), last_price: lp?.unit_cost ?? null, last_supplier_id: sup?.id || null, last_supplier_name: sup?.name ?? null,
            suppliers: [...all.values()],
          }
        })
      })
    },
    async report(from, to) {
      if (!(to > from)) throw new Error(tr().errPeriod)
      return editLocalStock((db) => computeReport(db.stock, db.movements, from, to))
    },
    async recordInventory(counts, note) {
      const checked = checkCounts(counts)
      const user = await localUserName()
      return editLocalStock((db) => {
        const last = lastPurchases(db.movements)
        const inv: StockInventory & { lines: StockInventoryLine[] } = {
          id: newId(), note: note.trim(), line_count: 0, gap_value: 0, user_name: user, created_at: new Date().toISOString(), lines: [],
        }
        const moves: StockMovement[] = []
        // Everything is checked before anything changes, like the database transaction.
        const plan = checked.map((c) => {
          const item = db.stock.find((s) => s.id === c.stock_item_id)
          if (!item) throw new Error(tr().errStockGone)
          const theoretical = c.location === 'depot' ? item.quantity : item.kitchen_quantity
          if (round3(theoretical) !== c.expected) throw new InventoryStaleError(item.name, c.location, c.expected, theoretical, item.unit)
          return { c, item, theoretical }
        })
        for (const { c, item, theoretical } of plan) {
          const gap = round3(c.counted - theoretical)
          const cost = last.get(item.id)?.unit_cost ?? null
          inv.lines.push({
            id: newId(), inventory_id: inv.id, stock_item_id: item.id, item_name: item.name, unit: item.unit, location: c.location,
            theoretical, counted: c.counted, gap, unit_cost: cost,
          })
          if (gap === 0) continue
          if (c.location === 'depot') item.quantity = c.counted
          else item.kitchen_quantity = c.counted
          item.updated_at = inv.created_at
          moves.push(localMovement({
            type: 'adjustment', item, quantity: Math.abs(gap), user_name: user, batch_id: inv.id, note: 'Inventaire', unit_cost: cost,
            inventory_id: inv.id, from_location: gap < 0 ? c.location : null, to_location: gap > 0 ? c.location : null,
          }))
          if (cost != null) inv.gap_value = round2(inv.gap_value + round2(gap * cost))
        }
        inv.line_count = inv.lines.length
        db.movements.push(...moves)
        db.inventories.push(inv)
        const { lines: _lines, ...head } = inv
        return head
      })
    },
    async listInventories() {
      return editLocalStock((db) => db.inventories.map(({ lines: _lines, ...head }) => head))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, INVENTORY_LIMIT)
    },
    async inventoryLines(inventoryId) {
      return editLocalStock((db) => db.inventories.find((i) => i.id === inventoryId)?.lines ?? [])
    },
    subscribe: (onChange) => backOffice.subscribeStock(onChange),
  }
}

export const stockState: StockStateService = supabase ? supabaseState(supabase) : localState()

import type { SupabaseClient } from '@supabase/supabase-js'
import { sharedChannel, supabase } from './repo'
import { computeBill } from './billing'
import { tr } from './i18n'
import type {
  Adjustments, DayStats, NewStockItem, NewSupplier, Order, OrderLine, StaffAccount, StockInventory, StockInventoryLine, StockItem, StockItemPatch,
  StockLocation, StockMovement, Supplier, TopItem,
} from './types'
import { newId } from './id'
import { auth } from './auth'

/**
 * Data access for the back-office pages (Statistiques, Gestion du Stock, Fournisseurs, Employés).
 * Backed by Supabase when configured, localStorage otherwise, like `repo`.
 */
export interface BackOffice {
  /** Sales of the day that starts at `day` (local midnight): orders paid that day, and the items sold in them. */
  dayStats(day: Date): Promise<DayStats>

  listStock(): Promise<StockItem[]>
  createStockItem(s: NewStockItem): Promise<StockItem>
  updateStockItem(id: string, patch: StockItemPatch): Promise<void>
  /** Adds `delta` to the Dépôt quantity (negative to remove, never below 0), in one step so two devices do not overwrite each other. */
  adjustStock(id: string, delta: number): Promise<StockItem>
  deleteStockItem(id: string): Promise<void>
  /** Calls onChange when the stock or its movements change on any device (the shared « stock » channel). */
  subscribeStock(onChange: () => void): () => void

  listSuppliers(): Promise<Supplier[]>
  createSupplier(s: NewSupplier): Promise<Supplier>
  updateSupplier(id: string, patch: Partial<NewSupplier>): Promise<void>
  deleteSupplier(id: string): Promise<void>

  /** Accounts that sign in to the app. Read-only: roles do not exist yet. */
  listStaff(): Promise<StaffAccount[]>
}

const TOP_ITEMS = 10

/** Start and end (exclusive) of the local day containing `day`. */
export function dayRange(day: Date): [Date, Date] {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate())
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return [start, end]
}

/** Totals of the paid orders and their lines. Line amounts are what was paid for them (discounts and offers applied). */
export function computeDayStats(paid: (Order & { total: number | null })[], lines: OrderLine[], openOrders: number): DayStats {
  const byOrder = new Map<string, OrderLine[]>()
  for (const l of lines) (byOrder.get(l.order_id) ?? byOrder.set(l.order_id, []).get(l.order_id)!).push(l)
  const items = new Map<string, TopItem>()
  let sales = 0
  for (const o of paid) {
    const bill = computeBill(o, byOrder.get(o.id) ?? [])
    sales += o.total ?? bill.total
    for (const b of bill.lines) {
      const it = items.get(b.line.name) ?? { name: b.line.name, quantity: 0, amount: 0 }
      it.quantity += b.line.quantity
      it.amount += b.net
      items.set(it.name, it)
    }
  }
  const topItems = [...items.values()]
    .sort((a, b) => b.quantity - a.quantity || b.amount - a.amount || a.name.localeCompare(b.name))
    .slice(0, TOP_ITEMS)
  return { sales: Math.round(sales * 100) / 100, orders: paid.length, openOrders, topItems }
}

// Old rows (before the payments migration) have no discount fields; bills need them.
const adjustments = <T extends Partial<Adjustments>>(r: T) => ({
  ...r, discount_type: r.discount_type ?? null, discount_value: Number(r.discount_value ?? 0), offered: !!r.offered,
})
const normLine = (l: OrderLine): OrderLine => ({ ...adjustments(l), unit_price: Number(l.unit_price), quantity: Number(l.quantity) })
// Before the stock locations migration there is no kitchen_quantity: everything is at the Dépôt.
export const normStock = (s: StockItem): StockItem => ({
  ...s, quantity: Number(s.quantity), kitchen_quantity: Number(s.kitchen_quantity ?? 0), unit: s.unit ?? '',
  // Before the stock state migration there is no stock minimum.
  min_quantity: s.min_quantity == null ? null : Number(s.min_quantity),
})

const LOCATIONS: StockLocation[] = ['depot', 'kitchen']
/** Thrown when a movement asks for more than the place holds; the message says what is left. */
export function insufficientStock(item: string, unit: string, location: StockLocation, available: number, requested: number): Error {
  const t = tr()
  const q = (n: number) => `${Math.round(n * 1000) / 1000}${unit ? ` ${unit}` : ''}`
  return new Error(t.errNotEnoughStock(item, t.stockLocation[location], q(available), q(requested)))
}

/** Errors of the stock functions (migration 20260930080000_stock_locations.sql), shared with the transfers and charges. */
export function stockRpcError(message: string): Error | null {
  const t = tr()
  const m = /insufficient_stock (\{.*\})/.exec(message)
  if (m) {
    try {
      const d = JSON.parse(m[1]) as { item: string; unit: string; location: StockLocation; available: number; requested: number }
      if (LOCATIONS.includes(d.location)) return insufficientStock(d.item, d.unit, d.location, Number(d.available), Number(d.requested))
    } catch {
      // Not readable: the generic message below.
    }
    return new Error(t.errQuantity)
  }
  if (message.includes('stock_direct_update')) return new Error(t.errStockDirect)
  if (/no_permission|row-level security|permission denied/i.test(message)) return new Error(t.errNoPermission)
  if (message.includes('stock_item_not_found')) return new Error(t.errStockGone)
  if (message.includes('bad_quantity')) return new Error(t.errQuantity)
  if (message.includes('no_lines')) return new Error(t.errMoveLines)
  return null
}
/** The stock minimum must be empty or ≥ 0. */
function checkMin(min: number | null | undefined) {
  if (min != null && !(Number.isFinite(min) && min >= 0)) throw new Error(tr().errQuantity)
}
const cleanStock = <T extends StockItemPatch>(s: T): T => ({
  ...s, ...(s.name !== undefined && { name: s.name.trim() }), ...(s.unit !== undefined && { unit: s.unit.trim() }),
})
const cleanSupplier = <T extends Partial<NewSupplier>>(s: T): T => ({
  ...s,
  ...(s.name !== undefined && { name: s.name.trim() }),
  ...(s.phone !== undefined && { phone: s.phone.trim() }),
  ...(s.products !== undefined && { products: s.products.trim() }),
})

function checkName(name: string | undefined) {
  if (name !== undefined && !name.trim()) throw new Error(tr().errNameEmpty)
}

function boError(message: string): Error {
  const t = tr()
  if (message.includes('stock_items_name_key') || message.includes('23505')) return new Error(t.errStockName)
  const stock = stockRpcError(message)
  if (stock) return stock
  if (/min_quantity/.test(message) && /does not exist|schema cache|Could not find/i.test(message)) return new Error(t.errMigrationStockState)
  if (/stock_items|suppliers|adjust_stock|list_staff/.test(message) && /does not exist|schema cache|Could not find/i.test(message)) {
    return new Error(t.errMigrationBackOffice)
  }
  return new Error(message)
}

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw boError(res.error.message)
  return res.data
}

function supabaseBackOffice(sb: SupabaseClient): BackOffice {
  return {
    async dayStats(day) {
      const [start, end] = dayRange(day)
      const [paid, open] = await Promise.all([
        sb.from('orders').select('*').eq('status', 'paid').gte('closed_at', start.toISOString()).lt('closed_at', end.toISOString()),
        sb.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'open'),
      ])
      const orders = (check(paid) as (Order & { total: number | null })[])
        .map((o) => ({ ...adjustments(o), total: o.total == null ? null : Number(o.total) }))
      if (open.error) throw boError(open.error.message)
      const lines: OrderLine[] = []
      // A few URL-sized batches rather than one huge `in (…)` on busy days.
      for (let i = 0; i < orders.length; i += 100) {
        const ids = orders.slice(i, i + 100).map((o) => o.id)
        lines.push(...(check(await sb.from('order_items').select('*').in('order_id', ids)) as OrderLine[]).map(normLine))
      }
      return computeDayStats(orders, lines, open.count ?? 0)
    },

    async listStock() {
      return (check(await sb.from('stock_items').select('*').order('name')) as StockItem[]).map(normStock)
    },
    async createStockItem(s) {
      checkName(s.name)
      checkMin(s.min_quantity)
      return normStock(check(await sb.from('stock_items').insert(cleanStock(s)).select().single()) as StockItem)
    },
    async updateStockItem(id, patch) {
      checkName(patch.name)
      checkMin(patch.min_quantity)
      check(await sb.from('stock_items').update({ ...cleanStock(patch), updated_at: new Date().toISOString() }).eq('id', id))
    },
    async adjustStock(id, delta) {
      return normStock(check(await sb.rpc('adjust_stock', { p_item_id: id, p_delta: delta })) as StockItem)
    },
    async deleteStockItem(id) {
      check(await sb.from('stock_items').delete().eq('id', id))
    },

    async listSuppliers() {
      return check(await sb.from('suppliers').select('*').order('name')) as Supplier[]
    },
    async createSupplier(s) {
      checkName(s.name)
      return check(await sb.from('suppliers').insert(cleanSupplier(s)).select().single()) as Supplier
    },
    async updateSupplier(id, patch) {
      checkName(patch.name)
      check(await sb.from('suppliers').update(cleanSupplier(patch)).eq('id', id))
    },
    async deleteSupplier(id) {
      check(await sb.from('suppliers').delete().eq('id', id))
    },

    async listStaff() {
      return check(await sb.rpc('list_staff')) as StaffAccount[]
    },
    subscribeStock: sharedChannel(sb, 'stock', ['stock_items', 'stock_movements', 'stock_inventories']),
  }
}

/** Keys of the demo data: orders are read from the order screens' store, stock and suppliers have their own. */
const ORDERS_KEY = 'smile.orders.v1'
const KEY = 'smile.backoffice.v1'

interface LocalDb {
  stock: StockItem[]
  suppliers: Supplier[]
  /** Demo stock_movements, newest last. */
  movements: StockMovement[]
  /** Demo inventaires physiques with their lines, newest last. */
  inventories: (StockInventory & { lines: StockInventoryLine[] })[]
}

const now = () => new Date().toISOString()

function seed(): LocalDb {
  const s = (name: string, quantity: number, unit: string): StockItem => ({ id: newId(), name, quantity, kitchen_quantity: 0, unit, min_quantity: null, updated_at: now() })
  return {
    stock: [s('Farine', 25, 'kg'), s('Fromage mozzarella', 8, 'kg'), s('Pain burger', 60, 'pièce'), s('Huile', 12, 'L'), s('Coca-Cola 33 cl', 48, 'canette')],
    suppliers: [{ id: newId(), name: 'Boulangerie El Amel', phone: '0550 12 34 56', products: 'Pain burger, pain de mie' }],
    movements: [],
    inventories: [],
  }
}

function load(): LocalDb {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const db = JSON.parse(raw) as Partial<LocalDb>
      // Data saved before the stock locations: everything is at the Dépôt, no movements yet.
      return { stock: (db.stock ?? []).map(normStock), suppliers: db.suppliers ?? [], movements: db.movements ?? [], inventories: db.inventories ?? [] }
    }
  } catch {
    // Storage blocked or data unreadable: start again from the demo data.
  }
  const db = seed()
  save(db)
  return db
}

function save(db: LocalDb) {
  try {
    localStorage.setItem(KEY, JSON.stringify(db))
  } catch {
    // Not persisted in this browser (private mode); the page still works for this visit.
  }
}

/**
 * Demo mode: reads and changes the stock and its movements in one write, like the database functions do in one
 * transaction (used by the transfers, the kitchen charges and the purchases).
 */
export function editLocalStock<T>(fn: (db: Pick<LocalDb, 'stock' | 'movements' | 'inventories'>) => T): T {
  const db = load()
  const out = fn(db)
  save(db)
  return out
}

/** Demo movement with the fields most movements leave empty. */
export const localMovement = (m: Pick<StockMovement, 'type' | 'quantity' | 'user_name'> & Partial<StockMovement> & { item: StockItem }): StockMovement => {
  const { item, ...rest } = m
  return {
    id: newId(), batch_id: newId(), stock_item_id: item.id, item_name: item.name, unit: item.unit, from_location: null, to_location: null,
    reason: null, note: '', unit_cost: null, created_at: now(), ...rest,
  }
}

/** Name shown in the demo movements: the account signed in on this device. */
export async function localUserName(): Promise<string> {
  const u = await auth.current()
  return u ? u.display_name || u.username : ''
}

function localBackOffice(): BackOffice {
  const edit = <T>(fn: (db: LocalDb) => T): T => {
    const db = load()
    const out = fn(db)
    save(db)
    return out
  }
  const nameTaken = (db: LocalDb, name: string, id?: string) =>
    db.stock.some((s) => s.id !== id && s.name.trim().toLowerCase() === name.trim().toLowerCase())
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)

  return {
    async dayStats(day) {
      const [start, end] = dayRange(day)
      let orders: (Order & { total?: number | null; closed_at?: string | null })[] = []
      let lines: OrderLine[] = []
      try {
        const raw = localStorage.getItem(ORDERS_KEY)
        if (raw) ({ orders, lines } = JSON.parse(raw) as { orders: typeof orders; lines: OrderLine[] })
      } catch {
        // No demo orders yet.
      }
      const paid = orders
        .filter((o) => o.status === 'paid' && o.closed_at && new Date(o.closed_at) >= start && new Date(o.closed_at) < end)
        .map((o) => ({ ...adjustments(o), total: o.total == null ? null : Number(o.total) }))
      const ids = new Set(paid.map((o) => o.id))
      return computeDayStats(paid, (lines ?? []).filter((l) => ids.has(l.order_id)).map(normLine), orders.filter((o) => o.status === 'open').length)
    },

    async listStock() {
      return [...load().stock].sort(byName)
    },
    async createStockItem(s) {
      checkName(s.name)
      checkMin(s.min_quantity)
      if (!(Number.isFinite(s.quantity) && s.quantity >= 0)) throw new Error(tr().errQuantity)
      const user = await localUserName()
      return edit((db) => {
        if (nameTaken(db, s.name)) throw new Error(tr().errStockName)
        const row: StockItem = { id: newId(), min_quantity: null, ...cleanStock(s), kitchen_quantity: 0, updated_at: now() }
        db.stock.push(row)
        if (row.quantity > 0) db.movements.push(localMovement({ type: 'adjustment', item: row, quantity: row.quantity, to_location: 'depot', user_name: user }))
        return row
      })
    },
    async updateStockItem(id, patch) {
      checkName(patch.name)
      checkMin(patch.min_quantity)
      edit((db) => {
        if (patch.name !== undefined && nameTaken(db, patch.name, id)) throw new Error(tr().errStockName)
        db.stock = db.stock.map((s) => (s.id === id ? { ...s, ...cleanStock(patch), updated_at: now() } : s))
      })
    },
    async adjustStock(id, delta) {
      if (!(Number.isFinite(delta) && delta !== 0)) throw new Error(tr().errQuantity)
      const user = await localUserName()
      return edit((db) => {
        const row = db.stock.find((s) => s.id === id)
        if (!row) throw new Error(tr().errStockGone)
        if (delta < 0 && row.quantity < -delta) throw insufficientStock(row.name, row.unit, 'depot', row.quantity, -delta)
        row.quantity = Math.round((row.quantity + delta) * 1000) / 1000
        row.updated_at = now()
        db.movements.push(localMovement({
          type: 'adjustment', item: row, quantity: Math.abs(delta), user_name: user,
          from_location: delta < 0 ? 'depot' : null, to_location: delta > 0 ? 'depot' : null,
        }))
        return { ...row }
      })
    },
    async deleteStockItem(id) {
      edit((db) => {
        db.stock = db.stock.filter((s) => s.id !== id)
        // Like the database: the movements stay, with the item's name.
        db.movements = db.movements.map((m) => (m.stock_item_id === id ? { ...m, stock_item_id: null } : m))
      })
    },

    async listSuppliers() {
      return [...load().suppliers].sort(byName)
    },
    async createSupplier(s) {
      checkName(s.name)
      return edit((db) => {
        const row: Supplier = { id: newId(), ...cleanSupplier(s) }
        db.suppliers.push(row)
        return row
      })
    },
    async updateSupplier(id, patch) {
      checkName(patch.name)
      edit((db) => { db.suppliers = db.suppliers.map((s) => (s.id === id ? { ...s, ...cleanSupplier(patch) } : s)) })
    },
    async deleteSupplier(id) {
      edit((db) => { db.suppliers = db.suppliers.filter((s) => s.id !== id) })
    },

    async listStaff() {
      return [{ id: 'demo', email: tr().demoAccount, created_at: null, last_sign_in_at: null }]
    },
    subscribeStock(onChange) {
      // Other tabs of this browser; the demo has no other devices.
      const onStorage = (e: StorageEvent) => e.key === KEY && onChange()
      window.addEventListener('storage', onStorage)
      return () => window.removeEventListener('storage', onStorage)
    },
  }
}

export const backOffice: BackOffice = supabase ? supabaseBackOffice(supabase) : localBackOffice()

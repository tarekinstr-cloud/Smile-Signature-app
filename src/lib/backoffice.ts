import type { SupabaseClient } from '@supabase/supabase-js'
import { sharedChannel, supabase } from './repo'
import { tr } from './i18n'
import type {
  NewStockItem, NewSupplier, StaffAccount, StockInventory, StockInventoryLine, StockItem, StockItemPatch,
  StockLocation, StockMovement, Supplier,
} from './types'
import { newId } from './id'
import { auth } from './auth'
import { nowIso } from './tz'

/**
 * Data access for the back-office pages (Gestion du Stock, Fournisseurs, Employés).
 * Backed by Supabase when configured, localStorage otherwise, like `repo`.
 */
export interface BackOffice {
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

// Before the stock locations migration there is no kitchen_quantity: everything is at the Dépôt.
export const normStock = (s: StockItem): StockItem => ({
  ...s, quantity: Number(s.quantity), kitchen_quantity: Number(s.kitchen_quantity ?? 0), unit: s.unit ?? '',
  // Before the stock state migration there is no stock minimum.
  min_quantity: s.min_quantity == null ? null : Number(s.min_quantity),
  // Before the recipes migration there is no purchase unit.
  purchase_unit: s.purchase_unit ?? '',
  purchase_factor: s.purchase_factor == null ? null : Number(s.purchase_factor),
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
/** The stock minimum must be empty or ≥ 0; a purchase unit needs a coefficient > 0 (and the reverse). */
function checkStock(s: StockItemPatch) {
  const min = s.min_quantity
  if (min != null && !(Number.isFinite(min) && min >= 0)) throw new Error(tr().errQuantity)
  if (s.purchase_factor != null && !(Number.isFinite(s.purchase_factor) && s.purchase_factor > 0)) throw new Error(tr().errPurchaseFactor)
  if (s.purchase_unit !== undefined && !!s.purchase_unit.trim() !== (s.purchase_factor != null)) throw new Error(tr().errPurchaseFactor)
}
const cleanStock = <T extends StockItemPatch>(s: T): T => ({
  ...s, ...(s.name !== undefined && { name: s.name.trim() }), ...(s.unit !== undefined && { unit: s.unit.trim() }),
  ...(s.purchase_unit !== undefined && { purchase_unit: s.purchase_unit.trim() }),
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
  if (/purchase_unit|purchase_factor/.test(message) && /does not exist|schema cache|Could not find/i.test(message)) return new Error(t.errMigrationRecipes)
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
    async listStock() {
      return (check(await sb.from('stock_items').select('*').order('name')) as StockItem[]).map(normStock)
    },
    async createStockItem(s) {
      checkName(s.name)
      checkStock(s)
      return normStock(check(await sb.from('stock_items').insert(cleanStock(s)).select().single()) as StockItem)
    },
    async updateStockItem(id, patch) {
      checkName(patch.name)
      checkStock(patch)
      check(await sb.from('stock_items').update({ ...cleanStock(patch), updated_at: nowIso() }).eq('id', id))
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
    subscribeStock: sharedChannel(sb, 'stock', ['stock_items', 'stock_movements', 'stock_inventories', 'recipe_lines']),
  }
}

/** Key of the demo data: stock and suppliers. */
const KEY = 'smile.backoffice.v1'

interface LocalDb {
  stock: StockItem[]
  suppliers: Supplier[]
  /** Demo stock_movements, newest last. */
  movements: StockMovement[]
  /** Demo inventaires physiques with their lines, newest last. */
  inventories: (StockInventory & { lines: StockInventoryLine[] })[]
}

const now = () => nowIso()

function seed(): LocalDb {
  const s = (name: string, quantity: number, unit: string): StockItem => ({
    id: newId(), name, quantity, kitchen_quantity: 0, unit, min_quantity: null, purchase_unit: '', purchase_factor: null, updated_at: now(),
  })
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
    async listStock() {
      return [...load().stock].sort(byName)
    },
    async createStockItem(s) {
      checkName(s.name)
      checkStock(s)
      if (!(Number.isFinite(s.quantity) && s.quantity >= 0)) throw new Error(tr().errQuantity)
      const user = await localUserName()
      return edit((db) => {
        if (nameTaken(db, s.name)) throw new Error(tr().errStockName)
        const row: StockItem = { id: newId(), min_quantity: null, purchase_unit: '', purchase_factor: null, ...cleanStock(s), kitchen_quantity: 0, updated_at: now() }
        db.stock.push(row)
        if (row.quantity > 0) db.movements.push(localMovement({ type: 'adjustment', item: row, quantity: row.quantity, to_location: 'depot', user_name: user }))
        return row
      })
    },
    async updateStockItem(id, patch) {
      checkName(patch.name)
      checkStock(patch)
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

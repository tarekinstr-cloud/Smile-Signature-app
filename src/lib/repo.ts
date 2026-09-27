import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type {
  Category, CategoryPatch, DiningTable, Hall, HallPatch, ItemOption, ItemOptionPatch, Menu, MenuItem, MenuItemPatch, MenuTable,
  NewCategory, NewItemOption, NewMenuItem, NewOptionGroup, NewOrderLine, NewTable, OptionGroup, OptionGroupPatch, Order,
  OrderLine, OrderLinePatch, PaidOrder, PaymentMethod, ReceiptSettings, TablePatch,
} from './types'
import { demoMenu } from './demoMenu'
import { tr } from './i18n'

/** Data access for halls, tables, menu and orders. Backed by Supabase when configured, localStorage otherwise. */
export interface Repo {
  mode: 'supabase' | 'local'
  listHalls(): Promise<Hall[]>
  createHall(name: string): Promise<Hall>
  updateHall(id: string, patch: HallPatch): Promise<void>
  deleteHall(id: string): Promise<void>
  listTables(hallId: string): Promise<DiningTable[]>
  createTable(t: NewTable): Promise<DiningTable>
  updateTable(id: string, patch: TablePatch): Promise<void>
  deleteTable(id: string): Promise<void>
  /** Calls onChange whenever halls or tables change elsewhere. Returns an unsubscribe function. */
  subscribe(onChange: () => void): () => void

  /** Active categories and items, with each item's option groups. `includeHidden` also returns hidden ones (admin screen). */
  getMenu(opts?: { includeHidden?: boolean }): Promise<Menu>
  createCategory(c: NewCategory): Promise<Category>
  updateCategory(id: string, patch: CategoryPatch): Promise<void>
  /** Deletes the category with its items and their options. Past orders keep their copied names and prices. */
  deleteCategory(id: string): Promise<void>
  createItem(i: NewMenuItem): Promise<MenuItem>
  updateItem(id: string, patch: MenuItemPatch): Promise<void>
  deleteItem(id: string): Promise<void>
  createOptionGroup(g: NewOptionGroup): Promise<OptionGroup>
  updateOptionGroup(id: string, patch: OptionGroupPatch): Promise<void>
  deleteOptionGroup(id: string): Promise<void>
  createOption(o: NewItemOption): Promise<ItemOption>
  updateOption(id: string, patch: ItemOptionPatch): Promise<void>
  deleteOption(id: string): Promise<void>
  /** The table's open order and its lines, or null when the table has none. */
  getOpenOrder(tableId: string): Promise<{ order: Order; lines: OrderLine[] } | null>
  /** Opens an order on the table (marking it occupied), or returns the one already open. */
  openOrder(tableId: string): Promise<Order>
  /** Cancels an open order and frees its table. */
  cancelOrder(orderId: string): Promise<void>
  addLine(orderId: string, line: NewOrderLine): Promise<OrderLine>
  updateLine(id: string, patch: OrderLinePatch): Promise<void>
  deleteLine(id: string): Promise<void>
  /** Calls onChange whenever orders or order lines change elsewhere. */
  subscribeOrders(onChange: () => void): () => void

  /**
   * Closes an open order as paid, frees its table and gives it the next receipt number.
   * The total is computed from the order's lines; `received` is the cash handed over (cash only).
   */
  checkoutOrder(orderId: string, method: PaymentMethod, received: number | null): Promise<PaidOrder>
  getReceiptSettings(): Promise<ReceiptSettings>
  updateReceiptSettings(patch: Partial<ReceiptSettings>): Promise<void>
}

export const defaultReceiptSettings = (): ReceiptSettings => ({
  name: 'Smile Signature',
  header: '',
  footer: 'Merci de votre visite — Bon Appétit !',
})

const lineTotal = (lines: Pick<OrderLine, 'unit_price' | 'quantity'>[]) =>
  Math.round(lines.reduce((s, l) => s + l.unit_price * l.quantity, 0) * 100) / 100

function checkoutError(code: string): Error {
  const t = tr()
  if (code.includes('order_not_open') || code.includes('order_not_found')) return new Error(t.errOrderClosed)
  if (code.includes('order_empty')) return new Error(t.errOrderEmpty)
  if (code.includes('amount_too_low')) return new Error(t.errAmountTooLow)
  return new Error(code)
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey) : null

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data
}

function supabaseRepo(sb: SupabaseClient): Repo {
  const insertRow = async (table: MenuTable, row: object) => check(await sb.from(table).insert(row).select().single()) as unknown
  const updateRow = async (table: MenuTable, id: string, patch: object) => {
    check(await sb.from(table).update(patch).eq('id', id))
  }
  // Foreign keys cascade: a category takes its items, an item its option groups, a group its options.
  const deleteRow = async (table: MenuTable, id: string) => {
    check(await sb.from(table).delete().eq('id', id))
  }

  return {
    mode: 'supabase',
    async listHalls() {
      return check(await sb.from('halls').select('*').order('sort_order').order('created_at')) as Hall[]
    },
    async createHall(name) {
      const halls = await this.listHalls()
      const sort_order = halls.length ? Math.max(...halls.map((h) => h.sort_order)) + 1 : 0
      return check(await sb.from('halls').insert({ name, sort_order }).select().single()) as Hall
    },
    async updateHall(id, patch) {
      check(await sb.from('halls').update(patch).eq('id', id))
    },
    async deleteHall(id) {
      check(await sb.from('halls').delete().eq('id', id))
    },
    async listTables(hallId) {
      return check(await sb.from('tables').select('*').eq('hall_id', hallId).order('created_at')) as DiningTable[]
    },
    async createTable(t) {
      return check(await sb.from('tables').insert(t).select().single()) as DiningTable
    },
    async updateTable(id, patch) {
      check(await sb.from('tables').update(patch).eq('id', id))
    },
    async deleteTable(id) {
      check(await sb.from('tables').delete().eq('id', id))
    },
    subscribe(onChange) {
      const channel = sb
        .channel('floor')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'halls' }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tables' }, onChange)
        .subscribe()
      return () => {
        sb.removeChannel(channel)
      }
    },

    async getMenu(opts) {
      let cats = sb.from('categories').select('id, name, color, sort_order, active')
      let items = sb.from('items').select('id, category_id, name, price, sort_order, active')
      if (!opts?.includeHidden) {
        cats = cats.eq('active', true)
        items = items.eq('active', true)
      }
      const [c, i, groups, options] = await Promise.all([
        cats.order('sort_order').order('created_at'),
        items.order('sort_order').order('created_at'),
        sb.from('option_groups').select('*').order('sort_order'),
        sb.from('options').select('*').order('sort_order'),
      ])
      return buildMenu(
        check(c) as Category[],
        (check(i) as MenuItem[]).map((i) => ({ ...i, price: Number(i.price) })),
        check(groups) as Omit<OptionGroup, 'options'>[],
        (check(options) as ItemOption[]).map((o) => ({ ...o, price_delta: Number(o.price_delta) })),
      )
    },
    async createCategory(c) {
      return insertRow('categories', c) as Promise<Category>
    },
    updateCategory: (id, patch) => updateRow('categories', id, patch),
    deleteCategory: (id) => deleteRow('categories', id),
    async createItem(i) {
      const row = (await insertRow('items', i)) as MenuItem
      return { ...row, price: Number(row.price) }
    },
    updateItem: (id, patch) => updateRow('items', id, patch),
    deleteItem: (id) => deleteRow('items', id),
    async createOptionGroup(g) {
      return { ...((await insertRow('option_groups', g)) as Omit<OptionGroup, 'options'>), options: [] }
    },
    updateOptionGroup: (id, patch) => updateRow('option_groups', id, patch),
    deleteOptionGroup: (id) => deleteRow('option_groups', id),
    async createOption(o) {
      const row = (await insertRow('options', o)) as ItemOption
      return { ...row, price_delta: Number(row.price_delta) }
    },
    updateOption: (id, patch) => updateRow('options', id, patch),
    deleteOption: (id) => deleteRow('options', id),

    async getOpenOrder(tableId) {
      const order = check(
        await sb.from('orders').select('id, table_id, status, note, created_at').eq('table_id', tableId).eq('status', 'open').maybeSingle(),
      ) as Order | null
      if (!order) return null
      const lines = check(await sb.from('order_items').select('*').eq('order_id', order.id).order('created_at')) as OrderLine[]
      return { order, lines: lines.map(normalizeLine) }
    },
    async openOrder(tableId) {
      const res = await sb.from('orders').insert({ table_id: tableId }).select('id, table_id, status, note, created_at').single()
      // 23505: another device opened an order on this table first.
      if (res.error?.code === '23505') {
        const existing = await this.getOpenOrder(tableId)
        if (existing) return existing.order
      }
      return check(res) as Order
    },
    async cancelOrder(orderId) {
      check(await sb.from('orders').update({ status: 'cancelled' }).eq('id', orderId).eq('status', 'open'))
    },
    async addLine(orderId, line) {
      return normalizeLine(check(await sb.from('order_items').insert({ ...line, order_id: orderId }).select().single()) as OrderLine)
    },
    async updateLine(id, patch) {
      check(await sb.from('order_items').update(patch).eq('id', id))
    },
    async deleteLine(id) {
      check(await sb.from('order_items').delete().eq('id', id))
    },
    subscribeOrders(onChange) {
      const channel = sb
        .channel('orders')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, onChange)
        .subscribe()
      return () => {
        sb.removeChannel(channel)
      }
    },

    async checkoutOrder(orderId, method, received) {
      const res = await sb.rpc('checkout_order', { p_order_id: orderId, p_method: method, p_received: received })
      if (res.error) throw checkoutError(res.error.message)
      const o = res.data as PaidOrder
      return {
        id: o.id, table_id: o.table_id, status: o.status, note: o.note, created_at: o.created_at, closed_at: o.closed_at,
        ticket_no: Number(o.ticket_no), total: Number(o.total), payment_method: o.payment_method, amount_received: Number(o.amount_received),
      }
    },
    async getReceiptSettings() {
      const row = check(await sb.from('receipt_settings').select('name, header, footer').eq('id', 1).maybeSingle()) as ReceiptSettings | null
      return row ?? defaultReceiptSettings()
    },
    async updateReceiptSettings(patch) {
      check(await sb.from('receipt_settings').upsert({ id: 1, ...patch }))
    },
  }
}

function normalizeLine(l: OrderLine): OrderLine {
  return {
    ...l,
    unit_price: Number(l.unit_price),
    options: (l.options ?? []).map((o) => ({ ...o, price_delta: Number(o.price_delta) })),
  }
}

function buildMenu(categories: Category[], items: MenuItem[], groups: Omit<OptionGroup, 'options'>[], options: ItemOption[]): Menu {
  const byItem: Record<string, OptionGroup[]> = {}
  for (const g of [...groups].sort((a, b) => a.sort_order - b.sort_order)) {
    const opts = options.filter((o) => o.group_id === g.id).sort((a, b) => a.sort_order - b.sort_order)
    ;(byItem[g.item_id] ??= []).push({ ...g, options: opts })
  }
  return {
    categories: [...categories].sort((a, b) => a.sort_order - b.sort_order),
    items: [...items].sort((a, b) => a.sort_order - b.sort_order),
    groups: byItem,
  }
}

const KEY = 'smile.floor.v1'

interface LocalDb {
  halls: Hall[]
  tables: DiningTable[]
}

function seed(): LocalDb {
  const h1 = crypto.randomUUID()
  const h2 = crypto.randomUUID()
  const t = (hall_id: string, label: string, seats: number, shape: DiningTable['shape'], x: number, y: number, width: number, height: number): DiningTable => ({
    id: crypto.randomUUID(), hall_id, label, seats, shape, x, y, width, height, status: 'free',
  })
  return {
    halls: [
      { id: h1, name: 'الصالة الرئيسية', width: 1000, height: 640, sort_order: 0 },
      { id: h2, name: 'التراس', width: 1000, height: 640, sort_order: 1 },
    ],
    tables: [
      t(h1, '1', 4, 'square', 60, 60, 90, 90),
      t(h1, '2', 4, 'square', 220, 60, 90, 90),
      t(h1, '3', 2, 'round', 380, 60, 80, 80),
      t(h1, '4', 6, 'rect', 60, 240, 160, 90),
      t(h1, '5', 8, 'rect', 300, 240, 200, 90),
      t(h2, 'T1', 2, 'round', 80, 80, 80, 80),
      t(h2, 'T2', 2, 'round', 240, 80, 80, 80),
    ],
  }
}

const ORDERS_KEY = 'smile.orders.v1'

interface LocalOrdersDb {
  categories: Category[]
  items: MenuItem[]
  groups: Omit<OptionGroup, 'options'>[]
  options: ItemOption[]
  orders: Order[]
  lines: OrderLine[]
  /** Last receipt number handed out. */
  lastTicket?: number
  receipt?: ReceiptSettings
}

function localRepo(): Repo {
  const load = (): LocalDb => {
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) return JSON.parse(raw) as LocalDb
    } catch {
      /* fall through to seed */
    }
    const db = seed()
    save(db)
    return db
  }
  const save = (db: LocalDb) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(db))
    } catch {
      /* storage unavailable: keep working in memory for this session */
    }
  }
  const listeners = new Set<() => void>()
  const commit = (db: LocalDb) => {
    save(db)
    listeners.forEach((l) => l())
  }
  // Other tabs on the same device see changes too.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) listeners.forEach((l) => l())
  })

  const loadOrders = (): LocalOrdersDb => {
    try {
      const raw = localStorage.getItem(ORDERS_KEY)
      if (raw) return JSON.parse(raw) as LocalOrdersDb
    } catch {
      /* fall through to seed */
    }
    const db: LocalOrdersDb = { ...demoMenu(), orders: [], lines: [] }
    saveOrders(db)
    return db
  }
  const saveOrders = (db: LocalOrdersDb) => {
    try {
      localStorage.setItem(ORDERS_KEY, JSON.stringify(db))
    } catch {
      /* storage unavailable */
    }
  }
  const orderListeners = new Set<() => void>()
  const commitOrders = (db: LocalOrdersDb) => {
    saveOrders(db)
    orderListeners.forEach((l) => l())
  }
  window.addEventListener('storage', (e) => {
    if (e.key === ORDERS_KEY) orderListeners.forEach((l) => l())
  })
  const editMenu = (fn: (db: LocalOrdersDb) => unknown) => {
    const db = loadOrders()
    fn(db)
    commitOrders(db)
  }
  // Mirror the database's cascading deletes; order lines keep their copy but lose the link to the item.
  const removeGroup = (db: LocalOrdersDb, id: string) => {
    db.options = db.options.filter((o) => o.group_id !== id)
    db.groups = db.groups.filter((g) => g.id !== id)
  }
  const removeItem = (db: LocalOrdersDb, id: string) => {
    db.groups.filter((g) => g.item_id === id).forEach((g) => removeGroup(db, g.id))
    db.items = db.items.filter((i) => i.id !== id)
    db.lines = db.lines.map((l) => (l.item_id === id ? { ...l, item_id: null } : l))
  }
  // Mirrors the database trigger: an open order occupies its table, closing it frees the table.
  const setTableStatus = (tableId: string | null, status: DiningTable['status']) => {
    if (!tableId) return
    const db = load()
    db.tables = db.tables.map((t) => (t.id === tableId ? { ...t, status } : t))
    commit(db)
  }

  return {
    mode: 'local',
    async listHalls() {
      return [...load().halls].sort((a, b) => a.sort_order - b.sort_order)
    },
    async createHall(name) {
      const db = load()
      const sort_order = db.halls.length ? Math.max(...db.halls.map((h) => h.sort_order)) + 1 : 0
      const hall: Hall = { id: crypto.randomUUID(), name, width: 1000, height: 640, sort_order }
      db.halls.push(hall)
      commit(db)
      return hall
    },
    async updateHall(id, patch) {
      const db = load()
      db.halls = db.halls.map((h) => (h.id === id ? { ...h, ...patch } : h))
      commit(db)
    },
    async deleteHall(id) {
      const db = load()
      db.halls = db.halls.filter((h) => h.id !== id)
      db.tables = db.tables.filter((t) => t.hall_id !== id)
      commit(db)
    },
    async listTables(hallId) {
      return load().tables.filter((t) => t.hall_id === hallId)
    },
    async createTable(t) {
      const db = load()
      if (db.tables.some((x) => x.hall_id === t.hall_id && x.label === t.label)) {
        throw new Error(tr().duplicateTable(t.label))
      }
      const table: DiningTable = { ...t, id: crypto.randomUUID() }
      db.tables.push(table)
      commit(db)
      return table
    },
    async updateTable(id, patch) {
      const db = load()
      const current = db.tables.find((t) => t.id === id)
      if (current && patch.label !== undefined && db.tables.some((x) => x.id !== id && x.hall_id === current.hall_id && x.label === patch.label)) {
        throw new Error(tr().duplicateTable(patch.label))
      }
      db.tables = db.tables.map((t) => (t.id === id ? { ...t, ...patch } : t))
      commit(db)
    },
    async deleteTable(id) {
      const db = load()
      db.tables = db.tables.filter((t) => t.id !== id)
      commit(db)
    },
    subscribe(onChange) {
      listeners.add(onChange)
      return () => {
        listeners.delete(onChange)
      }
    },

    async getMenu(opts) {
      const db = loadOrders()
      // Menus saved before categories and items could be hidden have no `active` field.
      const cats = db.categories.map((c) => ({ ...c, active: c.active ?? true }))
      const items = db.items.map((i) => ({ ...i, active: i.active ?? true }))
      const shown = new Set(cats.filter((c) => c.active).map((c) => c.id))
      return opts?.includeHidden
        ? buildMenu(cats, items, db.groups, db.options)
        : buildMenu(cats.filter((c) => c.active), items.filter((i) => i.active && shown.has(i.category_id)), db.groups, db.options)
    },
    async createCategory(c) {
      const row: Category = { ...c, id: crypto.randomUUID() }
      editMenu((db) => db.categories.push(row))
      return row
    },
    async updateCategory(id, patch) {
      editMenu((db) => (db.categories = db.categories.map((c) => (c.id === id ? { ...c, ...patch } : c))))
    },
    async deleteCategory(id) {
      editMenu((db) => {
        db.items.filter((i) => i.category_id === id).forEach((i) => removeItem(db, i.id))
        db.categories = db.categories.filter((c) => c.id !== id)
      })
    },
    async createItem(i) {
      const row: MenuItem = { ...i, id: crypto.randomUUID() }
      editMenu((db) => db.items.push(row))
      return row
    },
    async updateItem(id, patch) {
      editMenu((db) => (db.items = db.items.map((i) => (i.id === id ? { ...i, ...patch } : i))))
    },
    async deleteItem(id) {
      editMenu((db) => removeItem(db, id))
    },
    async createOptionGroup(g) {
      const row = { ...g, id: crypto.randomUUID() }
      editMenu((db) => db.groups.push(row))
      return { ...row, options: [] }
    },
    async updateOptionGroup(id, patch) {
      editMenu((db) => (db.groups = db.groups.map((g) => (g.id === id ? { ...g, ...patch } : g))))
    },
    async deleteOptionGroup(id) {
      editMenu((db) => removeGroup(db, id))
    },
    async createOption(o) {
      const row: ItemOption = { ...o, id: crypto.randomUUID() }
      editMenu((db) => db.options.push(row))
      return row
    },
    async updateOption(id, patch) {
      editMenu((db) => (db.options = db.options.map((o) => (o.id === id ? { ...o, ...patch } : o))))
    },
    async deleteOption(id) {
      editMenu((db) => (db.options = db.options.filter((o) => o.id !== id)))
    },
    async getOpenOrder(tableId) {
      const db = loadOrders()
      const order = db.orders.find((o) => o.table_id === tableId && o.status === 'open')
      if (!order) return null
      return { order, lines: db.lines.filter((l) => l.order_id === order.id) }
    },
    async openOrder(tableId) {
      const db = loadOrders()
      let order = db.orders.find((o) => o.table_id === tableId && o.status === 'open')
      if (!order) {
        order = { id: crypto.randomUUID(), table_id: tableId, status: 'open', note: null, created_at: new Date().toISOString() }
        db.orders.push(order)
        commitOrders(db)
      }
      setTableStatus(tableId, 'occupied')
      return order
    },
    async cancelOrder(orderId) {
      const db = loadOrders()
      const order = db.orders.find((o) => o.id === orderId && o.status === 'open')
      if (!order) return
      order.status = 'cancelled'
      commitOrders(db)
      setTableStatus(order.table_id, 'free')
    },
    async addLine(orderId, line) {
      const db = loadOrders()
      const row: OrderLine = { ...line, id: crypto.randomUUID(), order_id: orderId, created_at: new Date().toISOString() }
      db.lines.push(row)
      commitOrders(db)
      return row
    },
    async updateLine(id, patch) {
      const db = loadOrders()
      db.lines = db.lines.map((l) => (l.id === id ? { ...l, ...patch } : l))
      commitOrders(db)
    },
    async deleteLine(id) {
      const db = loadOrders()
      db.lines = db.lines.filter((l) => l.id !== id)
      commitOrders(db)
    },
    subscribeOrders(onChange) {
      orderListeners.add(onChange)
      return () => {
        orderListeners.delete(onChange)
      }
    },

    async checkoutOrder(orderId, method, received) {
      const db = loadOrders()
      const i = db.orders.findIndex((o) => o.id === orderId)
      if (i < 0 || db.orders[i].status !== 'open') throw checkoutError('order_not_open')
      const lines = db.lines.filter((l) => l.order_id === orderId)
      if (!lines.length) throw checkoutError('order_empty')
      const total = lineTotal(lines)
      if (method === 'cash' && received !== null && received < total) throw checkoutError('amount_too_low')
      const ticket_no = (db.lastTicket ?? 0) + 1
      const paid: PaidOrder = {
        ...db.orders[i], status: 'paid', closed_at: new Date().toISOString(), ticket_no, total, payment_method: method,
        amount_received: method === 'cash' ? received ?? total : total,
      }
      db.orders[i] = paid
      db.lastTicket = ticket_no
      commitOrders(db)
      setTableStatus(paid.table_id, 'free')
      return paid
    },
    async getReceiptSettings() {
      return { ...defaultReceiptSettings(), ...loadOrders().receipt }
    },
    async updateReceiptSettings(patch) {
      const db = loadOrders()
      db.receipt = { ...defaultReceiptSettings(), ...db.receipt, ...patch }
      commitOrders(db)
    },
  }
}

export const repo: Repo = supabase ? supabaseRepo(supabase) : localRepo()

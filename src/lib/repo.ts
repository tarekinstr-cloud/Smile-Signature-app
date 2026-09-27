import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type {
  Category, DiningTable, Hall, HallPatch, ItemOption, Menu, MenuItem, NewOrderLine, NewTable, OptionGroup, Order,
  OrderLine, OrderLinePatch, TablePatch,
} from './types'
import { demoMenu } from './demoMenu'

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

  /** Active categories and items, with each item's option groups. */
  getMenu(): Promise<Menu>
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
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey) : null

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data
}

function supabaseRepo(sb: SupabaseClient): Repo {
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

    async getMenu() {
      const [cats, items, groups, options] = await Promise.all([
        sb.from('categories').select('id, name, color, sort_order').eq('active', true).order('sort_order').order('created_at'),
        sb.from('items').select('id, category_id, name, price, sort_order').eq('active', true).order('sort_order').order('created_at'),
        sb.from('option_groups').select('*').order('sort_order'),
        sb.from('options').select('*').order('sort_order'),
      ])
      return buildMenu(
        check(cats) as Category[],
        (check(items) as MenuItem[]).map((i) => ({ ...i, price: Number(i.price) })),
        check(groups) as Omit<OptionGroup, 'options'>[],
        (check(options) as ItemOption[]).map((o) => ({ ...o, price_delta: Number(o.price_delta) })),
      )
    },
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
        throw new Error(`الطاولة "${t.label}" موجودة من قبل في هذه الصالة`)
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
        throw new Error(`الطاولة "${patch.label}" موجودة من قبل في هذه الصالة`)
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

    async getMenu() {
      const db = loadOrders()
      return buildMenu(db.categories, db.items, db.groups, db.options)
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
  }
}

export const repo: Repo = supabase ? supabaseRepo(supabase) : localRepo()

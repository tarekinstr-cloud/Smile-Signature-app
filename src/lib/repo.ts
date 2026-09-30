import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import type {
  Category, CategoryPatch, DiningTable, Hall, HallPatch, ItemOption, ItemOptionPatch, Menu, MenuItem, MenuItemPatch, MenuTable,
  NewCategory, NewItemOption, NewMenuItem, NewOptionGroup, NewOrderLine, NewTable, OptionGroup, OptionGroupPatch, Order,
  OrderLine, OrderLinePatch, PaidOrder, Payment, PaymentMethod, ReceiptSettings, TablePatch, AdjustmentsPatch,
  CategoryPrinters, KitchenTicket, NewPrinter, Printer, PrinterPatch, InvoiceCustomer, TableMove, DeliveryCustomer, DeliveryStatus,
} from './types'
import { demoMenu } from './demoMenu'
import { buildKitchenTickets, type SendResult } from './kitchen'
import { tr } from './i18n'
import { computeBill, normalizeAdjustments } from './billing'
import { newId } from './id'

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
  /** The table's open order, its lines and the payments already made (partial payments), or null when the table has none. */
  getOpenOrder(tableId: string): Promise<OpenOrder | null>
  /** An open order by id, with its lines and payments; null once it is paid or cancelled. */
  getOrder(orderId: string): Promise<OpenOrder | null>
  /** Opens an order on the table (marking it occupied), or returns the one already open. */
  openOrder(tableId: string): Promise<Order>
  /** Opens a takeaway order: no table, and the next takeaway number. */
  openTakeaway(): Promise<Order>
  /** Opens a delivery order for this customer: no table, the next delivery number, status « En préparation ». */
  openDelivery(customer: DeliveryCustomer): Promise<Order>
  /** Changes a delivery's customer or status. */
  updateDelivery(orderId: string, patch: DeliveryPatch): Promise<Order>
  /** Open takeaway or delivery orders, oldest first, with their lines and payments. */
  listOpenOrders(type: 'takeaway' | 'delivery'): Promise<OpenOrder[]>
  /** Every table of every hall (Changement de Table). */
  listAllTables(): Promise<DiningTable[]>
  /**
   * Changement de Table: moves an open order, with its lines (and their kitchen status) and payments, to another
   * free table. The old table is freed and the move is logged in table_moves. Refused when the target table already
   * has an open order. An order never leaves its table otherwise (only payment or cancellation close it).
   */
  moveOrder(orderId: string, tableId: string): Promise<Order>
  /** Moves logged for an order, oldest first. */
  listTableMoves(orderId: string): Promise<TableMove[]>
  /** Facture: saves the optional customer on the order and gives it an invoice number the first time. */
  issueInvoice(orderId: string, customer: InvoiceCustomer): Promise<Order>
  /** Kitchen tickets already sent for an order (reprint), oldest first. */
  listKitchenTickets(orderId: string): Promise<KitchenTicket[]>
  /** Cancels an open order and frees its table. Refused once a payment has been made on it. */
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
  /**
   * Pays `amount` of an open order (all of what is left, or part of it). `received` is the cash handed over (cash only).
   * When nothing is left to pay, the order is closed as paid, its table freed and it gets a receipt number: the paid
   * order is returned. Otherwise the order stays open and null is returned. An amount of 0 only closes an order
   * that has nothing left to pay (everything offered).
   */
  addPayment(orderId: string, method: PaymentMethod, amount: number, received: number | null): Promise<PaidOrder | null>
  listPayments(orderId: string): Promise<Payment[]>
  /**
   * Sets a discount or "offert" on the whole order (lineId null) or on one of its lines. Refused when the new total
   * would fall below what has already been paid.
   */
  adjust(orderId: string, lineId: string | null, patch: AdjustmentsPatch): Promise<void>
  getReceiptSettings(): Promise<ReceiptSettings>
  updateReceiptSettings(patch: Partial<ReceiptSettings>): Promise<void>

  listPrinters(): Promise<Printer[]>
  createPrinter(p: NewPrinter): Promise<Printer>
  updatePrinter(id: string, patch: PrinterPatch): Promise<void>
  /** Deletes the printer and its links to categories. Tickets already sent keep its name. */
  deletePrinter(id: string): Promise<void>
  getCategoryPrinters(): Promise<CategoryPrinters>
  /** Replaces the printers of a category. The same printer cannot be given twice. */
  setCategoryPrinters(categoryId: string, printerIds: string[]): Promise<void>
  /**
   * Valider: marks the order's new lines as sent, now, and builds one kitchen ticket per printer
   * concerned, with only those lines. The order stays open.
   */
  sendOrder(orderId: string, tableLabel: string | null): Promise<SendResult>
  /** Name printed on kitchen tickets: the signed-in user's name, or their e-mail. */
  waiterName(): Promise<string>
}

/**
 * Demo mode only: called once when an order becomes paid, with its lines (the fiches techniques take the ingredients
 * out of the demo stock). With Supabase the database does it itself, in the payment's transaction.
 */
type PaidListener = (order: PaidOrder, lines: OrderLine[]) => void
const paidListeners = new Set<PaidListener>()
export function onLocalOrderPaid(fn: PaidListener): () => void {
  paidListeners.add(fn)
  return () => paidListeners.delete(fn)
}

/** What can change on a delivery: its customer, its status. */
export type DeliveryPatch = Partial<DeliveryCustomer> & { status?: DeliveryStatus }

/** Printers created with a fresh demo database, and the demo categories they print (by position). */
const demoPrinters = ['CUISINE', 'PIZZA', 'CAISSE']
const demoCategoryPrinter = ['CAISSE', 'CAISSE', 'CUISINE', 'CUISINE', 'CUISINE']

const cleanPrinter = <T extends PrinterPatch>(p: T): T => ({
  ...p,
  ...(p.name !== undefined && { name: p.name.trim() }),
  ...(p.ip !== undefined && { ip: p.ip?.trim() || null }),
})

function checkPrinterIds(printerIds: string[]) {
  if (new Set(printerIds).size !== printerIds.length) throw new Error(tr().errPrinterTwice)
}

function printerError(message: string): Error {
  return message.includes('printers_name_key') || message.includes('23505') ? new Error(tr().errPrinterName) : new Error(message)
}

export interface OpenOrder {
  order: Order
  lines: OrderLine[]
  payments: Payment[]
}

// All columns: the order-actions migration adds some, and the screens keep working before it is run.
const ORDER_COLS = '*'

function checkAdjustments(patch: AdjustmentsPatch) {
  const v = patch.discount_value
  if (v !== undefined && (!Number.isFinite(v) || v < 0 || (patch.discount_type === 'percent' && v > 100))) throw new Error(tr().errDiscount)
}

export const defaultReceiptSettings = (): ReceiptSettings => ({
  name: 'Smile Signature',
  header: '',
  footer: 'Merci de votre visite — Bon Appétit !',
  logo: null,
})

/** A payment refused because no working day is open (Fond de caisse not entered, or the day was just closed). */
/** Demo: whether a working day is open in the demo cash store (cash.ts, key smile.cash.v1). */
function localDayOpen(): boolean {
  try {
    const saved = JSON.parse(localStorage.getItem('smile.cash.v1') ?? 'null') as { days?: { closed_at: string | null }[] } | null
    return !!saved?.days?.some((d) => !d.closed_at)
  } catch {
    return false
  }
}

export class CashClosedError extends Error {}

function checkoutError(code: string): Error {
  const t = tr()
  if (code.includes('no_open_day')) return new CashClosedError(t.errCashClosedPay)
  if (code.includes('order_not_open') || code.includes('order_not_found')) return new Error(t.errOrderClosed)
  if (code.includes('order_empty')) return new Error(t.errOrderEmpty)
  if (code.includes('amount_too_low')) return new Error(t.errAmountTooLow)
  if (code.includes('amount_invalid')) return new Error(t.errAmountInvalid)
  if (code.includes('below_paid')) return new Error(t.errBelowPaid)
  if (code.includes('table_occupied') || code.includes('orders_one_open_per_table')) return new Error(t.errTableOccupied)
  if (code.includes('table_not_found')) return new Error(t.errTableNotFound)
  if (code.includes('cancel_paid')) return new Error(t.errCancelPaid)
  if (code.includes('table_link_required')) return new Error(t.errTableLinkRequired)
  if (code.includes('table_has_order')) return new Error(t.errTableHasOrder)
  // Delivery zones need their own migration.
  if (code.includes('delivery_zone_not_found')) return new Error(t.errZoneGone)
  if (/delivery_zone|delivery_fee/.test(code)) return new Error(t.errMigrationZones)
  // Deliveries need the delivery migration.
  if (/delivery_|customer_phone|orders_order_type_check/.test(code)) return new Error(t.errMigrationDelivery)
  // Takeaway, table moves and invoices need the order-actions migration.
  if (/order_type|takeaway|table_moves|move_order|issue_invoice|invoice_no|customer_/.test(code) && /does not exist|schema cache|Could not find/i.test(code)) {
    return new Error(t.errMigrationActions)
  }
  // Payments need the payments migration; tell the user which file to run instead of a raw schema error.
  if (/add_payment|payments|discount_|offered/.test(code) && /does not exist|schema cache|Could not find/i.test(code)) return new Error(t.errMigration)
  return new Error(code)
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey) : null

function check<T>(res: { data: T; error: { message: string } | null }): T {
  // Refused by the database permissions (Fichier > Permissions): a readable message rather than the SQL error.
  if (res.error && /permission_denied|row-level security/i.test(res.error.message)) throw new Error(tr().errNoPermission)
  if (res.error) throw new Error(res.error.message)
  return res.data
}

/**
 * One realtime channel per topic, shared by every screen that listens to it.
 * supabase-js hands back the already-subscribed channel when a topic is reused
 * (the floor listens to orders for takeaways while an order screen is open), and adding
 * callbacks to it throws. So the channel is created and subscribed once, listeners are
 * kept in a set, and the channel is removed when the last listener leaves.
 */
export function sharedChannel(sb: SupabaseClient, topic: string, tables: string[]) {
  const listeners = new Set<() => void>()
  let channel: RealtimeChannel | null = null
  const notify = () => listeners.forEach((l) => l())
  return (onChange: () => void) => {
    // Wrap so the same callback registered twice stays two independent subscriptions.
    const listener = () => onChange()
    listeners.add(listener)
    if (!channel) {
      let c = sb.channel(topic)
      for (const table of tables) c = c.on('postgres_changes', { event: '*', schema: 'public', table }, notify)
      channel = c.subscribe()
    }
    return () => {
      if (!listeners.delete(listener)) return
      if (listeners.size === 0 && channel) {
        sb.removeChannel(channel)
        channel = null
      }
    }
  }
}

function supabaseRepo(sb: SupabaseClient): Repo {
  /** A table (or a hall's tables) with an open order cannot be deleted: the order would lose its table. */
  const refuseOpenOrders = async (tableIds: string[]) => {
    if (!tableIds.length) return
    const open = check(await sb.from('orders').select('id').in('table_id', tableIds).eq('status', 'open').limit(1)) as { id: string }[]
    if (open.length) throw checkoutError('table_has_order')
  }
  const floorChannel = sharedChannel(sb, 'floor', ['halls', 'tables'])
  const ordersChannel = sharedChannel(sb, 'orders', ['orders', 'order_items', 'payments'])
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
      const tables = check(await sb.from('tables').select('id').eq('hall_id', id)) as { id: string }[]
      await refuseOpenOrders(tables.map((t) => t.id))
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
      await refuseOpenOrders([id])
      check(await sb.from('tables').delete().eq('id', id))
    },
    subscribe(onChange) {
      return floorChannel(onChange)
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
      const res = await sb.from('orders').select(ORDER_COLS).eq('table_id', tableId).eq('status', 'open').maybeSingle()
      if (res.error) throw checkoutError(res.error.message)
      if (!res.data) return null
      const order = normalizeOrder(res.data as Order)
      const [lines, payments] = await Promise.all([
        sb.from('order_items').select('*').eq('order_id', order.id).order('created_at'),
        this.listPayments(order.id),
      ])
      return { order, lines: (check(lines) as OrderLine[]).map(normalizeLine), payments }
    },
    async getOrder(orderId) {
      const res = await sb.from('orders').select(ORDER_COLS).eq('id', orderId).eq('status', 'open').maybeSingle()
      if (res.error) throw checkoutError(res.error.message)
      if (!res.data) return null
      const order = normalizeOrder(res.data as Order)
      const [lines, payments] = await Promise.all([
        sb.from('order_items').select('*').eq('order_id', order.id).order('created_at'),
        this.listPayments(order.id),
      ])
      return { order, lines: (check(lines) as OrderLine[]).map(normalizeLine), payments }
    },
    async openTakeaway() {
      const res = await sb.from('orders').insert({ table_id: null, order_type: 'takeaway' }).select(ORDER_COLS).single()
      if (res.error) throw checkoutError(res.error.message)
      return normalizeOrder(res.data as Order)
    },
    async openDelivery(customer) {
      const res = await sb.from('orders').insert({ table_id: null, order_type: 'delivery', ...deliveryRow(customer) }).select(ORDER_COLS).single()
      if (res.error) throw checkoutError(res.error.message)
      return normalizeOrder(res.data as Order)
    },
    async updateDelivery(orderId, patch) {
      const res = await sb.from('orders').update(deliveryRow(patch)).eq('id', orderId).eq('order_type', 'delivery').select(ORDER_COLS).single()
      if (res.error) throw checkoutError(res.error.message)
      return normalizeOrder(res.data as Order)
    },
    async listOpenOrders(type) {
      const res = await sb.from('orders').select(ORDER_COLS).eq('status', 'open').eq('order_type', type).order('created_at')
      if (res.error) {
        // Before the order-actions migration there are no takeaway orders.
        if (/does not exist|schema cache|Could not find/i.test(res.error.message)) return []
        throw new Error(res.error.message)
      }
      const orders = (res.data as Order[]).map(normalizeOrder)
      if (!orders.length) return []
      const ids = orders.map((o) => o.id)
      const [lines, payments] = await Promise.all([
        sb.from('order_items').select('*').in('order_id', ids).order('created_at'),
        sb.from('payments').select('id, order_id, method, amount, received, change_amount, created_at').in('order_id', ids).order('created_at'),
      ])
      const allLines = (check(lines) as OrderLine[]).map(normalizeLine)
      const allPayments = payments.error ? [] : (payments.data as Payment[]).map(normalizePayment)
      return orders.map((order) => ({
        order,
        lines: allLines.filter((l) => l.order_id === order.id),
        payments: allPayments.filter((p) => p.order_id === order.id),
      }))
    },
    async listAllTables() {
      return check(await sb.from('tables').select('*').order('created_at')) as DiningTable[]
    },
    async moveOrder(orderId, tableId) {
      const res = await sb.rpc('move_order', { p_order_id: orderId, p_table_id: tableId, p_user_name: await this.waiterName() })
      if (res.error) throw checkoutError(res.error.message)
      return normalizeOrder(res.data as Order)
    },
    async listTableMoves(orderId) {
      const res = await sb.from('table_moves').select('*').eq('order_id', orderId).order('moved_at')
      if (res.error) throw checkoutError(res.error.message)
      return res.data as TableMove[]
    },
    async issueInvoice(orderId, customer) {
      const res = await sb.rpc('issue_invoice', { p_order_id: orderId, p_name: customer.name, p_address: customer.address })
      if (res.error) throw checkoutError(res.error.message)
      return normalizeOrder(res.data as Order)
    },
    async listKitchenTickets(orderId) {
      const res = await sb.from('kitchen_tickets').select('*').eq('order_id', orderId).order('created_at')
      if (res.error) throw checkoutError(res.error.message)
      return res.data as KitchenTicket[]
    },
    async openOrder(tableId) {
      const res = await sb.from('orders').insert({ table_id: tableId }).select(ORDER_COLS).single()
      // 23505: another device opened an order on this table first.
      if (res.error?.code === '23505') {
        const existing = await this.getOpenOrder(tableId)
        if (existing) return existing.order
      }
      return normalizeOrder(check(res) as Order)
    },
    async cancelOrder(orderId) {
      if ((await this.listPayments(orderId)).length) throw checkoutError('cancel_paid')
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
      return ordersChannel(onChange)
    },

    async checkoutOrder(orderId, method, received) {
      const res = await sb.rpc('checkout_order', { p_order_id: orderId, p_method: method, p_received: received })
      if (res.error) throw checkoutError(res.error.message)
      return normalizePaid(res.data as PaidOrder)
    },
    async addPayment(orderId, method, amount, received) {
      const res = await sb.rpc('add_payment', { p_order_id: orderId, p_method: method, p_amount: amount, p_received: received })
      if (res.error) throw checkoutError(res.error.message)
      const o = res.data as PaidOrder
      return o.status === 'paid' ? normalizePaid(o) : null
    },
    async listPayments(orderId) {
      const res = await sb.from('payments').select('id, order_id, method, amount, received, change_amount, created_at').eq('order_id', orderId).order('created_at')
      if (res.error) {
        // Before the payments migration there are no partial payments: the screen still works for one-off payments.
        if (/does not exist|schema cache|Could not find/i.test(res.error.message)) return []
        throw new Error(res.error.message)
      }
      return (res.data as Payment[]).map(normalizePayment)
    },
    async adjust(orderId, lineId, patch) {
      checkAdjustments(patch)
      const res = await sb.from('orders').select(ORDER_COLS).eq('id', orderId).single()
      if (res.error) throw checkoutError(res.error.message)
      const order = normalizeOrder(res.data as Order)
      if (order.status !== 'open') throw checkoutError('order_not_open')
      const [lines, payments] = await Promise.all([
        sb.from('order_items').select('*').eq('order_id', orderId),
        this.listPayments(orderId),
      ])
      const next = (check(lines) as OrderLine[]).map(normalizeLine).map((l) => (l.id === lineId ? { ...l, ...patch } : l))
      if (payments.length && computeBill(lineId ? order : { ...order, ...patch }, next, payments).total < computeBill(order, [], payments).paid) {
        throw checkoutError('below_paid')
      }
      const upd = lineId ? await sb.from('order_items').update(patch).eq('id', lineId) : await sb.from('orders').update(patch).eq('id', orderId)
      if (upd.error) throw checkoutError(upd.error.message)
    },
    async getReceiptSettings() {
      // All columns: the logo column comes with a later migration.
      const row = check(await sb.from('receipt_settings').select('*').eq('id', 1).maybeSingle()) as ReceiptSettings | null
      return row ? { name: row.name, header: row.header, footer: row.footer, logo: row.logo ?? null } : defaultReceiptSettings()
    },
    async updateReceiptSettings(patch) {
      check(await sb.from('receipt_settings').upsert({ id: 1, ...patch }))
    },

    async listPrinters() {
      return check(await sb.from('printers').select('id, name, ip, port, sort_order').order('sort_order').order('created_at')) as Printer[]
    },
    async createPrinter(p) {
      const res = await sb.from('printers').insert(cleanPrinter(p)).select('id, name, ip, port, sort_order').single()
      if (res.error) throw printerError(res.error.message)
      return res.data as Printer
    },
    async updatePrinter(id, patch) {
      const res = await sb.from('printers').update(cleanPrinter(patch)).eq('id', id)
      if (res.error) throw printerError(res.error.message)
    },
    async deletePrinter(id) {
      check(await sb.from('printers').delete().eq('id', id))
    },
    async getCategoryPrinters() {
      const rows = check(await sb.from('category_printers').select('category_id, printer_id')) as { category_id: string; printer_id: string }[]
      return groupLinks(rows)
    },
    async setCategoryPrinters(categoryId, printerIds) {
      checkPrinterIds(printerIds)
      const current = (await this.getCategoryPrinters())[categoryId] ?? []
      const removed = current.filter((id) => !printerIds.includes(id))
      const added = printerIds.filter((id) => !current.includes(id))
      if (removed.length) check(await sb.from('category_printers').delete().eq('category_id', categoryId).in('printer_id', removed))
      if (added.length) {
        check(await sb.from('category_printers').upsert(added.map((printer_id) => ({ category_id: categoryId, printer_id })), { ignoreDuplicates: true }))
      }
    },
    async sendOrder(orderId, tableLabel) {
      const [waiter, printers, links] = await Promise.all([this.waiterName(), this.listPrinters(), this.getCategoryPrinters()])
      const res = await sb.rpc('send_order_lines', { p_order_id: orderId })
      if (res.error) throw checkoutError(res.error.message)
      const lines = (res.data as OrderLine[]).map(normalizeLine)
      if (!lines.length) return { tickets: [], unrouted: [] }
      const itemIds = [...new Set(lines.map((l) => l.item_id).filter((id): id is string => !!id))]
      const items = itemIds.length ? (check(await sb.from('items').select('id, category_id').in('id', itemIds)) as Pick<MenuItem, 'id' | 'category_id'>[]) : []
      const itemCategory = Object.fromEntries(items.map((i) => [i.id, i.category_id]))
      const at = lines.reduce((max, l) => (l.sent_at && l.sent_at > max ? l.sent_at : max), '') || new Date().toISOString()
      const built = buildKitchenTickets(lines, itemCategory, links, printers, { orderId, tableLabel, waiter, at })
      const tickets = built.tickets.length ? (check(await sb.from('kitchen_tickets').insert(built.tickets).select()) as KitchenTicket[]) : []
      // Inserted rows come back in no set order: keep the printers' order.
      const rank = (t: KitchenTicket) => built.tickets.findIndex((b) => b.printer_id === t.printer_id)
      return { tickets: tickets.sort((a, b) => rank(a) - rank(b)), unrouted: built.unrouted }
    },
    async waiterName() {
      const { data } = await sb.auth.getUser()
      const meta = data.user?.user_metadata ?? {}
      return String(meta.full_name || meta.name || data.user?.email || tr().waiterUnknown)
    },
  }
}

function groupLinks(rows: { category_id: string; printer_id: string }[]): CategoryPrinters {
  const out: CategoryPrinters = {}
  for (const r of rows) (out[r.category_id] ??= []).push(r.printer_id)
  return out
}

function normalizeOrder(o: Order): Order {
  // Rows saved before the order-actions / delivery migrations (or old demo data) have no type, number or customer.
  return {
    ...normalizeAdjustments(o),
    order_type: o.order_type === 'takeaway' || o.order_type === 'delivery' ? o.order_type : 'dine_in',
    takeaway_no: o.takeaway_no == null ? null : Number(o.takeaway_no),
    delivery_no: o.delivery_no == null ? null : Number(o.delivery_no),
    customer_name: o.customer_name ?? null,
    customer_address: o.customer_address ?? null,
    customer_phone: o.customer_phone ?? null,
    delivery_status: o.order_type === 'delivery' ? o.delivery_status ?? 'preparing' : null,
    invoice_no: o.invoice_no == null ? null : Number(o.invoice_no),
    // Rows saved before the delivery-zones migration have no zone and no fee.
    delivery_zone_id: o.delivery_zone_id ?? null,
    delivery_zone_name: o.delivery_zone_name ?? null,
    delivery_fee: Number(o.delivery_fee ?? 0),
  }
}

type DeliveryRow = Partial<Pick<Order, 'customer_name' | 'customer_phone' | 'customer_address' | 'delivery_status'
  | 'delivery_zone_id' | 'delivery_zone_name' | 'delivery_fee'>>

/**
 * Delivery fields to write: only those given, trimmed, empty text saved as null. The zone's name and fee are copied onto
 * the order (in Supabase a trigger copies them again from the delivery_zones table).
 */
function deliveryRow(patch: DeliveryPatch): DeliveryRow {
  const text = (v: string) => v.trim() || null
  return {
    ...(patch.zone !== undefined && {
      delivery_zone_id: patch.zone?.id ?? null, delivery_zone_name: patch.zone?.name ?? null, delivery_fee: patch.zone?.fee ?? 0,
    }),
    ...(patch.name !== undefined && { customer_name: text(patch.name) }),
    ...(patch.phone !== undefined && { customer_phone: text(patch.phone) }),
    ...(patch.address !== undefined && { customer_address: text(patch.address) }),
    ...(patch.status !== undefined && { delivery_status: patch.status }),
  }
}

function normalizePaid(o: PaidOrder): PaidOrder {
  return {
    ...normalizeOrder(o), status: o.status, closed_at: o.closed_at ?? new Date().toISOString(),
    ticket_no: Number(o.ticket_no), total: Number(o.total), payment_method: o.payment_method ?? null, amount_received: Number(o.amount_received),
  }
}

function normalizePayment(p: Payment): Payment {
  return { ...p, amount: Number(p.amount), received: Number(p.received), change_amount: Number(p.change_amount) }
}

function normalizeLine(l: OrderLine): OrderLine {
  return {
    ...normalizeAdjustments(l),
    unit_price: Number(l.unit_price),
    options: (l.options ?? []).map((o) => ({ ...o, price_delta: Number(o.price_delta) })),
    sent_at: l.sent_at ?? null,
    // Rows saved before the line-takeaway migration (or old demo data) have no flag.
    is_takeaway: !!l.is_takeaway,
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

/** Demo mode: name of the account signed in on this device, kept on the orders it opens (ventes par employé). */
let demoUserName: string | null = null
export function setDemoUserName(name: string | null) {
  demoUserName = name
}

const newOrder = (tableId: string | null): Order => ({
  id: newId(), table_id: tableId, status: 'open', note: null, created_at: new Date().toISOString(),
  discount_type: null, discount_value: 0, offered: false,
  order_type: 'dine_in', takeaway_no: null, customer_name: null, customer_address: null, invoice_no: null,
  delivery_no: null, customer_phone: null, delivery_status: null,
  delivery_zone_id: null, delivery_zone_name: null, delivery_fee: 0, created_by_name: demoUserName,
})

const KEY = 'smile.floor.v1'

interface LocalDb {
  halls: Hall[]
  tables: DiningTable[]
}

function seed(): LocalDb {
  const h1 = newId()
  const h2 = newId()
  const t = (hall_id: string, label: string, seats: number, shape: DiningTable['shape'], x: number, y: number, width: number, height: number): DiningTable => ({
    id: newId(), hall_id, label, seats, shape, x, y, width, height, status: 'free',
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
  /** Missing in demo data saved before kitchen printers existed; created on first use. */
  printers?: Printer[]
  categoryPrinters?: CategoryPrinters
  kitchenTickets?: KitchenTicket[]
  /** Missing in demo data saved before partial payments existed. */
  payments?: Payment[]
  /** Missing in demo data saved before takeaway orders, table moves and invoices existed. */
  lastTakeaway?: number
  /** Missing in demo data saved before delivery orders existed. */
  lastDelivery?: number
  lastInvoice?: number
  tableMoves?: TableMove[]
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
  /** Demo database with its printers, adding the demo ones the first time. */
  const loadKitchen = () => {
    const db = loadOrders()
    if (!db.printers) {
      db.printers = demoPrinters.map((name, sort_order) => ({ id: newId(), name, ip: null, port: 9100, sort_order }))
      const byName = Object.fromEntries(db.printers.map((p) => [p.name, p.id]))
      const cats = [...db.categories].sort((a, b) => a.sort_order - b.sort_order)
      db.categoryPrinters = Object.fromEntries(cats.slice(0, demoCategoryPrinter.length).map((c, i) => [c.id, [byName[demoCategoryPrinter[i]]]]))
      saveOrders(db)
    }
    return db as LocalOrdersDb & { printers: Printer[]; categoryPrinters: CategoryPrinters }
  }
  const printerNameTaken = (db: { printers: Printer[] }, name: string, id?: string) =>
    db.printers.some((p) => p.id !== id && p.name.trim().toLowerCase() === name.trim().toLowerCase())
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

  const openOrderOf = (db: LocalOrdersDb, order: Order): OpenOrder => ({
    order: normalizeOrder(order),
    lines: db.lines.filter((l) => l.order_id === order.id).map((l) => normalizeAdjustments({ ...l, sent_at: l.sent_at ?? null, is_takeaway: !!l.is_takeaway })),
    payments: (db.payments ?? []).filter((p) => p.order_id === order.id),
  })

  /** Mirrors the database: a table with an open order cannot be deleted. */
  const refuseOpenOrders = (tableIds: string[]) => {
    if (loadOrders().orders.some((o) => o.status === 'open' && o.table_id && tableIds.includes(o.table_id))) throw checkoutError('table_has_order')
  }

  return {
    mode: 'local',
    async listHalls() {
      return [...load().halls].sort((a, b) => a.sort_order - b.sort_order)
    },
    async createHall(name) {
      const db = load()
      const sort_order = db.halls.length ? Math.max(...db.halls.map((h) => h.sort_order)) + 1 : 0
      const hall: Hall = { id: newId(), name, width: 1000, height: 640, sort_order }
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
      refuseOpenOrders(db.tables.filter((t) => t.hall_id === id).map((t) => t.id))
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
      const table: DiningTable = { ...t, id: newId() }
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
      refuseOpenOrders([id])
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
      const row: Category = { ...c, id: newId() }
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
        if (db.categoryPrinters) delete db.categoryPrinters[id]
      })
    },
    async createItem(i) {
      const row: MenuItem = { ...i, id: newId() }
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
      const row = { ...g, id: newId() }
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
      const row: ItemOption = { ...o, id: newId() }
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
      return order ? openOrderOf(db, order) : null
    },
    async getOrder(orderId) {
      const db = loadOrders()
      const order = db.orders.find((o) => o.id === orderId && o.status === 'open')
      return order ? openOrderOf(db, order) : null
    },
    async openTakeaway() {
      const db = loadOrders()
      const takeaway_no = (db.lastTakeaway ?? 0) + 1
      const order: Order = { ...newOrder(null), order_type: 'takeaway', takeaway_no }
      db.lastTakeaway = takeaway_no
      db.orders.push(order)
      commitOrders(db)
      return order
    },
    async openDelivery(customer) {
      const db = loadOrders()
      const delivery_no = (db.lastDelivery ?? 0) + 1
      const order: Order = { ...newOrder(null), order_type: 'delivery', delivery_no, delivery_status: 'preparing', ...deliveryRow(customer) }
      db.lastDelivery = delivery_no
      db.orders.push(order)
      commitOrders(db)
      return order
    },
    async updateDelivery(orderId, patch) {
      const db = loadOrders()
      const order = db.orders.find((o) => o.id === orderId && o.order_type === 'delivery')
      if (!order) throw checkoutError('order_not_found')
      Object.assign(order, deliveryRow(patch))
      commitOrders(db)
      return normalizeOrder(order)
    },
    async listOpenOrders(type) {
      const db = loadOrders()
      return db.orders
        .filter((o) => o.status === 'open' && o.order_type === type)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((o) => openOrderOf(db, o))
    },
    async listAllTables() {
      return load().tables
    },
    // Mirrors public.move_order() in the order-actions migration.
    async moveOrder(orderId, tableId) {
      const db = loadOrders()
      const order = db.orders.find((o) => o.id === orderId)
      if (!order || order.status !== 'open') throw checkoutError('order_not_open')
      if (!tableId) throw checkoutError('table_link_required')
      if ((order.table_id ?? null) === tableId) return normalizeOrder(order)
      const floor = load()
      const to = floor.tables.find((x) => x.id === tableId)
      if (!to) throw checkoutError('table_not_found')
      if (db.orders.some((o) => o.table_id === tableId && o.status === 'open')) throw checkoutError('table_occupied')
      const from = order.table_id ? floor.tables.find((x) => x.id === order.table_id) ?? null : null
      const fromId = order.table_id
      order.table_id = tableId
      order.order_type = 'dine_in'
      ;(db.tableMoves ??= []).push({
        id: newId(), order_id: orderId, from_table_id: fromId, to_table_id: tableId,
        from_label: from?.label ?? null, to_label: to.label, moved_by_name: await this.waiterName(), moved_at: new Date().toISOString(),
      })
      commitOrders(db)
      if (fromId && !db.orders.some((o) => o.table_id === fromId && o.status === 'open')) setTableStatus(fromId, 'free')
      setTableStatus(tableId, 'occupied')
      return normalizeOrder(order)
    },
    async listTableMoves(orderId) {
      return (loadOrders().tableMoves ?? []).filter((m) => m.order_id === orderId)
    },
    async issueInvoice(orderId, customer) {
      const db = loadOrders()
      const order = db.orders.find((o) => o.id === orderId)
      if (!order || order.status === 'cancelled') throw checkoutError('order_not_open')
      if (!db.lines.some((l) => l.order_id === orderId)) throw checkoutError('order_empty')
      order.customer_name = customer.name.trim() || null
      order.customer_address = customer.address.trim() || null
      if (order.invoice_no == null) {
        order.invoice_no = (db.lastInvoice ?? 0) + 1
        db.lastInvoice = order.invoice_no
      }
      commitOrders(db)
      return normalizeOrder(order)
    },
    async listKitchenTickets(orderId) {
      return (loadOrders().kitchenTickets ?? []).filter((k) => k.order_id === orderId)
    },
    async openOrder(tableId) {
      const db = loadOrders()
      let order = db.orders.find((o) => o.table_id === tableId && o.status === 'open')
      if (!order) {
        order = newOrder(tableId)
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
      if ((db.payments ?? []).some((p) => p.order_id === orderId)) throw checkoutError('cancel_paid')
      order.status = 'cancelled'
      commitOrders(db)
      setTableStatus(order.table_id, 'free')
    },
    async addLine(orderId, line) {
      const db = loadOrders()
      const row: OrderLine = {
        is_takeaway: false,
        ...line, id: newId(), order_id: orderId, created_at: new Date().toISOString(), sent_at: null,
        discount_type: null, discount_value: 0, offered: false,
      }
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
      const order = db.orders.find((o) => o.id === orderId)
      const payments = (db.payments ?? []).filter((p) => p.order_id === orderId)
      const { remaining } = computeBill(order ? normalizeOrder(order) : null, db.lines.filter((l) => l.order_id === orderId).map(normalizeAdjustments), payments)
      const paid = await this.addPayment(orderId, method, remaining, received)
      if (!paid) throw checkoutError('amount_invalid')
      return paid
    },
    // Mirrors public.add_payment() in the payments migration.
    async addPayment(orderId, method, amount, received) {
      const db = loadOrders()
      const i = db.orders.findIndex((o) => o.id === orderId)
      if (i < 0 || db.orders[i].status !== 'open') throw checkoutError('order_not_open')
      const lines = db.lines.filter((l) => l.order_id === orderId).map(normalizeAdjustments)
      if (!lines.length) throw checkoutError('order_empty')
      // Like the database trigger: no payment while the drawer is closed.
      if (!localDayOpen()) throw checkoutError('no_open_day')
      const payments = (db.payments ??= [])
      const bill = computeBill(normalizeOrder(db.orders[i]), lines, payments.filter((p) => p.order_id === orderId))
      const pay = Math.round(amount * 100) / 100
      if (!(pay >= 0) || pay > bill.remaining || (pay === 0 && bill.remaining > 0)) throw checkoutError('amount_invalid')
      let remaining = bill.remaining
      if (pay > 0) {
        const got = method === 'cash' ? received ?? pay : pay
        if (got < pay) throw checkoutError('amount_too_low')
        payments.push({
          id: newId(), order_id: orderId, method, amount: pay, received: got, change_amount: Math.round((got - pay) * 100) / 100,
          created_at: new Date().toISOString(),
        })
        remaining = Math.round((remaining - pay) * 100) / 100
      }
      if (remaining > 0) {
        commitOrders(db)
        return null
      }
      const mine = payments.filter((p) => p.order_id === orderId)
      const ticket_no = (db.lastTicket ?? 0) + 1
      const paid: PaidOrder = {
        ...normalizeOrder(db.orders[i]), status: 'paid', closed_at: new Date().toISOString(), ticket_no, total: bill.total,
        payment_method: mine.at(-1)?.method ?? null, amount_received: mine.reduce((s, p) => s + p.received, 0),
      }
      db.orders[i] = paid
      db.lastTicket = ticket_no
      commitOrders(db)
      setTableStatus(paid.table_id, 'free')
      paidListeners.forEach((l) => l(paid, lines))
      return paid
    },
    async listPayments(orderId) {
      return (loadOrders().payments ?? []).filter((p) => p.order_id === orderId)
    },
    async adjust(orderId, lineId, patch) {
      checkAdjustments(patch)
      const db = loadOrders()
      const order = db.orders.find((o) => o.id === orderId)
      if (!order || order.status !== 'open') throw checkoutError('order_not_open')
      const payments = (db.payments ?? []).filter((p) => p.order_id === orderId)
      const lines = db.lines.filter((l) => l.order_id === orderId).map(normalizeAdjustments)
      const next = lines.map((l) => (l.id === lineId ? { ...l, ...patch } : l))
      const bill = computeBill(lineId ? normalizeOrder(order) : { ...normalizeOrder(order), ...patch }, next, payments)
      if (payments.length && bill.total < bill.paid) throw checkoutError('below_paid')
      if (lineId) db.lines = db.lines.map((l) => (l.id === lineId ? { ...l, ...patch } : l))
      else Object.assign(order, patch)
      commitOrders(db)
    },
    async getReceiptSettings() {
      return { ...defaultReceiptSettings(), ...loadOrders().receipt }
    },
    async updateReceiptSettings(patch) {
      const db = loadOrders()
      db.receipt = { ...defaultReceiptSettings(), ...db.receipt, ...patch }
      commitOrders(db)
    },

    async listPrinters() {
      return [...loadKitchen().printers].sort((a, b) => a.sort_order - b.sort_order)
    },
    async createPrinter(p) {
      const db = loadKitchen()
      const row: Printer = { ...cleanPrinter(p), id: newId() }
      if (printerNameTaken(db, row.name)) throw new Error(tr().errPrinterName)
      db.printers.push(row)
      commitOrders(db)
      return row
    },
    async updatePrinter(id, patch) {
      const db = loadKitchen()
      const clean = cleanPrinter(patch)
      if (clean.name !== undefined && printerNameTaken(db, clean.name, id)) throw new Error(tr().errPrinterName)
      db.printers = db.printers.map((p) => (p.id === id ? { ...p, ...clean } : p))
      commitOrders(db)
    },
    async deletePrinter(id) {
      const db = loadKitchen()
      db.printers = db.printers.filter((p) => p.id !== id)
      for (const c of Object.keys(db.categoryPrinters)) db.categoryPrinters[c] = db.categoryPrinters[c].filter((x) => x !== id)
      db.kitchenTickets = db.kitchenTickets?.map((t) => (t.printer_id === id ? { ...t, printer_id: null } : t))
      commitOrders(db)
    },
    async getCategoryPrinters() {
      const links = loadKitchen().categoryPrinters
      return Object.fromEntries(Object.entries(links).filter(([, ids]) => ids.length))
    },
    async setCategoryPrinters(categoryId, printerIds) {
      checkPrinterIds(printerIds)
      const db = loadKitchen()
      const known = new Set(db.printers.map((p) => p.id))
      db.categoryPrinters[categoryId] = printerIds.filter((id) => known.has(id))
      commitOrders(db)
    },
    async sendOrder(orderId, tableLabel) {
      const waiter = await this.waiterName()
      const db = loadKitchen()
      const order = db.orders.find((o) => o.id === orderId)
      if (!order || order.status !== 'open') throw checkoutError('order_not_open')
      const at = new Date().toISOString()
      const sent: OrderLine[] = []
      db.lines = db.lines.map((l) => {
        if (l.order_id !== orderId || l.sent_at) return l
        const row = { ...l, sent_at: at }
        sent.push(row)
        return row
      })
      if (!sent.length) return { tickets: [], unrouted: [] }
      const itemCategory = Object.fromEntries(db.items.map((i) => [i.id, i.category_id]))
      const built = buildKitchenTickets(sent, itemCategory, db.categoryPrinters, db.printers, { orderId, tableLabel, waiter, at })
      const tickets = built.tickets.map((t) => ({ ...t, id: newId() }))
      // The demo keeps only the latest tickets, to stay within the browser's storage.
      db.kitchenTickets = [...(db.kitchenTickets ?? []), ...tickets].slice(-200)
      commitOrders(db)
      return { tickets, unrouted: built.unrouted }
    },
    async waiterName() {
      return tr().waiterDemo
    },
  }
}

export const repo: Repo = supabase ? supabaseRepo(supabase) : localRepo()

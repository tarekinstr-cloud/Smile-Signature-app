import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import type {
  Category, CategoryPatch, DiningTable, Hall, HallPatch, ItemOption, ItemOptionPatch, Menu, MenuItem, MenuItemPatch, MenuTable,
  NewCategory, NewItemOption, NewMenuItem, NewOptionGroup, NewOrderLine, NewTable, OptionGroup, OptionGroupPatch, Order,
  OrderLine, OrderLinePatch, PaidOrder, Payment, PaymentMethod, ReceiptSettings, TablePatch, AdjustmentsPatch,
  CategoryPrinters, KitchenTicket, NewPrinter, Printer, PrinterPatch, InvoiceCustomer, TableMove, DeliveryCustomer, DeliveryStatus,
  Cancellation, CancelledOrder, PriceChange, TableOrderInfo, FloorConfig, PickupStatus, OrderArea, Driver, StaffDriver,
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
  /**
   * Fond de salle: saves the (already compressed) image as the hall's background, or removes it (null). The previous
   * file is deleted. Needs the Édition or Paramètres permission.
   */
  setHallBackground(hallId: string, image: Blob | null): Promise<void>
  /** Open orders of a hall's tables: waiter, guests and timer, for the floor plan. */
  listTableOrders(hallId: string): Promise<TableOrderInfo[]>
  /** Couverts of an open order (null: not given). */
  setGuests(orderId: string, guests: number | null): Promise<void>
  /** « Servi »: stops the order's waiting timer (server time) until the next send to the kitchen. */
  markServed(orderId: string): Promise<void>
  /** Paramètres > Configurations: thresholds of the floor timer. */
  getFloorConfig(): Promise<FloorConfig>
  updateFloorConfig(config: FloorConfig): Promise<void>
  /** Calls onChange when the configuration changes on another device. */
  subscribeConfig(onChange: () => void): () => void
  /** Background picture of the À emporter or Livraison view (already compressed), or null to remove it. */
  setAreaBackground(area: OrderArea, image: Blob | null): Promise<void>
  /** Bipeur of a takeaway order (null: none). */
  setPager(orderId: string, pager: string | null): Promise<void>
  /** Active drivers, to choose one on a delivery. */
  listDrivers(): Promise<Driver[]>
  /** Gestion des employés: active accounts with their Livreur box and phone (permission « staff »). */
  listStaffDrivers(): Promise<StaffDriver[]>
  setStaffDriver(userId: string, isDriver: boolean, phone: string): Promise<void>
  /** Assigns a driver to a delivery (null: none); the driver's name and phone are copied onto the order. */
  setOrderDriver(orderId: string, driverId: string | null): Promise<void>
  /** Current time of the server (ms since 1970), to correct this device's clock. The device's own clock in demo mode. */
  serverNow(): Promise<number>

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
  /** `number`: the customer's number chosen in the grid (refused with « Numéro déjà utilisé » when in use). */
  openTakeaway(number?: number): Promise<Order>
  /** Opens a delivery order for this customer: no table, the next delivery number, status « En préparation ». */
  openDelivery(customer: DeliveryCustomer): Promise<Order>
  /** Changes a delivery's customer or status. */
  updateDelivery(orderId: string, patch: DeliveryPatch): Promise<Order>
  /** Open takeaway or delivery orders, oldest first, with their lines and payments. */
  listOpenOrders(type: 'takeaway' | 'delivery'): Promise<OpenOrder[]>
  /** À emporter already paid but not handed to the customer yet, oldest first: they stay in the view (number in use). */
  listPickupWaiting(): Promise<OpenOrder[]>
  /** Livraisons already paid but not delivered yet, oldest first: they stay in the view (number in use). */
  listDeliveryWaiting(): Promise<OpenOrder[]>
  /** À emporter: En préparation, Prête or Remise au client (open or already paid). */
  setPickupStatus(orderId: string, status: PickupStatus): Promise<void>
  /** Customer's name on a takeaway order (shown on its card and kitchen tickets); empty text removes it. */
  setCustomerName(orderId: string, name: string): Promise<void>
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
  /**
   * Cancels an open order and frees its table. Refused once a payment has been made on it. An order with items needs
   * a reason (the database refuses it otherwise); an empty order left behind does not.
   */
  cancelOrder(orderId: string, why?: Cancellation): Promise<void>
  /** The bill (Addition) of an open order was printed: cancelling it afterwards needs the cancel_invoice permission. */
  markPrinted(orderId: string): Promise<void>
  /**
   * Annule un ticket déjà encaissé (permission cancel_invoice, journée de caisse ouverte): the order is cancelled and
   * its cash part leaves the drawer of the open day.
   */
  voidTicket(orderId: string, why: Cancellation): Promise<void>
  /** Cancelled orders that had items, cancelled during [from, to), newest first, with their lines. */
  listCancelled(from: Date, to: Date): Promise<CancelledOrder[]>
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
/** Demo price log (Liste des modifications des prix), like the database triggers. Read by control.ts. */
export const PRICE_LOG_KEY = 'smile.pricelog.v1'
function logLocalPrice(c: Omit<PriceChange, 'id' | 'user_name' | 'created_at'>) {
  try {
    const list = JSON.parse(localStorage.getItem(PRICE_LOG_KEY) ?? '[]') as PriceChange[]
    list.push({ ...c, id: newId(), user_name: demoUserName ?? '', created_at: new Date().toISOString() })
    localStorage.setItem(PRICE_LOG_KEY, JSON.stringify(list.slice(-5000)))
  } catch {
    // Not persisted (private mode).
  }
}

/** Demo: permissions of the signed-in account, kept by permissions.ts (the database checks them otherwise). */
let demoCan: (p: string) => boolean = () => true
export function setDemoPermissionCheck(fn: (p: string) => boolean) {
  demoCan = fn
}
export const localCan = (p: string) => demoCan(p)

/** Cancelled orders with their lines; empty orders left behind are not cancellations worth listing. */
function cancelledWithLines(orders: Order[], lines: OrderLine[]): CancelledOrder[] {
  const byOrder = new Map<string, OrderLine[]>()
  for (const l of lines) (byOrder.get(l.order_id) ?? byOrder.set(l.order_id, []).get(l.order_id)!).push(l)
  return orders
    .filter((o) => byOrder.has(o.id))
    .map((o) => {
      const mine = byOrder.get(o.id)!
      return { ...o, cancelled_total: o.cancelled_total == null ? null : Number(o.cancelled_total), void_cash: Number(o.void_cash ?? 0), lines: mine, sent: mine.filter((l) => l.sent_at).length }
    })
}

/** Demo: id of the open working day in the demo cash store (cash.ts), or null. */
function localOpenDayId(): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem('smile.cash.v1') ?? 'null') as { days?: { id: string; closed_at: string | null }[] } | null
    return saved?.days?.find((d) => !d.closed_at)?.id ?? null
  } catch {
    return null
  }
}

/** Demo: cash expected in the drawer of the open day (float + cash payments − cash given back + entrées − sorties). */
function localDrawerCash(dayId: string, db: LocalOrdersDb): number {
  try {
    const saved = JSON.parse(localStorage.getItem('smile.cash.v1') ?? 'null') as {
      days: { id: string; period_start: string; opening_float: number }[]
      movements: { day_id: string; kind: 'in' | 'out'; amount: number }[]
    }
    const day = saved.days.find((d) => d.id === dayId)
    if (!day) return 0
    const sales = (db.payments ?? []).filter((p) => p.method === 'cash' && p.created_at >= day.period_start).reduce((n, p) => n + Number(p.amount), 0)
    const back = db.orders.filter((o) => o.voided && o.voided_day_id === dayId).reduce((n, o) => n + Number(o.void_cash ?? 0), 0)
    const moves = saved.movements.filter((m) => m.day_id === dayId).reduce((n, m) => n + (m.kind === 'in' ? m.amount : -m.amount), 0)
    return Math.round((day.opening_float + sales - back + moves) * 100) / 100
  } catch {
    return 0
  }
}

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
  if (code.includes('cancel_reason_required')) return new Error(t.errCancelReason)
  if (code.includes('cancel_note_required')) return new Error(t.errCancelNote)
  if (code.includes('permission_denied:cancel_invoice')) return new Error(t.errCancelInvoice)
  if (code.includes('void_by_rpc_only')) return new Error(t.errCancelPaid)
  const short = /insufficient_cash:(-?[\d.]+)/.exec(code)
  if (short) return new Error(t.errCashShort(`${Number(short[1]).toLocaleString('fr-FR')} ${t.currency}`))
  if (code.includes('order_not_open') || code.includes('order_not_found')) return new Error(t.errOrderClosed)
  if (code.includes('order_empty')) return new Error(t.errOrderEmpty)
  if (code.includes('amount_too_low')) return new Error(t.errAmountTooLow)
  if (code.includes('amount_invalid')) return new Error(t.errAmountInvalid)
  if (code.includes('below_paid')) return new Error(t.errBelowPaid)
  if (code.includes('table_occupied') || code.includes('orders_one_open_per_table')) return new Error(t.errTableOccupied)
  if (code.includes('orders_takeaway_number_in_use') || code.includes('orders_delivery_number_in_use')) return new Error(t.errNumberInUse)
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

export const defaultFloorConfig = (): FloorConfig => ({
  timer_warn_min: 15, timer_alert_min: 30, pager_enabled: false,
  takeaway_number_min: 1, takeaway_number_max: 40, delivery_number_min: 41, delivery_number_max: 60,
  takeaway_background_url: null, delivery_background_url: null,
})

/** Fields of Paramètres > Configurations saved by updateFloorConfig (the backgrounds have their own function). */
type EditableConfig = Omit<FloorConfig, 'takeaway_background_url' | 'delivery_background_url'>

/** Thresholds checked like the app_config table: whole minutes, 1 to 600, orange before red. */
export function checkFloorConfig(c: FloorConfig): EditableConfig {
  const warn = Math.round(c.timer_warn_min)
  const alert = Math.round(c.timer_alert_min)
  if (!(warn >= 1 && warn <= 600 && alert >= 2 && alert <= 600 && alert > warn)) throw new Error(tr().errTimerThresholds)
  const [tMin, tMax, dMin, dMax] = [c.takeaway_number_min, c.takeaway_number_max, c.delivery_number_min, c.delivery_number_max].map((n) => Math.round(Number(n)))
  const range = (min: number, max: number) => min >= 1 && max <= 9999 && max >= min && max - min < 500
  if (!range(tMin, tMax) || !range(dMin, dMax)) throw new Error(tr().errNumberRange)
  // Overlapping ranges would let « 41 » mean a takeaway and a delivery at the same time.
  if (tMin <= dMax && dMin <= tMax) throw new Error(tr().errNumberRangesOverlap)
  return {
    timer_warn_min: warn, timer_alert_min: alert, pager_enabled: !!c.pager_enabled,
    takeaway_number_min: tMin, takeaway_number_max: tMax, delivery_number_min: dMin, delivery_number_max: dMax,
  }
}

const tableOrderInfo = (o: Order): TableOrderInfo => ({
  order_id: o.id, table_id: o.table_id ?? '', created_at: o.created_at, created_by_name: o.created_by_name ?? null,
  guests: o.guests == null ? null : Number(o.guests), served_at: o.served_at ?? null, timer_at: o.timer_at ?? null,
})

/** Readable message when the floor-visual migration (20261002000000_floor_visual.sql) has not been run. */
function floorError(message: string): Error {
  if (/bucket not found|set_hall_background|mark_order_served|app_config|guests|served_at|background_/i.test(message)
    && /not found|does not exist|schema cache|Could not find/i.test(message)) return new Error(tr().errMigrationFloor)
  if (/permission_denied|row-level security|Unauthorized|403/i.test(message)) return new Error(tr().errNoPermission)
  return new Error(message)
}

/** Readable message when the À emporter / Livraison view migration (20261005000000) has not been run. */
function areaError(message: string): Error {
  if (/set_area_background|list_staff_drivers|set_staff_driver|set_order_driver|pager_no|driver_|is_driver|bucket not found/i.test(message)
    && /not found|does not exist|schema cache|Could not find/i.test(message)) return new Error(tr().errMigrationArea)
  if (/permission_denied|row-level security|Unauthorized|403/i.test(message)) return new Error(tr().errNoPermission)
  return new Error(message)
}

/** A pager number: up to 10 characters, empty text removes it. */
export const cleanPager = (p: string | null) => p?.trim().slice(0, 10) || null

/** A chosen takeaway / delivery number: whole, 1 to 9999. */
function checkOrderNumber(n: number) {
  if (!(Number.isInteger(n) && n >= 1 && n <= 9999)) throw new Error(tr().errNumberInvalid)
}

/** A takeaway / delivery order whose number is in use: open, or paid but not handed / delivered yet. */
export function inUse(o: Pick<Order, 'status' | 'order_type' | 'pickup_status' | 'delivery_status'>): boolean {
  if (o.status === 'open') return true
  if (o.status !== 'paid') return false
  return o.order_type === 'takeaway' ? o.pickup_status === 'preparing' || o.pickup_status === 'ready'
    : o.order_type === 'delivery' ? o.delivery_status !== 'delivered' : false
}

function checkGuests(guests: number | null) {
  if (guests !== null && !(Number.isInteger(guests) && guests >= 1 && guests <= 99)) throw new Error(tr().errGuests)
}

const BACKGROUND_BUCKET = 'floor-backgrounds'

function supabaseRepo(sb: SupabaseClient): Repo {
  /** A table (or a hall's tables) with an open order cannot be deleted: the order would lose its table. */
  const refuseOpenOrders = async (tableIds: string[]) => {
    if (!tableIds.length) return
    const open = check(await sb.from('orders').select('id').in('table_id', tableIds).eq('status', 'open').limit(1)) as { id: string }[]
    if (open.length) throw checkoutError('table_has_order')
  }
  const floorChannel = sharedChannel(sb, 'floor', ['halls', 'tables'])
  const ordersChannel = sharedChannel(sb, 'orders', ['orders', 'order_items', 'payments'])
  const configChannel = sharedChannel(sb, 'app_config', ['app_config'])
  /** Orders with their lines (paid orders listed in the À emporter / Livraison views). */
  const withLines = async (orders: Order[]): Promise<OpenOrder[]> => {
    if (!orders.length) return []
    const lines = (check(await sb.from('order_items').select('*').in('order_id', orders.map((o) => o.id))) as OrderLine[]).map(normalizeLine)
    return orders.map((order) => ({ order, lines: lines.filter((l) => l.order_id === order.id), payments: [] }))
  }
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
    async setHallBackground(hallId, image) {
      let url: string | null = null
      let path: string | null = null
      if (image) {
        path = `${hallId}/${newId()}.jpg`
        const up = await sb.storage.from(BACKGROUND_BUCKET).upload(path, image, { contentType: image.type || 'image/jpeg', cacheControl: '31536000', upsert: false })
        if (up.error) throw floorError(up.error.message)
        url = sb.storage.from(BACKGROUND_BUCKET).getPublicUrl(path).data.publicUrl
      }
      const res = await sb.rpc('set_hall_background', { p_hall_id: hallId, p_url: url, p_path: path })
      if (res.error) {
        if (path) await sb.storage.from(BACKGROUND_BUCKET).remove([path])
        throw floorError(res.error.message)
      }
      const old = res.data as string | null
      // The old file is no longer used; failing to delete it only leaves a file behind.
      if (old && old !== path) await sb.storage.from(BACKGROUND_BUCKET).remove([old])
    },
    async listTableOrders(hallId) {
      const tables = check(await sb.from('tables').select('id').eq('hall_id', hallId)) as { id: string }[]
      if (!tables.length) return []
      const res = await sb.from('orders').select('*').eq('status', 'open').in('table_id', tables.map((t) => t.id))
      if (res.error) throw floorError(res.error.message)
      return (res.data as Order[]).map(tableOrderInfo)
    },
    async setGuests(orderId, guests) {
      checkGuests(guests)
      const res = await sb.from('orders').update({ guests }).eq('id', orderId).eq('status', 'open')
      if (res.error) throw floorError(res.error.message)
    },
    async markServed(orderId) {
      const res = await sb.rpc('mark_order_served', { p_order_id: orderId })
      if (res.error) throw res.error.message.includes('order_not_open') ? checkoutError('order_not_open') : floorError(res.error.message)
    },
    async getFloorConfig() {
      // All columns: the default guests come with a later migration than the thresholds.
      const res = await sb.from('app_config').select('*').eq('id', 1).maybeSingle()
      // Before the migration: the default values.
      if (res.error || !res.data) return defaultFloorConfig()
      const d = defaultFloorConfig()
      return {
        timer_warn_min: Number(res.data.timer_warn_min), timer_alert_min: Number(res.data.timer_alert_min),
        takeaway_number_min: Number(res.data.takeaway_number_min ?? d.takeaway_number_min),
        takeaway_number_max: Number(res.data.takeaway_number_max ?? d.takeaway_number_max),
        delivery_number_min: Number(res.data.delivery_number_min ?? d.delivery_number_min),
        delivery_number_max: Number(res.data.delivery_number_max ?? d.delivery_number_max),
        pager_enabled: !!res.data.pager_enabled,
        takeaway_background_url: res.data.takeaway_background_url ?? null,
        delivery_background_url: res.data.delivery_background_url ?? null,
      }
    },
    async updateFloorConfig(config) {
      const c = checkFloorConfig(config)
      const res = await sb.from('app_config').update({ ...c, updated_at: new Date().toISOString() }).eq('id', 1).select('id')
      if (res.error) {
        throw /pager_enabled/.test(res.error.message) ? new Error(tr().errMigrationArea)
          : /number_(min|max)/.test(res.error.message) ? new Error(tr().errMigrationNumbers) : floorError(res.error.message)
      }
      if (!res.data?.length) throw new Error(tr().errNoPermission)
    },
    subscribeConfig(onChange) {
      return configChannel(onChange)
    },
    async setAreaBackground(area, image) {
      let url: string | null = null
      let path: string | null = null
      if (image) {
        path = `area-${area}/${newId()}.jpg`
        const up = await sb.storage.from(BACKGROUND_BUCKET).upload(path, image, { contentType: image.type || 'image/jpeg', cacheControl: '31536000', upsert: false })
        if (up.error) throw areaError(up.error.message)
        url = sb.storage.from(BACKGROUND_BUCKET).getPublicUrl(path).data.publicUrl
      }
      const res = await sb.rpc('set_area_background', { p_area: area, p_url: url, p_path: path })
      if (res.error) {
        if (path) await sb.storage.from(BACKGROUND_BUCKET).remove([path])
        throw areaError(res.error.message)
      }
      const old = res.data as string | null
      if (old && old !== path) await sb.storage.from(BACKGROUND_BUCKET).remove([old])
    },
    async setPager(orderId, pager) {
      const res = await sb.from('orders').update({ pager_no: cleanPager(pager) }).eq('id', orderId)
      if (res.error) throw areaError(res.error.message)
    },
    async listDrivers() {
      const res = await sb.rpc('list_drivers')
      // Before the migration: no drivers to choose from.
      if (res.error) return []
      return res.data as Driver[]
    },
    async listStaffDrivers() {
      const res = await sb.rpc('list_staff_drivers')
      if (res.error) throw areaError(res.error.message)
      return res.data as StaffDriver[]
    },
    async setStaffDriver(userId, isDriver, phone) {
      const res = await sb.rpc('set_staff_driver', { p_user_id: userId, p_is_driver: isDriver, p_phone: phone })
      if (res.error) throw areaError(res.error.message)
    },
    async setOrderDriver(orderId, driverId) {
      const res = await sb.rpc('set_order_driver', { p_order_id: orderId, p_driver: driverId })
      if (res.error) throw res.error.message.includes('driver_not_found') ? new Error(tr().errDriverGone) : areaError(res.error.message)
    },
    async serverNow() {
      const res = await sb.rpc('server_now')
      if (res.error) throw floorError(res.error.message)
      return new Date(res.data as string).getTime()
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
    async openTakeaway(number) {
      if (number !== undefined) checkOrderNumber(number)
      const res = await sb.from('orders').insert({ table_id: null, order_type: 'takeaway', ...(number && { takeaway_no: number }) }).select(ORDER_COLS).single()
      if (res.error) throw checkoutError(res.error.message)
      return normalizeOrder(res.data as Order)
    },
    async openDelivery(customer) {
      if (customer.number !== undefined) checkOrderNumber(customer.number)
      const row = { table_id: null, order_type: 'delivery', ...deliveryRow(customer), ...(customer.number && { delivery_no: customer.number }) }
      const res = await sb.from('orders').insert(row).select(ORDER_COLS).single()
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
    async listPickupWaiting() {
      const res = await sb.from('orders').select(ORDER_COLS).eq('status', 'paid').eq('order_type', 'takeaway')
        .in('pickup_status', ['preparing', 'ready']).order('created_at')
      // Before the takeaway-board migration there is no pickup status: nothing waits.
      if (res.error) return []
      return withLines((res.data as Order[]).map(normalizeOrder))
    },
    async listDeliveryWaiting() {
      const res = await sb.from('orders').select(ORDER_COLS).eq('status', 'paid').eq('order_type', 'delivery')
        .in('delivery_status', ['preparing', 'on_the_way']).order('created_at')
      if (res.error) return []
      return withLines((res.data as Order[]).map(normalizeOrder))
    },
    async setPickupStatus(orderId, status) {
      const res = await sb.from('orders').update({ pickup_status: status }).eq('id', orderId).eq('order_type', 'takeaway')
      if (res.error) throw /pickup_status/.test(res.error.message) ? new Error(tr().errMigrationTakeaway) : checkoutError(res.error.message)
    },
    async setCustomerName(orderId, name) {
      const res = await sb.from('orders').update({ customer_name: name.trim().slice(0, 60) || null }).eq('id', orderId)
      if (res.error) throw checkoutError(res.error.message)
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
    async cancelOrder(orderId, why) {
      if ((await this.listPayments(orderId)).length) throw checkoutError('cancel_paid')
      const reason = why ? { cancel_reason: why.reason, cancel_note: why.note.trim() } : {}
      const res = await sb.from('orders').update({ status: 'cancelled', ...reason }).eq('id', orderId).eq('status', 'open')
      if (res.error) throw checkoutError(res.error.message)
    },
    async voidTicket(orderId, why) {
      const res = await sb.rpc('void_paid_order', { p_order_id: orderId, p_reason: why.reason, p_note: why.note.trim() })
      if (res.error) throw checkoutError(res.error.message)
    },
    async listCancelled(from, to) {
      const res = await sb.from('orders').select('*').eq('status', 'cancelled').gte('cancelled_at', from.toISOString())
        .lt('cancelled_at', to.toISOString()).order('cancelled_at', { ascending: false })
      if (res.error) throw checkoutError(res.error.message)
      const orders = (res.data as Order[]).map(normalizeOrder)
      const lines: OrderLine[] = []
      for (let i = 0; i < orders.length; i += 100) {
        const ids = orders.slice(i, i + 100).map((o) => o.id)
        lines.push(...(check(await sb.from('order_items').select('*').in('order_id', ids)) as OrderLine[]).map(normalizeLine))
      }
      return cancelledWithLines(orders, lines)
    },
    async markPrinted(orderId) {
      // Before migration 20260930140000_control.sql the column does not exist: printing still works.
      await sb.from('orders').update({ printed_at: new Date().toISOString() }).eq('id', orderId).eq('status', 'open').is('printed_at', null)
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
    // Rows saved before the floor-visual migration have no guests and no timer fields.
    guests: o.guests == null ? null : Number(o.guests),
    served_at: o.served_at ?? null,
    timer_at: o.timer_at ?? null,
    pickup_status: o.order_type === 'takeaway' ? o.pickup_status ?? 'preparing' : null,
    pager_no: o.pager_no ?? null,
    driver_id: o.driver_id ?? null,
    driver_name: o.driver_name ?? null,
    driver_phone: o.driver_phone ?? null,
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
const CONFIG_KEY = 'smile.config.v1'
const DRIVERS_KEY = 'smile.drivers.v1'

/** Demo accounts (admin.ts, key smile.users.v1), read here directly: admin.ts imports this module. */
function readLocalAccounts(): { id: string; username: string; display_name: string; active: boolean }[] {
  try {
    const list = JSON.parse(localStorage.getItem('smile.users.v1') ?? 'null')
    return Array.isArray(list) && list.length ? list : [{ id: 'demo-admin', username: 'admin', display_name: 'Administrateur', active: true }]
  } catch {
    return []
  }
}

/** Demo: the Livreur box and phone of each demo account. */
function readLocalDrivers(): Record<string, { is_driver: boolean; phone: string | null }> {
  try {
    return JSON.parse(localStorage.getItem(DRIVERS_KEY) ?? '{}') ?? {}
  } catch {
    return {}
  }
}
const configListeners = new Set<() => void>()

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read'))
    reader.readAsDataURL(blob)
  })
}

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
    async setHallBackground(hallId, image) {
      if (!localCan('edit') && !localCan('settings')) throw new Error(tr().errNoPermission)
      const url = image ? await blobToDataUrl(image) : null
      const db = load()
      db.halls = db.halls.map((h) => (h.id === hallId ? { ...h, background_url: url, background_path: null } : h))
      save(db)
      // The demo keeps the image in this browser's storage, which is small: say so instead of losing it silently.
      if (url && load().halls.find((h) => h.id === hallId)?.background_url !== url) throw new Error(tr().errBackgroundTooBig)
      listeners.forEach((l) => l())
    },
    async listTableOrders(hallId) {
      const ids = new Set(load().tables.filter((t) => t.hall_id === hallId).map((t) => t.id))
      return loadOrders().orders.filter((o) => o.status === 'open' && o.table_id && ids.has(o.table_id)).map((o) => tableOrderInfo(normalizeOrder(o)))
    },
    async setGuests(orderId, guests) {
      checkGuests(guests)
      const db = loadOrders()
      const order = db.orders.find((o) => o.id === orderId && o.status === 'open')
      if (!order) throw checkoutError('order_not_open')
      order.guests = guests
      commitOrders(db)
    },
    async markServed(orderId) {
      const db = loadOrders()
      const order = db.orders.find((o) => o.id === orderId && o.status === 'open')
      if (!order) throw checkoutError('order_not_open')
      order.served_at = new Date().toISOString()
      commitOrders(db)
    },
    async getFloorConfig() {
      try {
        const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? 'null') as FloorConfig | null
        return saved ? { ...defaultFloorConfig(), ...saved, ...checkFloorConfig({ ...defaultFloorConfig(), ...saved }) } : defaultFloorConfig()
      } catch {
        return defaultFloorConfig()
      }
    },
    async updateFloorConfig(config) {
      // The backgrounds are kept: they are saved by setAreaBackground.
      const c = { ...(await this.getFloorConfig()), ...checkFloorConfig(config) }
      try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(c))
      } catch {
        // Not persisted (private mode): kept for this visit only.
      }
      configListeners.forEach((l) => l())
    },
    subscribeConfig(onChange) {
      configListeners.add(onChange)
      return () => {
        configListeners.delete(onChange)
      }
    },
    async setAreaBackground(area, image) {
      if (!localCan('edit') && !localCan('settings')) throw new Error(tr().errNoPermission)
      const url = image ? await blobToDataUrl(image) : null
      const c = { ...(await this.getFloorConfig()), [`${area}_background_url`]: url }
      try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(c))
      } catch {
        throw new Error(tr().errBackgroundTooBig)
      }
      configListeners.forEach((l) => l())
    },
    async setPager(orderId, pager) {
      const db = loadOrders()
      const order = db.orders.find((o) => o.id === orderId)
      if (!order) throw checkoutError('order_not_found')
      order.pager_no = cleanPager(pager)
      commitOrders(db)
    },
    async listDrivers() {
      return (await this.listStaffDrivers().catch(() => [])).filter((d) => d.is_driver).map(({ user_id, name, phone }) => ({ user_id, name, phone }))
    },
    async listStaffDrivers() {
      const extra = readLocalDrivers()
      return readLocalAccounts().filter((u) => u.active).map((u) => ({
        user_id: u.id, name: u.display_name.trim() || u.username, username: u.username,
        is_driver: !!extra[u.id]?.is_driver, phone: extra[u.id]?.phone ?? null,
      })).sort((a, b) => a.name.localeCompare(b.name))
    },
    async setStaffDriver(userId, isDriver, phone) {
      if (!localCan('staff')) throw new Error(tr().errNoPermission)
      const extra = readLocalDrivers()
      extra[userId] = { is_driver: isDriver, phone: phone.trim().slice(0, 30) || null }
      try {
        localStorage.setItem(DRIVERS_KEY, JSON.stringify(extra))
      } catch {
        // Not persisted (private mode).
      }
    },
    async setOrderDriver(orderId, driverId) {
      const driver = driverId ? (await this.listDrivers()).find((d) => d.user_id === driverId) : null
      if (driverId && !driver) throw new Error(tr().errDriverGone)
      const db = loadOrders()
      const order = db.orders.find((o) => o.id === orderId && o.order_type === 'delivery')
      if (!order) throw checkoutError('order_not_found')
      Object.assign(order, { driver_id: driver?.user_id ?? null, driver_name: driver?.name ?? null, driver_phone: driver?.phone ?? null })
      commitOrders(db)
    },
    async serverNow() {
      return Date.now()
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
      editMenu((db) => {
        const old = db.items.find((i) => i.id === id)
        if (old && patch.price !== undefined && Number(patch.price) !== Number(old.price)) {
          logLocalPrice({ kind: 'item', item_id: id, option_id: null, item_name: patch.name ?? old.name, group_name: '', option_name: '', old_price: Number(old.price), new_price: Number(patch.price) })
        }
        db.items = db.items.map((i) => (i.id === id ? { ...i, ...patch } : i))
      })
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
      editMenu((db) => {
        const old = db.options.find((o) => o.id === id)
        if (old && patch.price_delta !== undefined && Number(patch.price_delta) !== Number(old.price_delta)) {
          const g = db.groups.find((x) => x.id === old.group_id)
          logLocalPrice({
            kind: g && g.min_select >= 1 && g.max_select === 1 ? 'size' : 'supplement', item_id: g?.item_id ?? null, option_id: id,
            item_name: db.items.find((i) => i.id === g?.item_id)?.name ?? '', group_name: g?.name ?? '', option_name: patch.name ?? old.name,
            old_price: Number(old.price_delta), new_price: Number(patch.price_delta),
          })
        }
        db.options = db.options.map((o) => (o.id === id ? { ...o, ...patch } : o))
      })
    },
    async voidTicket(orderId, why) {
      if (!localCan('cancel_invoice')) throw checkoutError('permission_denied:cancel_invoice')
      const db = loadOrders()
      const order = db.orders.find((o) => o.id === orderId)
      if (!order || order.status !== 'paid') throw checkoutError('order_not_open')
      const dayId = localOpenDayId()
      if (!dayId) throw checkoutError('no_open_day')
      if (!why.reason) throw checkoutError('cancel_reason_required')
      if (why.reason === 'other' && !why.note.trim()) throw checkoutError('cancel_note_required')
      const cash = (db.payments ?? []).filter((p) => p.order_id === orderId && p.method === 'cash').reduce((s, p) => s + p.amount, 0)
      const available = localDrawerCash(dayId, db)
      if (cash > available) throw checkoutError(`insufficient_cash:${available}`)
      Object.assign(order, {
        status: 'cancelled', cancel_reason: why.reason, cancel_note: why.note.trim().slice(0, 300), cancelled_at: new Date().toISOString(),
        cancelled_by_name: demoUserName ?? '', cancelled_total: (order as PaidOrder).total ?? 0, voided: true, voided_day_id: dayId,
        void_cash: Math.round(cash * 100) / 100,
      })
      commitOrders(db)
    },
    async listCancelled(from, to) {
      const db = loadOrders()
      const inRange = (iso?: string | null) => !!iso && new Date(iso) >= from && new Date(iso) < to
      const orders = db.orders.filter((o) => o.status === 'cancelled' && inRange(o.cancelled_at)).map(normalizeOrder)
      return cancelledWithLines(orders, db.lines.filter((l) => orders.some((o) => o.id === l.order_id)).map(normalizeAdjustments))
        .sort((a, b) => (b.cancelled_at ?? '').localeCompare(a.cancelled_at ?? ''))
    },
    async markPrinted(orderId) {
      const db = loadOrders()
      const order = db.orders.find((o) => o.id === orderId && o.status === 'open')
      if (!order || order.printed_at) return
      order.printed_at = new Date().toISOString()
      commitOrders(db)
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
    async openTakeaway(number) {
      if (number !== undefined) checkOrderNumber(number)
      const db = loadOrders()
      // Like the orders_takeaway_number_in_use index: one order in progress per number.
      if (number && db.orders.some((o) => o.order_type === 'takeaway' && o.takeaway_no === number && inUse(o))) throw checkoutError('orders_takeaway_number_in_use')
      const takeaway_no = number ?? (db.lastTakeaway ?? 0) + 1
      const order: Order = { ...newOrder(null), order_type: 'takeaway', takeaway_no, pickup_status: 'preparing' }
      if (!number) db.lastTakeaway = takeaway_no
      db.orders.push(order)
      commitOrders(db)
      return order
    },
    async openDelivery(customer) {
      if (customer.number !== undefined) checkOrderNumber(customer.number)
      const db = loadOrders()
      const number = customer.number
      if (number && db.orders.some((o) => o.order_type === 'delivery' && o.delivery_no === number && inUse(o))) throw checkoutError('orders_delivery_number_in_use')
      const delivery_no = number ?? (db.lastDelivery ?? 0) + 1
      const order: Order = { ...newOrder(null), order_type: 'delivery', delivery_no, delivery_status: 'preparing', ...deliveryRow(customer) }
      if (!number) db.lastDelivery = delivery_no
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
    async listPickupWaiting() {
      const db = loadOrders()
      return db.orders.filter((o) => o.status === 'paid' && inUse(o) && o.order_type === 'takeaway')
        .sort((a, b) => a.created_at.localeCompare(b.created_at)).map((o) => openOrderOf(db, o))
    },
    async listDeliveryWaiting() {
      const db = loadOrders()
      return db.orders.filter((o) => o.status === 'paid' && inUse(o) && o.order_type === 'delivery')
        .sort((a, b) => a.created_at.localeCompare(b.created_at)).map((o) => openOrderOf(db, o))
    },
    async setPickupStatus(orderId, status) {
      const db = loadOrders()
      const order = db.orders.find((o) => o.id === orderId && o.order_type === 'takeaway')
      if (!order) throw checkoutError('order_not_found')
      order.pickup_status = status
      commitOrders(db)
    },
    async setCustomerName(orderId, name) {
      const db = loadOrders()
      const order = db.orders.find((o) => o.id === orderId)
      if (!order) throw checkoutError('order_not_found')
      order.customer_name = name.trim().slice(0, 60) || null
      commitOrders(db)
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
    async cancelOrder(orderId, why) {
      const db = loadOrders()
      const order = db.orders.find((o) => o.id === orderId && o.status === 'open')
      if (!order) return
      if ((db.payments ?? []).some((p) => p.order_id === orderId)) throw checkoutError('cancel_paid')
      // Same rules as the database trigger (orders_cancel_guard).
      const lines = db.lines.filter((l) => l.order_id === orderId).map(normalizeAdjustments)
      if (lines.length) {
        if (!why?.reason) throw checkoutError('cancel_reason_required')
        if (why.reason === 'other' && !why.note.trim()) throw checkoutError('cancel_note_required')
        if ((order.printed_at || order.invoice_no) && !localCan('cancel_invoice')) throw checkoutError('permission_denied:cancel_invoice')
      }
      Object.assign(order, {
        cancel_reason: why?.reason ?? '', cancel_note: why?.note.trim().slice(0, 300) ?? '', cancelled_at: new Date().toISOString(),
        cancelled_by_name: demoUserName ?? '', cancelled_total: computeBill(normalizeOrder(order), lines).total,
      })
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
      // Like the order_items_restart_timer trigger: a send after « Servi » starts the timer again.
      if (order.served_at) Object.assign(order, { served_at: null, timer_at: at })
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

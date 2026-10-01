export type TableStatus = 'free' | 'occupied'
export type TableShape = 'square' | 'round' | 'rect'

export interface Hall {
  id: string
  name: string
  width: number
  height: number
  sort_order: number
  /** Image de fond de la salle (Supabase Storage, ou image compressée en mode démo); null: fond quadrillé. */
  background_url?: string | null
  /** Chemin du fichier dans le bucket floor-backgrounds (pour le supprimer quand il est remplacé). */
  background_path?: string | null
}

export interface DiningTable {
  id: string
  hall_id: string
  label: string
  seats: number
  shape: TableShape
  x: number
  y: number
  width: number
  height: number
  status: TableStatus
}

export type NewTable = Omit<DiningTable, 'id'>
export type TablePatch = Partial<Omit<DiningTable, 'id' | 'hall_id'>>
export type HallPatch = Partial<Omit<Hall, 'id'>>

export interface Category {
  id: string
  name: string
  color: string
  sort_order: number
  /** Hidden categories stay in the admin screen but not on the order screen. */
  active: boolean
}

export interface MenuItem {
  id: string
  category_id: string
  name: string
  price: number
  sort_order: number
  active: boolean
}

export interface ItemOption {
  id: string
  group_id: string
  name: string
  price_delta: number
  sort_order: number
}

export interface OptionGroup {
  id: string
  item_id: string
  name: string
  /** 1 = required. */
  min_select: number
  /** 1 = pick one (radio), more = pick several (checkboxes). */
  max_select: number
  sort_order: number
  options: ItemOption[]
}

export interface Menu {
  categories: Category[]
  items: MenuItem[]
  /** Option groups keyed by item id. */
  groups: Record<string, OptionGroup[]>
}

export type OrderStatus = 'open' | 'paid' | 'cancelled'

/** A discount: a percentage, or a fixed amount in DA. */
export type DiscountType = 'percent' | 'amount'

export interface Discount {
  type: DiscountType
  value: number
}

/** Discount and "offert" settings, shared by an order and each of its lines. */
export interface Adjustments {
  discount_type: DiscountType | null
  /** Percent (0–100) or DA, depending on discount_type; 0 when there is no discount. */
  discount_value: number
  /** Offered: costs nothing, but stays in the statistics with its normal price. */
  offered: boolean
}

/** On a table of the floor plan, to take away, or delivered to the customer (no table for the last two). */
export type OrderType = 'dine_in' | 'takeaway' | 'delivery'

/** Where a delivery is: En préparation → En route → Livrée. */
export type DeliveryStatus = 'preparing' | 'on_the_way' | 'delivered'

export interface Order extends Adjustments {
  id: string
  /** Null for a takeaway or delivery order (or when its table was deleted). */
  table_id: string | null
  status: OrderStatus
  note: string | null
  created_at: string
  order_type: OrderType
  /** Short number called out for takeaway orders ("À emporter n° 12"); null for table orders. */
  takeaway_no: number | null
  /** Short number of a delivery ("Livraison n° 3"); null for other orders. */
  delivery_no: number | null
  /** Customer printed on the invoice (Facture); for a delivery, who and where to deliver. */
  customer_name: string | null
  customer_address: string | null
  /** Customer's phone (delivery). */
  customer_phone: string | null
  /** Null unless the order is a delivery. */
  delivery_status: DeliveryStatus | null
  /** Set the first time an invoice is made for the order. */
  invoice_no: number | null
  /** Delivery zone chosen for a delivery (null: none, or the zone was deleted since). */
  delivery_zone_id?: string | null
  /** Name of that zone when it was chosen; stays after the zone is renamed or deleted. */
  delivery_zone_name?: string | null
  /** Delivery fee added to the total (0 without a zone), copied from the zone when it was chosen. */
  delivery_fee?: number
  /** Employee who opened the order (ventes par employé); kept when the account is deleted. */
  created_by_name?: string | null
  /** Annulation (migration 20260930140000_control.sql): reason code, free text, when, who and the amount then. */
  cancel_reason?: string | null
  cancel_note?: string | null
  cancelled_at?: string | null
  cancelled_by_name?: string | null
  cancelled_total?: number | null
  /** When the bill (Addition) was printed; cancelling it afterwards needs the cancel_invoice permission. */
  printed_at?: string | null
  /** Ticket paid then cancelled: its cash part was given back from the drawer of the day open then. */
  voided?: boolean
  voided_day_id?: string | null
  void_cash?: number
  /** Couverts: number of guests at the table (colours as many chairs on the floor plan); null: not given. */
  guests?: number | null
  /** « Servi »: the waiting timer stops until the next send to the kitchen. */
  served_at?: string | null
  /** Start of the waiting timer after a « Servi » then a new send; null: since the order was opened. */
  timer_at?: string | null
}

/** Open order of a table, as the floor plan shows it: waiter, guests and waiting timer. */
export interface TableOrderInfo {
  order_id: string
  table_id: string
  created_at: string
  created_by_name: string | null
  guests: number | null
  served_at: string | null
  timer_at: string | null
}

/** Paramètres > Configurations: thresholds of the floor timer, in minutes (green below warn, orange, red from alert). */
export interface FloorConfig {
  timer_warn_min: number
  timer_alert_min: number
}

/** Why an order is cancelled: a code of the list (texts in i18n cancelReasons) and, for 'other', a free text. */
export const CANCEL_REASONS = ['entry_error', 'customer_left', 'customer_changed', 'unavailable', 'too_long', 'customer_complaint', 'test', 'other'] as const
export type CancelReason = (typeof CANCEL_REASONS)[number]
export interface Cancellation {
  reason: CancelReason
  note: string
}

/** A cancelled order with items (Commandes annulées / Factures annulées). */
export interface CancelledOrder extends Order {
  lines: OrderLine[]
  /** Lines already sent to the kitchen. */
  sent: number
}

/** One line of the Liste des modifications des prix (written by the database, never changed). */
export interface PriceChange {
  id: string
  kind: 'item' | 'size' | 'supplement'
  item_id: string | null
  option_id: string | null
  item_name: string
  group_name: string
  option_name: string
  old_price: number
  new_price: number
  user_name: string
  created_at: string
}

/** Customer details typed for an invoice; both optional. */
export interface InvoiceCustomer {
  name: string
  address: string
}

/** Customer of a delivery order, and the delivery zone (optional) whose fee is added to the order. */
export interface DeliveryCustomer {
  name: string
  phone: string
  address: string
  /** Undefined keeps the current zone; null removes it. */
  zone?: DeliveryZone | null
}

/** Area delivered to (quartier, ville), with its fee in DA and an estimated delivery time. Menu Édition. */
export interface DeliveryZone {
  id: string
  name: string
  fee: number
  /** Minutes; null when not given. */
  estimated_time: number | null
}

export type NewDeliveryZone = Omit<DeliveryZone, 'id'>

/** One "Changement de Table" (or switch to takeaway), kept in the table_moves log. */
export interface TableMove {
  id: string
  order_id: string
  from_table_id: string | null
  to_table_id: string | null
  /** Table labels at the time of the move; null means takeaway. */
  from_label: string | null
  to_label: string | null
  moved_by_name: string | null
  moved_at: string
}

/** Snapshot of a chosen option, copied onto the order line. */
export interface ChosenOption {
  group: string
  name: string
  price_delta: number
  /** The menu option picked: fiches techniques find it by id (older lines only have group and name). */
  option_id?: string
}

export interface OrderLine extends Adjustments {
  id: string
  order_id: string
  item_id: string | null
  name: string
  /** Price of one unit, options included. */
  unit_price: number
  quantity: number
  options: ChosenOption[]
  note: string | null
  created_at: string
  /** When the line went to the kitchen (Valider); null while it is new. */
  sent_at: string | null
  /**
   * Packed to take away (box / bag) although the order stays on its table. Independent of the order's
   * order_type and table_id: a whole takeaway order does not set it.
   */
  is_takeaway: boolean
  /**
   * Cost of one portion, fixed when the order was paid (fiche technique × last purchase price then); null before.
   * Never recomputed, so past profits stay as they were.
   */
  unit_cost?: number | null
  /** ok, no_recipe (no fiche: cost 0, « coût inconnu ») or no_price (an ingredient never bought: counted 0). */
  cost_status?: CostStatus | null
}

export type CostStatus = 'ok' | 'no_recipe' | 'no_price'

export type NewOrderLine = Pick<OrderLine, 'item_id' | 'name' | 'unit_price' | 'quantity' | 'options' | 'note'> & Partial<Pick<OrderLine, 'is_takeaway'>>
export type OrderLinePatch = Partial<Pick<OrderLine, 'quantity' | 'note' | 'options' | 'unit_price' | 'is_takeaway'>>
export type AdjustmentsPatch = Partial<Adjustments>

export type NewCategory = Omit<Category, 'id'>
export type CategoryPatch = Partial<NewCategory>
export type NewMenuItem = Omit<MenuItem, 'id'>
export type MenuItemPatch = Partial<NewMenuItem>
export type NewOptionGroup = Omit<OptionGroup, 'id' | 'options'>
export type OptionGroupPatch = Partial<Omit<NewOptionGroup, 'item_id'>>
export type NewItemOption = Omit<ItemOption, 'id'>
export type ItemOptionPatch = Partial<Omit<NewItemOption, 'group_id'>>
/** Tables of the menu that the admin screen edits. */
export type MenuTable = 'categories' | 'items' | 'option_groups' | 'options'

/**
 * How a payment is made. Stored as plain text, so a new mode (cheque, voucher…) only needs a new entry
 * in PAYMENT_METHODS (src/lib/billing.ts) and its label.
 */
export type PaymentMethod = 'cash' | 'card'

/** One payment on an order; several of them make a partial payment. */
export interface Payment {
  id: string
  order_id: string
  method: PaymentMethod
  /** Part of the order's total this payment settles. */
  amount: number
  /** Cash handed over by the customer (equals amount for other methods). */
  received: number
  /** Money given back: received − amount. */
  change_amount: number
  created_at: string
}

/** An order after its last payment: what the receipt prints. */
export interface PaidOrder extends Order {
  /** Sequential receipt number, assigned when the order is fully paid. */
  ticket_no: number
  total: number
  /** Method of the last payment. */
  payment_method: PaymentMethod | null
  /** Everything the customer handed over, all payments together. */
  amount_received: number
  closed_at: string
}

/** Editable text printed on every receipt. */
export interface ReceiptSettings {
  name: string
  /** Lines under the name: address, phone… */
  header: string
  /** Closing message, e.g. "Merci de votre visite — Bon Appétit !". */
  footer: string
  /** Logo printed at the top, as an image data URL. Empty: the app icon. */
  logo?: string | null
}

/** A kitchen / bar / cashier printer. The IP address is only needed once tickets are really printed. */
export interface Printer {
  id: string
  name: string
  ip: string | null
  /** Raw TCP port of network printers (ESC/POS), usually 9100. */
  port: number
  sort_order: number
}

export type NewPrinter = Omit<Printer, 'id'>
export type PrinterPatch = Partial<NewPrinter>

/** Printers each category's items go to, keyed by category id. */
export type CategoryPrinters = Record<string, string[]>

/** One line of a kitchen ticket: what to prepare, without prices. */
export interface KitchenTicketLine {
  name: string
  quantity: number
  options: string[]
  note: string | null
  /** To take away (box / bag) although the order is at a table. Missing on tickets made before this flag. */
  takeaway?: boolean
}

/** What one printer receives when an order is sent (Valider): the new lines of its categories only. */
export interface KitchenTicket {
  id: string
  order_id: string
  /** Null when the printer has been deleted since; the name stays. */
  printer_id: string | null
  printer_name: string
  table_label: string | null
  waiter: string
  created_at: string
  lines: KitchenTicketLine[]
  /** Set by the printing driver once the ticket is on paper; null while it waits. */
  printed_at: string | null
}

// ───────────── Back-office (Statistiques, Stock, Fournisseurs, Employés) ─────────────

/** An ingredient or product counted in stock, in two places: the Dépôt and the Cuisine. Sales consume the Cuisine through the fiches techniques. */
export interface StockItem {
  id: string
  name: string
  /** Qté Dépôt: purchases and manual adjustments go here. */
  quantity: number
  /** Qté Cuisine: filled by transfers from the Dépôt, emptied by returns and kitchen charges. */
  kitchen_quantity: number
  /** Free text: kg, L, pièce… */
  unit: string
  /** Stock minimum (Dépôt + Cuisine): at or below it, « Stock bas ». null: no alert. */
  min_quantity: number | null
  /** Unité d'achat (fardeau…), '' when bought in the stock unit. */
  purchase_unit: string
  /** 1 purchase unit = purchase_factor stock units (1 fardeau = 6 bouteilles); null without a purchase unit. */
  purchase_factor: number | null
  updated_at: string
}

export type NewStockItem = Pick<StockItem, 'name' | 'quantity' | 'unit'> & Partial<Pick<StockItem, 'min_quantity' | 'purchase_unit' | 'purchase_factor'>>

/** Where stock is kept. */
export type StockLocation = 'depot' | 'kitchen'
/** Transfer (Dépôt → Cuisine) or return (Cuisine → Dépôt). */
export type TransferDirection = 'to_kitchen' | 'to_depot'
/** consumption: taken from the Cuisine by a paid order, through the fiches techniques. */
export type StockMovementType = 'purchase' | 'transfer' | 'return' | 'charge' | 'adjustment' | 'consumption' | 'purchase_cancel' | 'supplier_return'
/** Motif of a kitchen charge: Consommation, Perte / Périmé, Casse, Repas personnel, Autre. */
export type ChargeReason = 'consumption' | 'loss' | 'breakage' | 'staff_meal' | 'other'
export const CHARGE_REASONS: ChargeReason[] = ['consumption', 'loss', 'breakage', 'staff_meal', 'other']

/** One line of the stock_movements table: what moved, from where to where, who did it and when. */
export interface StockMovement {
  id: string
  /** Movements made together (one transfer of several items) share it. */
  batch_id: string
  type: StockMovementType
  stock_item_id: string | null
  /** Kept when the item is deleted from the stock. */
  item_name: string
  unit: string
  quantity: number
  /** null: stock coming in (purchase, adjustment +). */
  from_location: StockLocation | null
  /** null: stock going out (charge, adjustment −). */
  to_location: StockLocation | null
  reason: ChargeReason | null
  note: string
  /** Purchase: unit price; charge: last purchase price when it was recorded (null if never bought). */
  unit_cost: number | null
  /** Purchase: the supplier invoice it came from. */
  invoice_id?: string | null
  /** Demo mode only: a purchase whose invoice was cancelled no longer gives the last purchase price. */
  voided?: boolean
  /** Adjustment: the inventaire physique it came from. */
  inventory_id?: string | null
  /** Consumption: the paid order it came from. */
  order_id?: string | null
  /** Signed-in employee. */
  user_name: string
  created_at: string
}

/** An item and the quantity moved, in a transfer or a charge. */
export interface MovementLine {
  stock_item_id: string
  quantity: number
}

/** History filters; dates are YYYY-MM-DD (local days, both included). */
export interface MovementFilter {
  from?: string
  to?: string
  stock_item_id?: string
  reason?: ChargeReason
}
export type StockItemPatch = Partial<Pick<StockItem, 'name' | 'unit' | 'min_quantity' | 'purchase_unit' | 'purchase_factor'>>

/** État du stock: an item with its last purchase (price and supplier) and every supplier it was bought from. */
export interface StockStateRow extends StockItem {
  last_price: number | null
  last_supplier_id: string | null
  last_supplier_name: string | null
  suppliers: { id: string; name: string }[]
}

/**
 * Mouvements par période, for one item over [from, to[: quantities at the start and at the end of the period (Dépôt and
 * Cuisine), and what moved in between. initial + purchases − charges − consumption + adjustments = final (Dépôt + Cuisine).
 */
export interface StockReportRow {
  id: string
  name: string
  unit: string
  initial_depot: number
  initial_kitchen: number
  /** Entrées (achats), at the Dépôt. */
  purchases: number
  /** Dépôt → Cuisine. */
  transfers: number
  /** Cuisine → Dépôt. */
  returns: number
  /** Sorties (charges cuisine). */
  charges: number
  /** Consommation (ventes): what the paid orders took from the Cuisine through the fiches techniques. */
  consumption: number
  /** Ajustements ± and inventory gaps, signed. */
  adjustments: number
  final_depot: number
  final_kitchen: number
  /** Annulations d'achat and retours fournisseur (stock going back out). 0 before migration 20261001000000. */
  supplier_out: number
}

/** One count of an inventaire physique: what was counted for an item at one place. */
export interface InventoryCount {
  stock_item_id: string
  location: StockLocation
  counted: number
  /** Theoretical quantity shown while counting: the database refuses the inventory if the stock moved since. */
  expected: number
}

/** An inventaire physique (history). gap_value: the valued gaps (lines without a purchase price not counted). */
export interface StockInventory {
  id: string
  note: string
  line_count: number
  gap_value: number
  user_name: string
  created_at: string
}

export interface StockInventoryLine {
  id: string
  inventory_id: string
  stock_item_id: string | null
  item_name: string
  unit: string
  location: StockLocation
  theoretical: number
  counted: number
  /** counted − theoretical. */
  gap: number
  unit_cost: number | null
}

export interface Supplier {
  id: string
  name: string
  phone: string
  /** Products supplied, free text. */
  products: string
}

export type NewSupplier = Omit<Supplier, 'id'>

/** Payment state of a supplier invoice, from what was paid on it. */
export type SupplierPaymentStatus = 'unpaid' | 'partial' | 'paid'
export const SUPPLIER_PAYMENT_STATUSES: SupplierPaymentStatus[] = ['unpaid', 'partial', 'paid']

/** A purchase from a supplier (menu Gestion du Stock > Factures fournisseurs). */
export interface SupplierInvoice {
  id: string
  /** null when the supplier was deleted since; supplier_name keeps its name. */
  supplier_id: string | null
  supplier_name: string
  /** Day of the purchase, YYYY-MM-DD. */
  date: string
  total_amount: number
  paid_amount: number
  payment_status: SupplierPaymentStatus
  created_at: string
  /** N° 1, 2, 3… (migration 20261001000000_supplier_invoice_cancel.sql; absent before it). */
  number?: number
  /** Annulée: kept, never deleted. */
  status?: SupplierInvoiceStatus
  cancel_reason?: string | null
  cancelled_at?: string | null
  cancelled_by_name?: string | null
  /** Cash given back to the drawer by the cancellation (Fond d'entrée automatique). */
  cancel_cash_refund?: number
  /** Corrected invoice: this one replaces the cancelled one. */
  replaces_invoice_id?: string | null
  replaced_by_invoice_id?: string | null
  /** Retours fournisseur (avoirs): deducted from what is left to pay. */
  returned_amount?: number
}

export type SupplierInvoiceStatus = 'active' | 'cancelled'

/** Retour fournisseur (avoir): part of an invoice's items sent back; its amount is deducted from what is left to pay. */
export interface SupplierReturn {
  id: string
  invoice_id: string
  date: string
  reason: string
  amount: number
  user_name: string
  created_at: string
  items: SupplierReturnItem[]
}

export interface SupplierReturnItem {
  id: string
  invoice_item_id: string | null
  item_name: string
  /** In the invoice line's unit. */
  quantity: number
  unit: string
  unit_price: number
}

/** One line of a supplier invoice: its quantity was added to the stock item. */
export interface SupplierInvoiceItem {
  id: string
  invoice_id: string
  /** null when the stock item was deleted since; item_name keeps its name. */
  stock_item_id: string | null
  item_name: string
  quantity: number
  unit: string
  unit_price: number
  /** Stock units per invoice unit: 6 when bought by the fardeau of 6 bouteilles, 1 otherwise. */
  factor: number
  /** Already sent back to the supplier (retours), in the line's unit. */
  returned_quantity?: number
}

/** A payment (full or partial) of a supplier invoice. */
export interface SupplierPayment {
  id: string
  invoice_id: string
  amount: number
  /** YYYY-MM-DD */
  date: string
  created_at: string
}

// ───────────── Fiches techniques ─────────────

/**
 * One ingredient of a fiche technique: quantity per portion, in the stock item's unit. option_id null: the item's own
 * fiche (every size); otherwise the fiche of one size or supplement, added to it. input_unit / input_quantity keep what
 * was typed (50 g for a stock in kg).
 */
export interface RecipeLine {
  id: string
  item_id: string
  option_id: string | null
  stock_item_id: string
  quantity: number
  input_unit: string
  input_quantity: number | null
  position: number
}

/** What the fiche technique screen sends for one item: every line of its base, sizes and supplements. */
export type RecipeLineInput = Pick<RecipeLine, 'option_id' | 'stock_item_id' | 'quantity' | 'input_unit' | 'input_quantity'>

/** An ingredient offered in the fiches techniques, with its last purchase price per stock unit (null: never bought). */
export interface RecipeStockItem {
  id: string
  name: string
  unit: string
  purchase_unit: string
  purchase_factor: number | null
  last_price: number | null
}

/**
 * Consommation théorique vs réelle, for one item over a period: what the sales took (theoretical), the declared charges,
 * the inventory gaps (counted − theoretical, signed) and the real consumption = theoretical + charges − inventory_gap.
 */
export interface ConsumptionRow {
  id: string
  name: string
  unit: string
  theoretical: number
  charges: number
  inventory_gap: number
  actual: number
  last_price: number | null
}

/** Effectuer un achat: what the form sends. */
export interface NewPurchase {
  supplier_id: string
  date: string
  lines: { stock_item_id: string; quantity: number; unit: string; unit_price: number }[]
  /** Paid at purchase: 0 (Non payé), the total (Payé) or in between (Partiellement payé). */
  paid: number
}

/** An account that signs in to the app. There are no roles yet: every account is staff. */
export interface StaffAccount {
  id: string
  email: string
  created_at: string | null
  last_sign_in_at: string | null
}

/** Admin: everything. Employé (server, cashier): the service screen only. */
export type UserRole = 'admin' | 'employe'
export const USER_ROLES: UserRole[] = ['admin', 'employe']

/** A user of the app (page Utilisateurs): the name used to sign in, the name shown, the role. */
export interface AppUser {
  id: string
  username: string
  display_name: string
  /** Null: an account created outside the app (Supabase dashboard) that has no profile yet. */
  role: UserRole | null
  active: boolean
  email: string | null
  created_at: string | null
  last_sign_in_at: string | null
}

/** A new user (no id) or changes to one. An empty password keeps the current one. */
export interface UserInput {
  id?: string
  username: string
  display_name: string
  role: UserRole
  password: string
  active: boolean
}

/** One export of the database (page Sauvegarder la base de données). */
export interface BackupLogEntry {
  id: string
  created_at: string
  user_label: string
  format: 'json' | 'csv'
  tables: string[]
  row_count: number
  size_bytes: number
}

export const RESERVATION_STATUSES = ['confirmed', 'cancelled', 'honored', 'no_show'] as const
/** Confirmée, Annulée, Honorée (the customer came: their table's order was opened), No-show. */
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number]

/** A table booking (menu Clients). The hall is always set; the table only when the customer chose one. */
export interface Reservation {
  id: string
  client_name: string
  phone: string
  party_size: number
  hall_id: string | null
  table_id: string | null
  /** ISO date and time of the booking. */
  reserved_at: string
  status: ReservationStatus
  note: string
  /** Order opened when the booking was marked Honorée (null before, or after that order was deleted). */
  order_id?: string | null
  created_at: string
}

export type NewReservation = Pick<Reservation, 'client_name' | 'phone' | 'party_size' | 'hall_id' | 'table_id' | 'reserved_at' | 'note'>
export type ReservationPatch = Partial<NewReservation> & { status?: ReservationStatus }

/** One employee on the Salaires et acomptes page, for one month (amounts in DA). */
export interface PayrollRow {
  user_id: string
  username: string
  display_name: string
  role: UserRole | null
  active: boolean
  monthly_salary: number
  /** Sum of the advances dated in the month. */
  advances: number
  advances_count: number
  /** monthly_salary − advances (negative when more was advanced than the salary). */
  remaining: number
}

/** An acompte: money paid to an employee ahead of their salary. */
export interface SalaryAdvance {
  id: string
  user_id: string
  amount: number
  /** Day it was paid, YYYY-MM-DD. */
  date: string
  note: string | null
  created_at: string
}

export type NewSalaryAdvance = Pick<SalaryAdvance, 'user_id' | 'amount' | 'date' | 'note'>

/** A tablet or PC that uses the app (page Appareils connectés): its last account and last activity. */
export interface DeviceSession {
  id: string
  user_id: string
  username: string
  display_name: string
  /** Name typed on the login screen ("Tablette Caisse"); null when none was given. */
  device_name: string | null
  user_agent: string | null
  started_at: string
  last_seen_at: string
  /** Set by Déconnexion. */
  ended_at: string | null
  /** Seconds since the last signal, measured by the database. */
  idle_seconds: number
}

// ───────────── Caisse et Statistique Journalier (migration 20260930110000_cash_register.sql) ─────────────

/** Fond d'entrée (in) or Fond de sortie (out). */
export type CashMovementKind = 'in' | 'out'

/** Money put in or taken out of the drawer outside sales, during an open working day. */
export interface CashMovement {
  id: string
  day_id: string
  kind: CashMovementKind
  amount: number
  reason: string
  /** Supplier invoice this Fond de sortie paid (null otherwise, or once the invoice is deleted). */
  supplier_invoice_id: string | null
  supplier_name: string | null
  user_name: string
  created_at: string
}

export interface NewCashMovement {
  kind: CashMovementKind
  amount: number
  reason: string
  supplier_invoice_id?: string | null
  /** Fond de sortie that is also a general expense of this category (Liste des dépenses). */
  expense_category_id?: string | null
}

/**
 * A working day (journée de travail), from the Fond de caisse to the closing. Its sales are everything paid since the
 * previous closing (period_start), so a sale made before the drawer was opened still counts.
 */
export interface CashDay {
  id: string
  /** Journée n°, increasing. */
  day_no: number
  period_start: string
  opened_at: string
  opened_by_name: string
  /** Fond de caisse: cash in the drawer at opening. */
  opening_float: number
  float_updated_at: string | null
  float_updated_by_name: string | null
  closed_at: string | null
  closed_by_name: string | null
  /** Fixed at closing (null while open). */
  cash_sales: number | null
  cash_in: number | null
  cash_out: number | null
  expected_cash: number | null
  counted_cash: number | null
  /** Counted − expected: negative when cash is missing. */
  difference: number | null
  /** The day's figures when it was closed (rapport Z). */
  report: DayReport | null
  note: string
}

/** A reset of the order / ticket numbers to 1 (Re-Initialiser le N°, or automatically at the opening of a day). */
export interface NumberReset {
  id: string
  reason: 'manual' | 'day_open'
  last_ticket_no: number | null
  last_takeaway_no: number | null
  last_delivery_no: number | null
  user_name: string
  created_at: string
}

/** One row of "ventes par article / catégorie / employé". Amounts are what customers paid (discounts shared out). */
export interface SalesRow {
  name: string
  /** Item's category (items only). */
  category?: string
  quantity: number
  /** Orders (employees only). */
  orders?: number
  amount: number
}

/** Espèces attendues = fond de caisse + ventes espèces + fonds d'entrée − fonds de sortie. */
export interface CashSummary {
  opening: number
  sales: number
  in: number
  out: number
  expected: number
}

/** Figures of a working day (Statistique Journalier, rapport Z). All amounts in DA. */
export interface DayReport {
  from: string
  /** End of the period; now for the day in progress. */
  to: string
  /** Normal price of everything sold (before discounts and offers). */
  gross: number
  discounts: number
  offered: number
  /** Delivery fees charged. */
  delivery: number
  /** What customers paid: gross − discounts − offered + delivery. */
  net: number
  orders: number
  avgTicket: number
  /** Orders not paid yet when the report was made. */
  openOrders: number
  /** Paid during the period, by method (partial payments of orders still open included). */
  payments: Record<string, number>
  byType: Record<OrderType, { orders: number; amount: number }>
  items: SalesRow[]
  categories: SalesRow[]
  employees: SalesRow[]
  cash: CashSummary | null
  /**
   * Sales paid while the drawer was closed (before this day was opened), counted in this day. Reports made before
   * this was recorded have none.
   */
  closedSales?: ClosedSales | null
  /** Tickets paid then cancelled (Factures annulées) during the period: count, their total, cash given back. */
  voids?: { orders: number; amount: number; cash: number } | null
}

export interface ClosedSales {
  orders: number
  /** What those orders brought in. */
  amount: number
  /** Part paid in cash (in the expected cash of the day). */
  cash: number
}

/** Raw sales of a period, from which reports are computed. */
export interface SalesData {
  /** Orders paid (closed) during the period. */
  orders: (Order & { total: number | null; closed_at: string | null })[]
  lines: OrderLine[]
  /** Payments made during the period. */
  payments: Payment[]
  openOrders: number
  /** Tickets paid then cancelled during the period (their cash part left the drawer). */
  voids?: (Order & { cancelled_at: string | null })[]
}

// ───────────── Dépenses, Bénéfice (migration 20260930120000_expenses_profit.sql) ─────────────

export interface ExpenseCategory {
  id: string
  name: string
  sort_order: number
  active: boolean
}

/** Espèces caisse (a Fond de sortie of the open day) or Autre (bank, card…). */
export type ExpenseMode = 'cash' | 'other'

/** A general expense (loyer, électricité…). */
export interface Expense {
  id: string
  category_id: string | null
  /** Name of the category when saved; kept after the category is deleted. */
  category_name: string
  amount: number
  /** Day of the expense, YYYY-MM-DD. */
  date: string
  mode: ExpenseMode
  note: string
  /** The Fond de sortie that paid it (mode cash), shown only once. */
  cash_movement_id: string | null
  user_name: string
  created_at: string
}

export interface NewExpense {
  category_id: string
  amount: number
  date: string
  mode: ExpenseMode
  note: string
}

/** Costs of a period that do not come from the sales (page Bénéfice). */
export interface ProfitCosts {
  /** Charges cuisine déclarées (pertes, casse, repas personnel…), at their cost. */
  charges: number
  charges_by_reason: Record<string, number>
  /** Écarts d'inventaire négatifs, at their cost. */
  inventory_loss: number
  /** Monthly salaries prorated to the elapsed days of the period (up to today included). */
  salaries: number
  /** Days counted for the salaries (elapsed), out of the days of the period; absent before migration 20260930160000. */
  salary_days?: number
  period_days?: number
  expenses: number
  expenses_by_category: Record<string, number>
}

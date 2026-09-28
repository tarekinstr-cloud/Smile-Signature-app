export type TableStatus = 'free' | 'occupied'
export type TableShape = 'square' | 'round' | 'rect'

export interface Hall {
  id: string
  name: string
  width: number
  height: number
  sort_order: number
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

export interface Order {
  id: string
  table_id: string | null
  status: OrderStatus
  note: string | null
  created_at: string
}

/** Snapshot of a chosen option, copied onto the order line. */
export interface ChosenOption {
  group: string
  name: string
  price_delta: number
}

export interface OrderLine {
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
}

export type NewOrderLine = Pick<OrderLine, 'item_id' | 'name' | 'unit_price' | 'quantity' | 'options' | 'note'>
export type OrderLinePatch = Partial<Pick<OrderLine, 'quantity' | 'note' | 'options' | 'unit_price'>>

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

export type PaymentMethod = 'cash' | 'card'

/** An order after checkout: what the receipt prints. */
export interface PaidOrder extends Order {
  /** Sequential receipt number, assigned at checkout. */
  ticket_no: number
  total: number
  payment_method: PaymentMethod
  /** Cash handed over by the customer (equals the total for card payments). */
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

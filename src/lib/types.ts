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
}

export type NewOrderLine = Pick<OrderLine, 'item_id' | 'name' | 'unit_price' | 'quantity' | 'options' | 'note'>
export type OrderLinePatch = Partial<Pick<OrderLine, 'quantity' | 'note'>>

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

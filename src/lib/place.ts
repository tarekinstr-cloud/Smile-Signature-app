import type { DiningTable, Order } from './types'
import { tr } from './i18n'

type Strings = ReturnType<typeof tr>

/**
 * Kitchen tickets keep the place as text (table_label). A takeaway order is stored as "EMP-<n>" so the ticket
 * can still say "À emporter n° 12" in the language it is printed in.
 */
const TAKEAWAY = 'EMP-'

/** What goes in a kitchen ticket's table_label for this order. */
export function ticketPlace(order: Pick<Order, 'order_type' | 'takeaway_no'>, table: Pick<DiningTable, 'label'> | null): string | null {
  if (order.order_type === 'takeaway') return TAKEAWAY + (order.takeaway_no ?? '')
  return table?.label ?? null
}

/** "Table 4" or "À emporter n° 12", from a stored ticket label. */
export function placeFromLabel(t: Strings, label: string): string {
  return label.startsWith(TAKEAWAY) ? t.takeawayNo(label.slice(TAKEAWAY.length)) : t.table(label)
}

/** "Table 4" or "À emporter n° 12" for an order and its current table. */
export function placeText(t: Strings, order: Pick<Order, 'order_type' | 'takeaway_no'> | null, table: Pick<DiningTable, 'label'> | null): string {
  if (order?.order_type === 'takeaway' || !table) return order?.takeaway_no ? t.takeawayNo(String(order.takeaway_no)) : t.takeaway
  return t.table(table.label)
}

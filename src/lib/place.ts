import type { DiningTable, Order } from './types'
import { tr } from './i18n'

type Strings = ReturnType<typeof tr>

/**
 * Kitchen tickets keep the place as text (table_label). A takeaway order is stored as "EMP-<n>" and a delivery as
 * "LIV-<n>" so the ticket can still say "À emporter n° 12" / "Livraison n° 3" in the language it is printed in.
 * A delivery label also carries the customer on the following lines (name · phone, then the address), and a takeaway
 * label the customer's name, so the ticket keeps them as they were when it was sent.
 */
const TAKEAWAY = 'EMP-'
const DELIVERY = 'LIV-'

type PlaceOrder = Pick<Order, 'order_type' | 'takeaway_no'> & Partial<Pick<Order, 'delivery_no' | 'customer_name' | 'customer_phone' | 'customer_address'>>

/** "Nom · 0550 12 34 56" of a delivery's customer, or null when neither is known. */
export function deliveryContact(order: Partial<Pick<Order, 'customer_name' | 'customer_phone'>>): string | null {
  return [order.customer_name, order.customer_phone].filter(Boolean).join(' · ') || null
}

/** What goes in a kitchen ticket's table_label for this order. */
export function ticketPlace(order: PlaceOrder, table: Pick<DiningTable, 'label'> | null): string | null {
  // The customer's name (optional) goes under the number, so the kitchen can call it out too.
  if (order.order_type === 'takeaway') return [TAKEAWAY + (order.takeaway_no ?? ''), order.customer_name?.trim()].filter(Boolean).join('\n')
  if (order.order_type === 'delivery') {
    return [DELIVERY + (order.delivery_no ?? ''), deliveryContact(order), order.customer_address].filter(Boolean).join('\n')
  }
  return table?.label ?? null
}

/** Splits a stored ticket label into the place ("Table 4", "Livraison n° 3") and the delivery details under it. */
export function ticketLabelParts(t: Strings, label: string): { place: string; details: string[]; delivery: boolean } {
  const [first, ...details] = label.split('\n')
  if (first.startsWith(DELIVERY)) return { place: t.deliveryNo(first.slice(DELIVERY.length)), details, delivery: true }
  if (first.startsWith(TAKEAWAY)) return { place: t.takeawayNo(first.slice(TAKEAWAY.length)), details, delivery: false }
  return { place: t.table(first), details, delivery: false }
}

/** "Table 4", "À emporter n° 12" or "Livraison n° 3" for an order and its current table. */
export function placeText(t: Strings, order: PlaceOrder | null, table: Pick<DiningTable, 'label'> | null): string {
  if (order?.order_type === 'delivery') return order.delivery_no ? t.deliveryNo(String(order.delivery_no)) : t.delivery
  if (order?.order_type === 'takeaway' || !table) return order?.takeaway_no ? t.takeawayNo(String(order.takeaway_no)) : t.takeaway
  return t.table(table.label)
}

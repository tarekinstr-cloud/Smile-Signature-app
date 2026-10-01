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

type PlaceOrder = Pick<Order, 'order_type' | 'takeaway_no'> & Partial<Pick<Order, 'delivery_no' | 'customer_name' | 'customer_phone' | 'customer_address' | 'guests' | 'pager_no'>>

/** Number of people on a kitchen ticket line, translated when the ticket is shown (« 3 personnes »). */
const GUESTS = 'PERS-'
const guestsLine = (order: PlaceOrder) => (order.guests ? GUESTS + order.guests : null)
/** Bipeur given to a takeaway customer (« Bipeur 4 »). */
const PAGER = 'BIP-'
/** Delivery without an address: « Adresse non précisée » for the driver. */
const NO_ADDRESS = 'ADR-NONE'

/** "Nom · 0550 12 34 56" of a delivery's customer, or null when neither is known. */
export function deliveryContact(order: Partial<Pick<Order, 'customer_name' | 'customer_phone'>>): string | null {
  return [order.customer_name, order.customer_phone].filter(Boolean).join(' · ') || null
}

/** What goes in a kitchen ticket's table_label for this order. */
export function ticketPlace(order: PlaceOrder, table: Pick<DiningTable, 'label'> | null): string | null {
  // The customer's name (optional) goes under the number, so the kitchen can call it out too.
  // The number of people (tables only) goes on its own line.
  if (order.order_type === 'takeaway') {
    return [TAKEAWAY + (order.takeaway_no ?? ''), order.pager_no ? PAGER + order.pager_no : null, order.customer_name?.trim()].filter(Boolean).join('\n')
  }
  if (order.order_type === 'delivery') {
    return [DELIVERY + (order.delivery_no ?? ''), deliveryContact(order), order.customer_address?.trim() || NO_ADDRESS].filter(Boolean).join('\n')
  }
  return table ? [table.label, guestsLine(order)].filter(Boolean).join('\n') : null
}

/** Splits a stored ticket label into the place ("Table 4", "Livraison n° 3") and the delivery details under it. */
export function ticketLabelParts(t: Strings, label: string): { place: string; details: string[]; delivery: boolean } {
  const [first, ...rest] = label.split('\n')
  const details = rest.map((line) => (line.startsWith(GUESTS) ? t.peopleCount(Number(line.slice(GUESTS.length)))
    : line.startsWith(PAGER) ? t.pagerShort(line.slice(PAGER.length)) : line === NO_ADDRESS ? t.addressNone : line))
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

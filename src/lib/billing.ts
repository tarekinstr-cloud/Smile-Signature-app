import type { Adjustments, Discount, OrderLine, Payment, PaymentMethod } from './types'

/**
 * Payment methods offered at the cashier, in button order. `cash` takes the amount handed over and gives change back.
 * To add a mode (e.g. cheque): add it to PaymentMethod (types.ts), here, and a label in i18n (payMethod).
 */
/** Icon of a payment mode on the checkout buttons. */
export function methodIcon(code: PaymentMethod): string {
  return code === 'cash' ? '💵' : code === 'baridimob' ? '📱' : code === 'cheque' ? '🧾' : '💳'
}

const cents = (n: number) => Math.round(n * 100) / 100

/**
 * DA amount of a discount on `base`. Percentages round to the whole dinar; a fixed amount never exceeds the base.
 * Must match public.discount_amount() in the checkout migration.
 */
export function discountAmount(base: number, d: Pick<Adjustments, 'discount_type' | 'discount_value'>): number {
  if (!d.discount_type || !(d.discount_value > 0) || base <= 0) return 0
  const raw = d.discount_type === 'percent' ? Math.round((base * Math.min(d.discount_value, 100)) / 100) : d.discount_value
  return cents(Math.min(raw, base))
}

export interface BilledLine {
  line: OrderLine
  /** Price before discount and offer: unit price × quantity. */
  gross: number
  discount: number
  /** Offered on its own or with the whole order. */
  offered: boolean
  /** What the customer pays for this line. */
  net: number
}

export interface Bill {
  lines: BilledLine[]
  /** Sum of the lines' normal prices. */
  gross: number
  /** Value of what is offered (lines or whole order). */
  offered: number
  /** Discounts on single lines. */
  lineDiscounts: number
  /** Sum of the lines after their own discounts and offers. */
  subtotal: number
  /** Discount on the whole order. */
  orderDiscount: number
  /** Delivery fee of the order's zone (0 while the order is empty or entirely offered). */
  delivery: number
  total: number
  paid: number
  /** Left to pay; 0 once the order is settled. */
  remaining: number
}

/**
 * Totals of an order: lines, discounts, offers, delivery fee and payments. Must match public.order_total() (latest
 * version: migration 20260930030000_delivery_zones.sql).
 */
export function computeBill(order: (Adjustments & { delivery_fee?: number }) | null, lines: OrderLine[], payments: Pick<Payment, 'amount'>[] = []): Bill {
  const allOffered = !!order?.offered
  const billed = lines.map((line): BilledLine => {
    const gross = cents(line.unit_price * line.quantity)
    const offered = allOffered || line.offered
    const discount = offered ? 0 : discountAmount(gross, line)
    return { line, gross, discount, offered, net: offered ? 0 : cents(gross - discount) }
  })
  const sum = (f: (l: BilledLine) => number) => cents(billed.reduce((s, l) => s + f(l), 0))
  const subtotal = sum((l) => l.net)
  const orderDiscount = allOffered || !order ? 0 : discountAmount(subtotal, order)
  // Added after the order discount, which applies to the food only.
  const delivery = allOffered || !lines.length ? 0 : cents(Number(order?.delivery_fee ?? 0))
  const total = cents(subtotal - orderDiscount + delivery)
  const paid = cents(payments.reduce((s, p) => s + p.amount, 0))
  return {
    lines: billed,
    gross: sum((l) => l.gross),
    offered: sum((l) => (l.offered ? l.gross : 0)),
    lineDiscounts: sum((l) => l.discount),
    subtotal,
    orderDiscount,
    delivery,
    total,
    paid,
    remaining: Math.max(0, cents(total - paid)),
  }
}

export const discountOf = (a: Adjustments): Discount | null =>
  a.discount_type && a.discount_value > 0 ? { type: a.discount_type, value: a.discount_value } : null

/** Adjustments of a line or order that has none, e.g. rows saved before discounts existed. */
export const noAdjustments = (): Adjustments => ({ discount_type: null, discount_value: 0, offered: false })

/** Fills in missing or string-typed adjustment fields (rows from Supabase numeric columns, or old demo data). */
export function normalizeAdjustments<T extends Partial<Adjustments>>(row: T): T & Adjustments {
  return {
    ...row,
    discount_type: row.discount_type ?? null,
    discount_value: Number(row.discount_value ?? 0),
    offered: !!row.offered,
  }
}

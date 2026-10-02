import { newId } from './id'
import type { Customer, CustomerSettlement } from './types'
import { nowIso } from './tz'

/**
 * Demo mode: the customers and their settlements in the browser (key smile.customers.v1). Kept apart from customers.ts so
 * the demo order store (repo.ts) can link a delivery to its customer without importing the service.
 */
export const CUSTOMERS_KEY = 'smile.customers.v1'

export interface LocalSettlementItem {
  settlement_id: string
  order_id: string
  amount: number
}

export interface LocalCustomersDb {
  customers: Customer[]
  settlements: (CustomerSettlement & { items: LocalSettlementItem[] })[]
}

/** Digits of a phone number: « 0550 12 34 56 » and « 0550123456 » are the same customer. */
export const phoneKey = (phone: string | null | undefined) => (phone ?? '').replace(/\D/g, '')

const listeners = new Set<() => void>()

export function loadCustomers(): LocalCustomersDb {
  try {
    const saved = JSON.parse(localStorage.getItem(CUSTOMERS_KEY) ?? 'null') as Partial<LocalCustomersDb> | null
    return { customers: saved?.customers ?? [], settlements: saved?.settlements ?? [] }
  } catch {
    return { customers: [], settlements: [] }
  }
}

export function saveCustomers(db: LocalCustomersDb) {
  try {
    localStorage.setItem(CUSTOMERS_KEY, JSON.stringify(db))
  } catch {
    // Storage full or blocked: kept until the page is reloaded.
  }
  listeners.forEach((l) => l())
}

export function onLocalCustomers(fn: () => void): () => void {
  listeners.add(fn)
  const storage = (e: StorageEvent) => e.key === CUSTOMERS_KEY && fn()
  window.addEventListener('storage', storage)
  return () => {
    listeners.delete(fn)
    window.removeEventListener('storage', storage)
  }
}

/**
 * Like the orders_link_customer trigger: the customer of a delivery is found by phone, or created, and blank fields of
 * the card (address, zone) are filled. Returns the customer's id, or null without a phone.
 */
export function linkLocalDeliveryCustomer(o: { customer_name: string | null; customer_phone: string | null; customer_address: string | null; delivery_zone_id?: string | null }): string | null {
  const key = phoneKey(o.customer_phone)
  if (!key) return null
  const db = loadCustomers()
  const found = db.customers.find((c) => phoneKey(c.phone) === key)
  if (found) {
    if (!found.address || !found.zone_id) {
      found.address ||= (o.customer_address ?? '').trim()
      found.zone_id ??= o.delivery_zone_id ?? null
      saveCustomers(db)
    }
    return found.id
  }
  const c: Customer = {
    id: newId(), name: (o.customer_name?.trim() || o.customer_phone!.trim()).slice(0, 80), phone: o.customer_phone!.trim().slice(0, 30),
    address: (o.customer_address ?? '').trim().slice(0, 300), zone_id: o.delivery_zone_id ?? null, note: '', credit_limit: null,
    active: true, created_at: nowIso(),
  }
  db.customers.push(c)
  saveCustomers(db)
  return c.id
}

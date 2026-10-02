import type { SupabaseClient } from '@supabase/supabase-js'
import { CashClosedError, checkoutError, localCan, normalizeLine, normalizeOrder, normalizePaid, repo, sharedChannel, supabase } from './repo'
import { tr } from './i18n'
import { amount as amountText } from './format'
import { cash } from './cash'
import { admin } from './admin'
import { newId } from './id'
import { loadCustomers, onLocalCustomers, phoneKey, saveCustomers } from './customerStore'
import type {
  Customer, CustomerBalance, CustomerHistory, CustomerInvoice, CustomerPatch, CustomerSettlement, InvoiceRow, NewCustomer, Order,
  OrderLine, PaidOrder, Payment,
} from './types'

/**
 * Menu Clients: customer cards, sales on a customer's account (crédit), their settlement, and the list of every invoice.
 * Supabase (migration 20261009000000_customers_credit.sql), or localStorage in demo mode, like `repo`.
 */
export interface CustomersService {
  /** Every customer, by name (deactivated ones included). */
  list(): Promise<Customer[]>
  create(c: NewCustomer): Promise<Customer>
  update(id: string, patch: CustomerPatch): Promise<void>
  /** Fiche client: orders, total spent, visits, favourite items, what is owed. */
  history(customerId: string): Promise<CustomerHistory>
  /** Credit invoices not fully settled, oldest first (one customer, or all). */
  unpaid(customerId?: string): Promise<CustomerInvoice[]>
  /** Customers who owe money (Factures Clients non réglées), biggest debt first. */
  balances(): Promise<CustomerBalance[]>
  /**
   * Compte client (crédit): puts all or part of an open order on the customer's account. Returns the order once nothing is
   * left to pay (closed like any paid order), null after a partial amount. Refused above the credit limit (except Admin).
   */
  payOnCredit(orderId: string, customerId: string, amount: number): Promise<PaidOrder | null>
  /**
   * Règlement: spreads the amount over the customer's unpaid invoices (the chosen ones, or all), oldest first. In cash it
   * needs an open working day and enters the expected cash (Fond d'entrée « Règlement crédit client »).
   */
  settle(customerId: string, amount: number, method: string, orderIds?: string[], note?: string): Promise<CustomerSettlement>
  /** Settlements received during [from, to). */
  settlements(from: Date, to: Date): Promise<CustomerSettlement[]>
  /** Toutes les Factures: orders paid or cancelled during [from, to), newest first. */
  invoices(from: Date, to: Date): Promise<InvoiceRow[]>
  /** One order with its lines and payments (ticket preview). */
  invoiceDetail(orderId: string): Promise<{ order: PaidOrder; lines: OrderLine[]; payments: Payment[] }>
  subscribe(onChange: () => void): () => void
}

const da = (n: number) => Math.round(n)

const normCustomer = (c: Customer): Customer => ({
  ...c, phone: c.phone ?? '', address: c.address ?? '', note: c.note ?? '', zone_id: c.zone_id ?? null,
  credit_limit: c.credit_limit == null ? null : Number(c.credit_limit), active: c.active !== false,
})

const byName = (a: Customer, b: Customer) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })

/** Checks and trims a customer card before it is saved. */
export function cleanCustomer<T extends Partial<NewCustomer>>(c: T): T {
  const t = tr()
  const out = { ...c }
  if (c.name !== undefined) {
    out.name = c.name.trim().slice(0, 80)
    if (!out.name) throw new Error(t.errCustomerName)
  }
  if (c.phone !== undefined) {
    out.phone = c.phone.trim().slice(0, 30)
    if (out.phone && phoneKey(out.phone).length < 6) throw new Error(t.errCustomerPhone)
  }
  if (c.address !== undefined) out.address = c.address.trim().slice(0, 300)
  if (c.note !== undefined) out.note = c.note.trim().slice(0, 300)
  if (c.credit_limit !== undefined && c.credit_limit !== null) {
    if (!(Number.isFinite(c.credit_limit) && c.credit_limit >= 0)) throw new Error(t.errCreditLimitValue)
    out.credit_limit = da(c.credit_limit)
  }
  return out
}

/** Customers matching a name or phone search (digits compared without spaces), active first. */
export function searchCustomers(list: Customer[], q: string): Customer[] {
  const text = q.trim().toLowerCase()
  const digits = phoneKey(q)
  if (!text) return list
  return list.filter((c) => c.name.toLowerCase().includes(text) || (digits.length >= 2 && phoneKey(c.phone).includes(digits)))
}

function customersError(message: string): Error {
  const t = tr()
  if (/customers|customer_invoices|customer_settlement|pay_on_credit|settle_customer|customer_id/.test(message)
    && /does not exist|schema cache|Could not find/i.test(message)) return new Error(t.errMigrationCustomers)
  const limit = /credit_limit:([\d.]+)/.exec(message)
  if (limit) return new Error(t.errCreditLimit(`${amountText(Number(limit[1]))} ${t.currency}`))
  const tooMuch = /settle_too_much:([\d.]+)/.exec(message)
  if (tooMuch) return new Error(t.errSettleTooMuch(`${amountText(Number(tooMuch[1]))} ${t.currency}`))
  if (message.includes('nothing_due')) return new Error(t.errNothingDue)
  if (message.includes('customer_not_found')) return new Error(t.errCustomerGone)
  if (/customers_phone_key|duplicate key/.test(message)) return new Error(t.errCustomerPhoneTaken)
  if (message.includes('no_open_day')) return new CashClosedError(t.errSettleNeedsDay)
  if (message.includes('payment_mode_inactive')) return new Error(t.errPayModeInactive)
  if (/permission_denied|row-level security|permission denied/i.test(message)) return new Error(t.errNoPermission)
  return checkoutError(message)
}

/** Fiche client figures from the customer's paid orders and their lines. */
function buildHistory(orders: CustomerHistory['orders'], lines: OrderLine[], due: number, settlements: CustomerSettlement[]): CustomerHistory {
  const items = new Map<string, number>()
  for (const l of lines) items.set(l.name, (items.get(l.name) ?? 0) + l.quantity)
  const sorted = [...orders].sort((a, b) => b.closed_at.localeCompare(a.closed_at))
  return {
    orders: sorted,
    spent: da(sorted.reduce((s, o) => s + o.total, 0)),
    visits: sorted.length,
    last: sorted[0]?.closed_at ?? null,
    topItems: [...items.entries()].map(([name, quantity]) => ({ name, quantity })).sort((a, b) => b.quantity - a.quantity).slice(0, 5),
    due: da(due),
    settlements,
  }
}

function groupBalances(customers: Customer[], invoices: CustomerInvoice[]): CustomerBalance[] {
  const by = new Map<string, CustomerBalance>()
  for (const i of invoices) {
    if (i.due <= 0) continue
    const c = customers.find((x) => x.id === i.customer_id)
    if (!c) continue
    const b = by.get(c.id) ?? { customer: c, invoices: 0, due: 0, oldest: i.closed_at }
    b.invoices++
    b.due = da(b.due + i.due)
    if (i.closed_at < b.oldest) b.oldest = i.closed_at
    by.set(c.id, b)
  }
  return [...by.values()].sort((a, b) => b.due - a.due)
}

function invoiceRow(order: InvoiceRow['order'], payments: Payment[], due: number, customer: string): InvoiceRow {
  const mine = payments.filter((p) => p.order_id === order.id)
  const status = order.status === 'cancelled' ? 'cancelled' : due > 0 ? 'credit' : 'paid'
  return {
    order, status, customer, due: da(due), methods: [...new Set(mine.map((p) => p.method))],
    amount: da(order.status === 'cancelled' ? order.cancelled_total ?? 0 : order.total ?? 0),
    at: (order.status === 'cancelled' ? order.cancelled_at : order.closed_at) ?? order.created_at,
  }
}

const normInvoice = (i: CustomerInvoice): CustomerInvoice => ({
  ...i, ticket_no: i.ticket_no == null ? null : Number(i.ticket_no), total: Number(i.total), credit: Number(i.credit),
  settled: Number(i.settled), due: Number(i.due),
})
const normSettlement = (s: CustomerSettlement): CustomerSettlement => ({ ...s, amount: Number(s.amount) })

function supabaseCustomers(sb: SupabaseClient): CustomersService {
  const check = <T>(res: { data: T; error: { message: string } | null }): T => {
    if (res.error) throw customersError(res.error.message)
    return res.data
  }
  const channel = sharedChannel(sb, 'customers', ['customers', 'customer_settlements'])
  const service: CustomersService = {
    async list() {
      return (check(await sb.from('customers').select('*')) as Customer[]).map(normCustomer).sort(byName)
    },
    async create(c) {
      return normCustomer(check(await sb.from('customers').insert(cleanCustomer(c)).select('*').single()) as Customer)
    },
    async update(id, patch) {
      check(await sb.from('customers').update({ ...cleanCustomer(patch), updated_at: new Date().toISOString() }).eq('id', id))
    },
    async history(customerId) {
      const orders = (check(await sb.from('orders').select('*').eq('customer_id', customerId).eq('status', 'paid')
        .order('closed_at', { ascending: false }).limit(1000)) as PaidOrder[]).map(normalizePaid)
      const lines = orders.length
        ? (check(await sb.from('order_items').select('*').in('order_id', orders.slice(0, 300).map((o) => o.id))) as OrderLine[]).map(normalizeLine)
        : []
      const [unpaid, settlements] = await Promise.all([
        service.unpaid(customerId),
        sb.from('customer_settlements').select('*').eq('customer_id', customerId).order('created_at', { ascending: false }).limit(200),
      ])
      return buildHistory(orders as CustomerHistory['orders'], lines, unpaid.reduce((s, i) => s + i.due, 0),
        settlements.error ? [] : (settlements.data as CustomerSettlement[]).map(normSettlement))
    },
    async unpaid(customerId) {
      let q = sb.from('customer_invoices').select('*').gt('due', 0)
      if (customerId) q = q.eq('customer_id', customerId)
      return (check(await q.order('closed_at')) as CustomerInvoice[]).map(normInvoice)
    },
    async balances() {
      const [customers, invoices] = await Promise.all([service.list(), service.unpaid()])
      return groupBalances(customers, invoices)
    },
    async payOnCredit(orderId, customerId, amount) {
      const res = await sb.rpc('pay_on_credit', { p_order_id: orderId, p_customer_id: customerId, p_amount: da(amount) })
      if (res.error) throw customersError(res.error.message)
      const o = res.data as PaidOrder
      return o.status === 'paid' ? normalizePaid(o) : null
    },
    async settle(customerId, amount, method, orderIds, note) {
      const res = await sb.rpc('settle_customer', {
        p_customer_id: customerId, p_amount: da(amount), p_method: method, p_order_ids: orderIds?.length ? orderIds : null, p_note: note ?? '',
      })
      if (res.error) throw customersError(res.error.message)
      return normSettlement(res.data as CustomerSettlement)
    },
    async settlements(from, to) {
      const res = await sb.from('customer_settlements').select('*').gte('created_at', from.toISOString()).lt('created_at', to.toISOString())
        .order('created_at')
      // Before the migration (or without the right): no settlements in the reports.
      if (res.error) return []
      return (res.data as CustomerSettlement[]).map(normSettlement)
    },
    async invoices(from, to) {
      const [f, u] = [from.toISOString(), to.toISOString()]
      const [paid, cancelled, customers] = await Promise.all([
        sb.from('orders').select('*').eq('status', 'paid').gte('closed_at', f).lt('closed_at', u).order('closed_at', { ascending: false }).limit(5000),
        sb.from('orders').select('*').eq('status', 'cancelled').gte('cancelled_at', f).lt('cancelled_at', u).limit(2000),
        sb.from('customers').select('id, name').then((r) => (r.error ? [] : (r.data as { id: string; name: string }[]))),
      ])
      const orders = [...(check(paid) as PaidOrder[]).map(normalizePaid), ...(cancelled.error ? [] : (cancelled.data as Order[]).map(normalizeOrder))] as InvoiceRow['order'][]
      const ids = orders.map((o) => o.id)
      const payments: Payment[] = []
      const dues = new Map<string, number>()
      for (let i = 0; i < ids.length; i += 300) {
        const part = ids.slice(i, i + 300)
        const [p, d] = await Promise.all([
          sb.from('payments').select('*').in('order_id', part),
          sb.from('customer_invoices').select('order_id, due').in('order_id', part),
        ])
        payments.push(...(check(p) as Payment[]).map((x) => ({ ...x, amount: Number(x.amount) })))
        if (!d.error) for (const r of d.data as { order_id: string; due: number }[]) dues.set(r.order_id, Number(r.due))
      }
      const names = new Map(customers.map((c) => [c.id, c.name]))
      return orders
        .filter((o) => o.status !== 'cancelled' || (o.cancelled_total ?? 0) > 0 || o.ticket_no)
        .map((o) => invoiceRow(o, payments, dues.get(o.id) ?? 0, (o.customer_id && names.get(o.customer_id)) || o.customer_name || ''))
        .sort((a, b) => b.at.localeCompare(a.at))
    },
    async invoiceDetail(orderId) {
      const [o, lines, payments] = await Promise.all([
        sb.from('orders').select('*').eq('id', orderId).single(),
        sb.from('order_items').select('*').eq('order_id', orderId).order('created_at'),
        sb.from('payments').select('*').eq('order_id', orderId).order('created_at'),
      ])
      return {
        order: normalizePaid(check(o) as PaidOrder),
        lines: (check(lines) as OrderLine[]).map(normalizeLine),
        payments: (check(payments) as Payment[]).map((p) => ({ ...p, amount: Number(p.amount), received: Number(p.received), change_amount: Number(p.change_amount) })),
      }
    },
    subscribe(onChange) {
      const a = channel(onChange)
      const b = repo.subscribeOrders(onChange)
      return () => {
        a()
        b()
      }
    },
  }
  return service
}

/** Demo orders database, read only here (the order store stays the only writer of orders). */
function demoOrders(): { orders: Order[]; lines: OrderLine[]; payments: Payment[] } {
  try {
    const db = JSON.parse(localStorage.getItem('smile.orders.v1') ?? '{}') as { orders?: Order[]; lines?: OrderLine[]; payments?: Payment[] }
    return { orders: (db.orders ?? []).map(normalizeOrder), lines: (db.lines ?? []).map(normalizeLine), payments: db.payments ?? [] }
  } catch {
    return { orders: [], lines: [], payments: [] }
  }
}

function localUnpaid(customerId?: string): CustomerInvoice[] {
  const { orders, payments } = demoOrders()
  const settled = new Map<string, number>()
  for (const s of loadCustomers().settlements) for (const i of s.items) settled.set(i.order_id, (settled.get(i.order_id) ?? 0) + i.amount)
  const out: CustomerInvoice[] = []
  for (const o of orders as PaidOrder[]) {
    if (o.status !== 'paid' || !o.customer_id || (customerId && o.customer_id !== customerId)) continue
    const credit = payments.filter((p) => p.order_id === o.id && p.method === 'credit').reduce((s, p) => s + p.amount, 0)
    if (credit <= 0) continue
    const done = settled.get(o.id) ?? 0
    out.push({
      order_id: o.id, customer_id: o.customer_id, ticket_no: o.ticket_no ?? null, order_type: o.order_type, table_id: o.table_id,
      takeaway_no: o.takeaway_no, delivery_no: o.delivery_no, closed_at: o.closed_at, total: Number(o.total), credit, settled: done,
      due: da(credit - done),
    })
  }
  return out.sort((a, b) => a.closed_at.localeCompare(b.closed_at) || (a.ticket_no ?? 0) - (b.ticket_no ?? 0))
}

function localCustomers(): CustomersService {
  const refuseDuplicate = (phone: string, id?: string) => {
    const key = phoneKey(phone)
    if (key && loadCustomers().customers.some((c) => c.id !== id && phoneKey(c.phone) === key)) throw new Error(tr().errCustomerPhoneTaken)
  }
  const service: CustomersService = {
    async list() {
      return loadCustomers().customers.map(normCustomer).sort(byName)
    },
    async create(c) {
      if (!localCan('customers') && !localCan('credit_sale')) throw new Error(tr().errNoPermission)
      const clean = cleanCustomer(c)
      refuseDuplicate(clean.phone)
      const row: Customer = { ...clean, id: newId(), active: true, created_at: new Date().toISOString() }
      const db = loadCustomers()
      db.customers.push(row)
      saveCustomers(db)
      return row
    },
    async update(id, patch) {
      if (!localCan('customers')) throw new Error(tr().errNoPermission)
      const clean = cleanCustomer(patch)
      if (clean.phone !== undefined) refuseDuplicate(clean.phone, id)
      const db = loadCustomers()
      db.customers = db.customers.map((c) => (c.id === id ? { ...c, ...clean } : c))
      saveCustomers(db)
    },
    async history(customerId) {
      const { orders, lines } = demoOrders()
      const mine = (orders as PaidOrder[]).filter((o) => o.customer_id === customerId && o.status === 'paid').map(normalizePaid)
      const ids = new Set(mine.map((o) => o.id))
      const due = localUnpaid(customerId).reduce((s, i) => s + i.due, 0)
      const settlements = loadCustomers().settlements.filter((s) => s.customer_id === customerId)
        .map(({ items: _, ...s }) => s).sort((a, b) => b.created_at.localeCompare(a.created_at))
      return buildHistory(mine as CustomerHistory['orders'], lines.filter((l) => ids.has(l.order_id)), due, settlements)
    },
    async unpaid(customerId) {
      return localUnpaid(customerId).filter((i) => i.due > 0)
    },
    async balances() {
      return groupBalances(await service.list(), localUnpaid())
    },
    async payOnCredit(orderId, customerId, amount) {
      const t = tr()
      if (!localCan('credit_sale')) throw new Error(t.errNoPermission)
      const c = loadCustomers().customers.find((x) => x.id === customerId && x.active !== false)
      if (!c) throw new Error(t.errCustomerGone)
      const pay = da(amount)
      if (c.credit_limit != null && !(await admin.isAdmin())) {
        const due = localUnpaid(customerId).reduce((s, i) => s + i.due, 0)
        if (due + pay > c.credit_limit) throw customersError(`credit_limit:${Math.max(c.credit_limit - due, 0)}`)
      }
      await repo.linkCustomer(orderId, c)
      return repo.addPayment(orderId, 'credit', pay, null)
    },
    async settle(customerId, amount, method, orderIds, note) {
      const t = tr()
      if (!localCan('credit_settle')) throw new Error(t.errNoPermission)
      const db = loadCustomers()
      const c = db.customers.find((x) => x.id === customerId)
      if (!c) throw new Error(t.errCustomerGone)
      const pay = da(amount)
      if (!(pay > 0)) throw checkoutError('amount_invalid')
      const due = localUnpaid(customerId).filter((i) => i.due > 0 && (!orderIds?.length || orderIds.includes(i.order_id)))
      const total = due.reduce((s, i) => s + i.due, 0)
      if (total <= 0) throw new Error(t.errNothingDue)
      if (pay > total) throw customersError(`settle_too_much:${total}`)
      if (method === 'cash') {
        if (!(await cash.isOpen())) throw new CashClosedError(t.errSettleNeedsDay)
        await cash.addMovement({ kind: 'in', amount: pay, reason: `Règlement crédit client — ${c.name}` })
      }
      const id = newId()
      let left = pay
      const items = due.flatMap((i) => {
        if (left <= 0) return []
        const part = Math.min(i.due, left)
        left -= part
        return [{ settlement_id: id, order_id: i.order_id, amount: part }]
      })
      const row: CustomerSettlement = {
        id, customer_id: c.id, customer_name: c.name, amount: pay, method, note: (note ?? '').trim().slice(0, 300),
        user_name: t.waiterDemo, created_at: new Date().toISOString(),
      }
      const fresh = loadCustomers()
      fresh.settlements.push({ ...row, items })
      saveCustomers(fresh)
      return row
    },
    async settlements(from, to) {
      return loadCustomers().settlements.filter((s) => new Date(s.created_at) >= from && new Date(s.created_at) < to).map(({ items: _, ...s }) => s)
    },
    async invoices(from, to) {
      const { orders, payments } = demoOrders()
      const dues = new Map(localUnpaid().map((i) => [i.order_id, i.due]))
      const names = new Map(loadCustomers().customers.map((c) => [c.id, c.name]))
      const inRange = (iso: string | null | undefined) => !!iso && new Date(iso) >= from && new Date(iso) < to
      return (orders as InvoiceRow['order'][])
        .filter((o) => (o.status === 'paid' && inRange(o.closed_at)) || (o.status === 'cancelled' && inRange(o.cancelled_at) && ((o.cancelled_total ?? 0) > 0 || o.ticket_no)))
        .map((o) => invoiceRow(o.status === 'paid' ? normalizePaid(o as PaidOrder) : o, payments, dues.get(o.id) ?? 0, (o.customer_id && names.get(o.customer_id)) || o.customer_name || ''))
        .sort((a, b) => b.at.localeCompare(a.at))
    },
    async invoiceDetail(orderId) {
      const { orders, lines, payments } = demoOrders()
      const order = orders.find((o) => o.id === orderId)
      if (!order) throw checkoutError('order_not_found')
      return { order: normalizePaid(order as PaidOrder), lines: lines.filter((l) => l.order_id === orderId), payments: payments.filter((p) => p.order_id === orderId) }
    },
    subscribe(onChange) {
      const a = onLocalCustomers(onChange)
      const b = repo.subscribeOrders(onChange)
      return () => {
        a()
        b()
      }
    },
  }
  return service
}

export const customers: CustomersService = supabase ? supabaseCustomers(supabase) : localCustomers()

/** « Table 4 », « À emporter n° 3 », « Livraison n° 2 » of an invoice, with the tables' labels. */
export function invoicePlace(t: { table: (l: string) => string; takeawayShort: (n: string) => string; deliveryShort: (n: string) => string }, o: Pick<Order, 'order_type' | 'table_id' | 'takeaway_no' | 'delivery_no'>, tables: Map<string, string>): string {
  if (o.order_type === 'takeaway') return t.takeawayShort(String(o.takeaway_no ?? '?'))
  if (o.order_type === 'delivery') return t.deliveryShort(String(o.delivery_no ?? '?'))
  return o.table_id && tables.get(o.table_id) ? t.table(tables.get(o.table_id)!) : '—'
}

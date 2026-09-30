import type { SupabaseClient } from '@supabase/supabase-js'
import { sharedChannel, supabase } from './repo'
import { backOffice, editLocalStock, localMovement, localUserName } from './backoffice'
import { tr } from './i18n'
import type { NewPurchase, SupplierInvoice, SupplierInvoiceItem, SupplierPayment, SupplierPaymentStatus } from './types'
import { newId } from './id'

/**
 * Achats fournisseurs (menu Gestion du Stock): Effectuer un achat and Factures fournisseurs. Supabase tables
 * supplier_invoices, supplier_invoice_items and supplier_invoice_payments, written only through the RPCs
 * create_supplier_purchase and pay_supplier_invoice (migration 20260930070000_supplier_purchases.sql), or localStorage
 * in demo mode, like `repo`. A purchase adds each line's quantity to its stock item in the same step.
 */
export interface PurchasesService {
  /** Every invoice, unpaid first, then partially paid, then paid; newest first within each. */
  listInvoices(): Promise<SupplierInvoice[]>
  /** Lines and payments of one invoice. */
  details(invoiceId: string): Promise<{ items: SupplierInvoiceItem[]; payments: SupplierPayment[] }>
  /** Creates the invoice and adds the bought quantities to the stock. */
  createPurchase(p: NewPurchase): Promise<SupplierInvoice>
  /** Régler: pays all or part of what is left on the invoice. */
  pay(invoiceId: string, amount: number, date: string): Promise<SupplierInvoice>
  subscribe(onChange: () => void): () => void
}

export const round2 = (n: number) => Math.round(n * 100) / 100
/** Amount of one line, rounded to the centime like the database does. */
export const lineTotal = (l: { quantity: number; unit_price: number }) => round2(l.quantity * l.unit_price)
export const remaining = (i: Pick<SupplierInvoice, 'total_amount' | 'paid_amount'>) => round2(i.total_amount - i.paid_amount)

export function paymentStatus(total: number, paid: number): SupplierPaymentStatus {
  return paid >= total ? 'paid' : paid > 0 ? 'partial' : 'unpaid'
}

const STATUS_ORDER: Record<SupplierPaymentStatus, number> = { unpaid: 0, partial: 1, paid: 2 }
/** Non payées en premier, then newest first. */
export const invoiceOrder = (a: SupplierInvoice, b: SupplierInvoice) =>
  STATUS_ORDER[a.payment_status] - STATUS_ORDER[b.payment_status] || b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at)

/** Checks a purchase before it is sent; returns its total. */
function checkPurchase(p: NewPurchase): number {
  const t = tr()
  if (!p.supplier_id) throw new Error(t.errPurchaseSupplier)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new Error(t.errPurchaseDate)
  if (!p.lines.length) throw new Error(t.errPurchaseLines)
  for (const l of p.lines) {
    if (!l.stock_item_id) throw new Error(t.errPurchaseItem)
    if (!(Number.isFinite(l.quantity) && l.quantity > 0)) throw new Error(t.errQuantity)
    if (!(Number.isFinite(l.unit_price) && l.unit_price >= 0)) throw new Error(t.errPurchasePrice)
  }
  const total = round2(p.lines.reduce((s, l) => s + lineTotal(l), 0))
  if (!(Number.isFinite(p.paid) && p.paid >= 0 && round2(p.paid) <= total)) throw new Error(t.errPurchasePaid)
  return total
}

function purchasesError(message: string): Error {
  const t = tr()
  if (/supplier_invoice|create_supplier_purchase|pay_supplier_invoice/.test(message) && /does not exist|schema cache|Could not find/i.test(message)) {
    return new Error(t.errMigrationPurchases)
  }
  if (/no_permission|row-level security|permission denied/i.test(message)) return new Error(t.errNoPermission)
  if (message.includes('supplier_not_found')) return new Error(t.errPurchaseSupplierGone)
  if (message.includes('stock_item_not_found')) return new Error(t.errStockGone)
  if (message.includes('invoice_not_found')) return new Error(t.errInvoiceGone)
  if (message.includes('bad_paid_amount')) return new Error(t.errPurchasePaid)
  if (message.includes('bad_quantity')) return new Error(t.errQuantity)
  if (message.includes('bad_price')) return new Error(t.errPurchasePrice)
  if (message.includes('no_lines')) return new Error(t.errPurchaseLines)
  return new Error(message)
}

const normInvoice = (i: SupplierInvoice): SupplierInvoice => ({ ...i, total_amount: Number(i.total_amount), paid_amount: Number(i.paid_amount) })
const normItem = (i: SupplierInvoiceItem): SupplierInvoiceItem => ({ ...i, quantity: Number(i.quantity), unit_price: Number(i.unit_price) })
const normPayment = (p: SupplierPayment): SupplierPayment => ({ ...p, amount: Number(p.amount) })

function supabasePurchases(sb: SupabaseClient): PurchasesService {
  const check = <T>(res: { data: T; error: { message: string } | null }): T => {
    if (res.error) throw purchasesError(res.error.message)
    return res.data
  }
  const columns = 'id, supplier_id, supplier_name, date, total_amount, paid_amount, payment_status, created_at'
  return {
    async listInvoices() {
      return (check(await sb.from('supplier_invoices').select(columns)) as SupplierInvoice[]).map(normInvoice).sort(invoiceOrder)
    },
    async details(invoiceId) {
      const [items, payments] = await Promise.all([
        sb.from('supplier_invoice_items').select('id, invoice_id, stock_item_id, item_name, quantity, unit, unit_price').eq('invoice_id', invoiceId).order('position'),
        sb.from('supplier_invoice_payments').select('id, invoice_id, amount, date, created_at').eq('invoice_id', invoiceId).order('date').order('created_at'),
      ])
      return { items: (check(items) as SupplierInvoiceItem[]).map(normItem), payments: (check(payments) as SupplierPayment[]).map(normPayment) }
    },
    async createPurchase(p) {
      checkPurchase(p)
      const lines = p.lines.map((l) => ({ ...l, unit: l.unit.trim(), unit_price: round2(l.unit_price) }))
      return normInvoice(check(await sb.rpc('create_supplier_purchase', {
        p_supplier_id: p.supplier_id, p_date: p.date, p_lines: lines, p_paid: round2(p.paid),
      })) as SupplierInvoice)
    },
    async pay(invoiceId, amount, date) {
      if (!(Number.isFinite(amount) && amount > 0)) throw new Error(tr().errPurchasePaid)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(tr().errPurchaseDate)
      return normInvoice(check(await sb.rpc('pay_supplier_invoice', { p_invoice_id: invoiceId, p_amount: round2(amount), p_date: date })) as SupplierInvoice)
    },
    subscribe: sharedChannel(sb, 'purchases', ['supplier_invoices']),
  }
}

// ───────────── Demo mode (localStorage) ─────────────

const KEY = 'smile.purchases.v1'

interface LocalPurchases {
  invoices: SupplierInvoice[]
  items: SupplierInvoiceItem[]
  payments: SupplierPayment[]
}

function localPurchases(): PurchasesService {
  const listeners = new Set<() => void>()
  const read = (): LocalPurchases => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<LocalPurchases> | null
      return { invoices: saved?.invoices ?? [], items: saved?.items ?? [], payments: saved?.payments ?? [] }
    } catch {
      return { invoices: [], items: [], payments: [] }
    }
  }
  const write = (db: LocalPurchases) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(db))
    } catch {
      // Not persisted (private mode); the change is lost on reload.
    }
    listeners.forEach((l) => l())
  }
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) listeners.forEach((l) => l())
  })
  const now = () => new Date().toISOString()
  return {
    async listInvoices() {
      return [...read().invoices].sort(invoiceOrder)
    },
    async details(invoiceId) {
      const db = read()
      return {
        items: db.items.filter((i) => i.invoice_id === invoiceId),
        payments: db.payments.filter((p) => p.invoice_id === invoiceId).sort((a, b) => a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at)),
      }
    },
    async createPurchase(p) {
      const total = checkPurchase(p)
      const [suppliers, stock] = await Promise.all([backOffice.listSuppliers(), backOffice.listStock()])
      const supplier = suppliers.find((s) => s.id === p.supplier_id)
      if (!supplier) throw new Error(tr().errPurchaseSupplierGone)
      const byId = new Map(stock.map((s) => [s.id, s]))
      if (p.lines.some((l) => !byId.has(l.stock_item_id))) throw new Error(tr().errStockGone)
      const paid = round2(p.paid)
      const invoice: SupplierInvoice = {
        id: newId(), supplier_id: supplier.id, supplier_name: supplier.name, date: p.date,
        total_amount: total, paid_amount: paid, payment_status: paymentStatus(total, paid), created_at: now(),
      }
      // + quantité achetée au Dépôt, traced as purchase movements, in one write.
      const user = await localUserName()
      const batch = newId()
      editLocalStock((db) => {
        for (const l of p.lines) {
          const item = db.stock.find((s) => s.id === l.stock_item_id)
          if (!item) throw new Error(tr().errStockGone)
          item.quantity = Math.round((item.quantity + l.quantity) * 1000) / 1000
          if (!item.unit && l.unit.trim()) item.unit = l.unit.trim()
          item.updated_at = now()
          byId.set(item.id, { ...item })
          db.movements.push(localMovement({
            type: 'purchase', item, quantity: l.quantity, to_location: 'depot', unit_cost: round2(l.unit_price), invoice_id: invoice.id,
            batch_id: batch, user_name: user,
          }))
        }
      })
      const db = read()
      db.invoices.push(invoice)
      db.items.push(...p.lines.map((l) => ({
        id: newId(), invoice_id: invoice.id, stock_item_id: l.stock_item_id, item_name: byId.get(l.stock_item_id)!.name,
        quantity: l.quantity, unit: l.unit.trim() || byId.get(l.stock_item_id)!.unit, unit_price: round2(l.unit_price),
      })))
      if (paid > 0) db.payments.push({ id: newId(), invoice_id: invoice.id, amount: paid, date: p.date, created_at: now() })
      write(db)
      return invoice
    },
    async pay(invoiceId, amount, date) {
      const db = read()
      const invoice = db.invoices.find((i) => i.id === invoiceId)
      if (!invoice) throw new Error(tr().errInvoiceGone)
      const n = round2(amount)
      if (!(n > 0 && n <= remaining(invoice))) throw new Error(tr().errPurchasePaid)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(tr().errPurchaseDate)
      invoice.paid_amount = round2(invoice.paid_amount + n)
      invoice.payment_status = paymentStatus(invoice.total_amount, invoice.paid_amount)
      db.payments.push({ id: newId(), invoice_id: invoiceId, amount: n, date, created_at: now() })
      write(db)
      return { ...invoice }
    },
    subscribe(onChange) {
      const l = () => onChange()
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
  }
}

export const purchases: PurchasesService = supabase ? supabasePurchases(supabase) : localPurchases()

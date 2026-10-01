import type { SupabaseClient } from '@supabase/supabase-js'
import { localCan, sharedChannel, supabase } from './repo'
import { backOffice, editLocalStock, localMovement, localUserName } from './backoffice'
import { tr } from './i18n'
import type { NewPurchase, StockItem, SupplierInvoice, SupplierInvoiceItem, SupplierPayment, SupplierPaymentStatus, SupplierReturn } from './types'
import { newId } from './id'
import { money } from './format'

/**
 * Achats fournisseurs (menu Gestion du Stock): Effectuer un achat and Factures fournisseurs. Supabase tables
 * supplier_invoices, supplier_invoice_items and supplier_invoice_payments, written only through the RPCs
 * create_supplier_purchase and pay_supplier_invoice (migration 20260930070000_supplier_purchases.sql), or localStorage
 * in demo mode, like `repo`. A purchase adds each line's quantity to its stock item in the same step.
 * Annuler / Modifier / Retour (migration 20261001000000_supplier_invoice_cancel.sql): cancel_supplier_invoice,
 * replace_supplier_invoice and create_supplier_return take the quantities back out of the stock, in one step each.
 */
export interface PurchasesService {
  /** Every invoice, unpaid first, then partially paid, then paid; newest first within each. */
  listInvoices(): Promise<SupplierInvoice[]>
  /** Lines, payments and retours of one invoice. */
  details(invoiceId: string): Promise<InvoiceDetails>
  /** Creates the invoice and adds the bought quantities to the stock. */
  createPurchase(p: NewPurchase): Promise<SupplierInvoice>
  /** Régler: pays all or part of what is left on the invoice. */
  pay(invoiceId: string, amount: number, date: string): Promise<SupplierInvoice>
  /**
   * Annuler la facture: never deleted, status Annulée; its quantities leave the Dépôt; cash paid from the drawer comes
   * back to the open day. Throws DepotShortageError when the Dépôt no longer has them, unless `force`.
   */
  cancel(invoiceId: string, reason: string, force?: boolean): Promise<SupplierInvoice>
  /** Modifier: cancels the invoice and creates its corrected copy (linked); payments move to the new one. */
  replace(invoiceId: string, reason: string, p: Omit<NewPurchase, 'paid'>, force?: boolean): Promise<SupplierInvoice>
  /** Retour fournisseur (avoir): items leave the stock, their amount is deducted from what is left to pay. */
  createReturn(invoiceId: string, lines: ReturnLine[], reason: string, force?: boolean): Promise<void>
  subscribe(onChange: () => void): () => void
}

export interface InvoiceDetails {
  items: SupplierInvoiceItem[]
  payments: SupplierPayment[]
  returns: SupplierReturn[]
}

/** Quantity sent back for one invoice line, in the line's unit. */
export interface ReturnLine {
  invoice_item_id: string
  quantity: number
}

/** An item the Dépôt no longer has enough of (already sent to the kitchen or consumed). Stock units. */
export interface DepotShortage {
  item: string
  unit: string
  needed: number
  depot: number
  kitchen: number
}

/** The Dépôt cannot give back everything: the user confirms to take the rest from the Cuisine. */
export class DepotShortageError extends Error {
  constructor(readonly shortages: DepotShortage[]) {
    super(tr().errDepotShortage)
  }
}

export const round2 = (n: number) => Math.round(n * 100) / 100
const round3 = (n: number) => Math.round(n * 1000) / 1000
/** Amount of one line, rounded to the centime like the database does. */
export const lineTotal = (l: { quantity: number; unit_price: number }) => round2(l.quantity * l.unit_price)
export const isCancelled = (i: Pick<SupplierInvoice, 'status'>) => i.status === 'cancelled'
/** Total after the retours fournisseur (avoirs). */
export const netTotal = (i: Pick<SupplierInvoice, 'total_amount' | 'returned_amount'>) => round2(i.total_amount - (i.returned_amount ?? 0))
/** Reste à payer; nothing on a cancelled invoice. */
export const remaining = (i: Pick<SupplierInvoice, 'total_amount' | 'paid_amount' | 'returned_amount' | 'status'>) =>
  isCancelled(i) ? 0 : Math.max(0, round2(netTotal(i) - i.paid_amount))
/** Paid beyond the total after a retour: the supplier owes it back (avoir à récupérer). */
export const credit = (i: Pick<SupplierInvoice, 'total_amount' | 'paid_amount' | 'returned_amount'>) => Math.max(0, round2(i.paid_amount - netTotal(i)))
/** « n° 12 » (« رقم 12 ») when the invoice has a number (after the migration). */
export const invoiceNo = (i: Pick<SupplierInvoice, 'number'>) => (i.number ? tr().purNo(i.number) : '')

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
  if (/cancel_supplier_invoice|replace_supplier_invoice|create_supplier_return|supplier_returns/.test(message) && /does not exist|schema cache|Could not find/i.test(message)) {
    return new Error(t.errMigrationPurchaseCancel)
  }
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
  const short = /insufficient_depot (\[.*\])/.exec(message)
  if (short) {
    try {
      const rows = JSON.parse(short[1]) as DepotShortage[]
      return new DepotShortageError(rows.map((r) => ({ ...r, needed: Number(r.needed), depot: Number(r.depot), kitchen: Number(r.kitchen) })))
    } catch {
      return new Error(t.errDepotShortage)
    }
  }
  const overPaid = /paid_exceeds_total:(-?[\d.]+)/.exec(message)
  if (overPaid) return new Error(t.errReplacePaid(money(Number(overPaid[1]))))
  if (message.includes('reason_required')) return new Error(t.errCancelReasonRequired)
  if (message.includes('invoice_cancelled')) return new Error(t.errInvoiceCancelled)
  if (message.includes('invoice_has_returns')) return new Error(t.errReplaceReturns)
  if (message.includes('return_too_much') || message.includes('invoice_item_not_found')) return new Error(t.errReturnTooMuch)
  if (message.includes('no_open_day')) return new Error(t.errRefundNoOpenDay)
  return new Error(message)
}

const normInvoice = (i: SupplierInvoice): SupplierInvoice => ({
  ...i, total_amount: Number(i.total_amount), paid_amount: Number(i.paid_amount), status: i.status ?? 'active',
  returned_amount: Number(i.returned_amount ?? 0), cancel_cash_refund: Number(i.cancel_cash_refund ?? 0),
})
const normItem = (i: SupplierInvoiceItem): SupplierInvoiceItem => ({
  ...i, quantity: Number(i.quantity), unit_price: Number(i.unit_price), factor: Number(i.factor ?? 1) || 1,
  returned_quantity: Number(i.returned_quantity ?? 0),
})
const normReturn = (r: SupplierReturn): SupplierReturn => ({
  ...r, amount: Number(r.amount), items: (r.items ?? []).map((x) => ({ ...x, quantity: Number(x.quantity), unit_price: Number(x.unit_price) })),
})

function checkReason(reason: string): string {
  const r = reason.trim()
  if (!r) throw new Error(tr().errCancelReasonRequired)
  return r.slice(0, 300)
}

function checkReturn(lines: ReturnLine[]): ReturnLine[] {
  const out = lines.filter((l) => l.quantity > 0)
  if (!out.length) throw new Error(tr().errReturnEmpty)
  for (const l of out) if (!Number.isFinite(l.quantity)) throw new Error(tr().errQuantity)
  return out.map((l) => ({ ...l, quantity: round3(l.quantity) }))
}

/**
 * Stock units per bought unit: the item's coefficient when the line is in its unité d'achat (2 fardeaux = 12
 * bouteilles), 1 otherwise. Same rule as create_supplier_purchase().
 */
export function lineFactor(item: Pick<StockItem, 'purchase_unit' | 'purchase_factor'>, unit: string): number {
  return item.purchase_unit && item.purchase_factor && unit.trim().toLowerCase() === item.purchase_unit.trim().toLowerCase() ? item.purchase_factor : 1
}
const normPayment = (p: SupplierPayment): SupplierPayment => ({ ...p, amount: Number(p.amount) })

function supabasePurchases(sb: SupabaseClient): PurchasesService {
  const check = <T>(res: { data: T; error: { message: string } | null }): T => {
    if (res.error) throw purchasesError(res.error.message)
    return res.data
  }
  return {
    async listInvoices() {
      // '*': the columns of the cancellation migration are read when it has been run.
      return (check(await sb.from('supplier_invoices').select('*')) as SupplierInvoice[]).map(normInvoice).sort(invoiceOrder)
    },
    async details(invoiceId) {
      const [items, payments, returns] = await Promise.all([
        sb.from('supplier_invoice_items').select('*').eq('invoice_id', invoiceId).order('position'),
        sb.from('supplier_invoice_payments').select('id, invoice_id, amount, date, created_at').eq('invoice_id', invoiceId).order('date').order('created_at'),
        sb.from('supplier_returns').select('*, items:supplier_return_items(*)').eq('invoice_id', invoiceId).order('created_at'),
      ])
      return {
        items: (check(items) as SupplierInvoiceItem[]).map(normItem),
        payments: (check(payments) as SupplierPayment[]).map(normPayment),
        // No retours before the migration.
        returns: returns.error ? [] : (returns.data as SupplierReturn[]).map(normReturn),
      }
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
    async cancel(invoiceId, reason, force = false) {
      return normInvoice(check(await sb.rpc('cancel_supplier_invoice', { p_invoice_id: invoiceId, p_reason: checkReason(reason), p_force: force })) as SupplierInvoice)
    },
    async replace(invoiceId, reason, p, force = false) {
      const r = checkReason(reason)
      checkPurchase({ ...p, paid: 0 })
      const lines = p.lines.map((l) => ({ ...l, unit: l.unit.trim(), unit_price: round2(l.unit_price) }))
      return normInvoice(check(await sb.rpc('replace_supplier_invoice', {
        p_invoice_id: invoiceId, p_reason: r, p_supplier_id: p.supplier_id, p_date: p.date, p_lines: lines, p_force: force,
      })) as SupplierInvoice)
    },
    async createReturn(invoiceId, lines, reason, force = false) {
      const r = checkReason(reason)
      check(await sb.rpc('create_supplier_return', { p_invoice_id: invoiceId, p_lines: checkReturn(lines), p_reason: r, p_force: force }))
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
  returns: SupplierReturn[]
}

interface StockOutLine {
  stock_item_id: string
  /** Stock units. */
  quantity: number
  unit_cost: number
}

/**
 * Demo mode, like supplier_stock_out(): takes the quantities out of the Dépôt first, the rest out of the Cuisine
 * (which may go negative) once confirmed; without `force`, a shortage throws DepotShortageError.
 */
async function localStockOut(type: 'purchase_cancel' | 'supplier_return', invoiceId: string, lines: StockOutLine[], note: string, force: boolean,
  voidPurchases = false) {
  const user = await localUserName()
  const batch = newId()
  editLocalStock((db) => {
    const need = new Map<string, number>()
    for (const l of lines) need.set(l.stock_item_id, (need.get(l.stock_item_id) ?? 0) + l.quantity)
    const short: DepotShortage[] = []
    for (const [id, n] of need) {
      const item = db.stock.find((s) => s.id === id)
      if (item && n > Math.max(item.quantity, 0)) short.push({ item: item.name, unit: item.unit, needed: round3(n), depot: item.quantity, kitchen: item.kitchen_quantity })
    }
    if (short.length && !force) throw new DepotShortageError(short)
    for (const l of lines) {
      const item = db.stock.find((s) => s.id === l.stock_item_id)
      if (!item || l.quantity <= 0) continue
      const fromDepot = round3(Math.min(l.quantity, Math.max(item.quantity, 0)))
      const fromKitchen = round3(l.quantity - fromDepot)
      item.quantity = round3(item.quantity - fromDepot)
      item.kitchen_quantity = round3(item.kitchen_quantity - fromKitchen)
      item.updated_at = new Date().toISOString()
      for (const [q, from] of [[fromDepot, 'depot'], [fromKitchen, 'kitchen']] as const) {
        if (q > 0) db.movements.push(localMovement({ type, item, quantity: q, from_location: from, unit_cost: l.unit_cost, invoice_id: invoiceId, batch_id: batch, user_name: user, note }))
      }
    }
    if (voidPurchases) for (const m of db.movements) if (m.type === 'purchase' && m.invoice_id === invoiceId) m.voided = true
  })
}

/** What an invoice still holds in the stock: its quantities minus the retours, in stock units. */
function remainingStock(db: LocalPurchases, invoiceId: string): StockOutLine[] {
  return db.items
    .filter((i) => i.invoice_id === invoiceId && i.stock_item_id && i.quantity > (i.returned_quantity ?? 0))
    .map((i) => ({
      stock_item_id: i.stock_item_id!, quantity: round3((i.quantity - (i.returned_quantity ?? 0)) * i.factor),
      unit_cost: Math.round((i.unit_price / i.factor) * 10000) / 10000,
    }))
}

function localPurchases(): PurchasesService {
  const listeners = new Set<() => void>()
  const read = (): LocalPurchases => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<LocalPurchases> | null
      return { invoices: saved?.invoices ?? [], items: saved?.items ?? [], payments: saved?.payments ?? [], returns: saved?.returns ?? [] }
    } catch {
      return { invoices: [], items: [], payments: [], returns: [] }
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
        returns: db.returns.filter((r) => r.invoice_id === invoiceId),
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
        number: read().invoices.reduce((n, i) => Math.max(n, i.number ?? 0), 0) + 1, status: 'active', returned_amount: 0, cancel_cash_refund: 0,
      }
      // + quantité achetée au Dépôt, traced as purchase movements, in one write.
      const user = await localUserName()
      const batch = newId()
      editLocalStock((db) => {
        for (const l of p.lines) {
          const item = db.stock.find((s) => s.id === l.stock_item_id)
          if (!item) throw new Error(tr().errStockGone)
          const factor = lineFactor(item, l.unit)
          item.quantity = Math.round((item.quantity + l.quantity * factor) * 1000) / 1000
          if (!item.unit && l.unit.trim()) item.unit = l.unit.trim()
          item.updated_at = now()
          byId.set(item.id, { ...item })
          db.movements.push(localMovement({
            type: 'purchase', item, quantity: Math.round(l.quantity * factor * 1000) / 1000, to_location: 'depot',
            unit_cost: Math.round((round2(l.unit_price) / factor) * 10000) / 10000, invoice_id: invoice.id,
            batch_id: batch, user_name: user,
          }))
        }
      })
      const db = read()
      db.invoices.push(invoice)
      db.items.push(...p.lines.map((l) => ({
        id: newId(), invoice_id: invoice.id, stock_item_id: l.stock_item_id, item_name: byId.get(l.stock_item_id)!.name,
        quantity: l.quantity, unit: l.unit.trim() || byId.get(l.stock_item_id)!.unit, unit_price: round2(l.unit_price),
        factor: lineFactor(byId.get(l.stock_item_id)!, l.unit),
      })))
      if (paid > 0) db.payments.push({ id: newId(), invoice_id: invoice.id, amount: paid, date: p.date, created_at: now() })
      write(db)
      return invoice
    },
    async pay(invoiceId, amount, date) {
      const db = read()
      const invoice = db.invoices.find((i) => i.id === invoiceId)
      if (!invoice) throw new Error(tr().errInvoiceGone)
      if (isCancelled(invoice)) throw new Error(tr().errInvoiceCancelled)
      const n = round2(amount)
      if (!(n > 0 && n <= remaining(invoice))) throw new Error(tr().errPurchasePaid)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(tr().errPurchaseDate)
      invoice.paid_amount = round2(invoice.paid_amount + n)
      invoice.payment_status = paymentStatus(netTotal(invoice), invoice.paid_amount)
      db.payments.push({ id: newId(), invoice_id: invoiceId, amount: n, date, created_at: now() })
      write(db)
      return { ...invoice }
    },
    async cancel(invoiceId, reason, force = false) {
      if (!localCan('purchase_cancel')) throw new Error(tr().errNoPermission)
      const r = checkReason(reason)
      const db = read()
      const invoice = db.invoices.find((i) => i.id === invoiceId)
      if (!invoice) throw new Error(tr().errInvoiceGone)
      if (isCancelled(invoice)) throw new Error(tr().errInvoiceCancelled)
      const user = await localUserName()
      const { localSupplierRefund } = await import('./cash')
      const label = `Annulation facture fournisseur n° ${invoice.number}`
      localSupplierRefund(invoice.id, label, invoice.supplier_name, user, true)
      await localStockOut('purchase_cancel', invoice.id, remainingStock(db, invoice.id), `Annulation facture n° ${invoice.number} : ${r}`, force, true)
      const refund = localSupplierRefund(invoice.id, label, invoice.supplier_name, user)
      Object.assign(invoice, { status: 'cancelled', cancel_reason: r, cancelled_at: now(), cancelled_by_name: user, cancel_cash_refund: refund })
      write(db)
      return { ...invoice }
    },
    async replace(invoiceId, reason, p, force = false) {
      if (!localCan('purchase_cancel')) throw new Error(tr().errNoPermission)
      const r = checkReason(reason)
      const total = checkPurchase({ ...p, paid: 0 })
      const db = read()
      const old = db.invoices.find((i) => i.id === invoiceId)
      if (!old) throw new Error(tr().errInvoiceGone)
      if (isCancelled(old)) throw new Error(tr().errInvoiceCancelled)
      if ((old.returned_amount ?? 0) > 0 || db.returns.some((x) => x.invoice_id === old.id)) throw new Error(tr().errReplaceReturns)
      if (old.paid_amount > total) throw new Error(tr().errReplacePaid(money(old.paid_amount)))
      // Like the database: the new invoice comes in first, so only a real shortage asks for confirmation.
      const out = remainingStock(db, old.id)
      if (!force) {
        const stock = await backOffice.listStock()
        const added = new Map<string, number>()
        for (const l of p.lines) {
          const item = stock.find((s) => s.id === l.stock_item_id)
          if (item) added.set(item.id, (added.get(item.id) ?? 0) + l.quantity * lineFactor(item, l.unit))
        }
        const need = new Map<string, number>()
        for (const l of out) need.set(l.stock_item_id, (need.get(l.stock_item_id) ?? 0) + l.quantity)
        const short: DepotShortage[] = []
        for (const [id, n] of need) {
          const item = stock.find((s) => s.id === id)
          const depot = item ? Math.max(item.quantity, 0) + (added.get(id) ?? 0) : n
          if (item && n > depot) short.push({ item: item.name, unit: item.unit, needed: round3(n), depot: round3(depot), kitchen: item.kitchen_quantity })
        }
        if (short.length) throw new DepotShortageError(short)
      }
      const created = await this.createPurchase({ ...p, paid: 0 })
      await localStockOut('purchase_cancel', old.id, out, `Annulation facture n° ${old.number} : ${r} (remplacée par la facture n° ${created.number})`, true, true)
      const user = await localUserName()
      const { localMoveSupplierCash } = await import('./cash')
      localMoveSupplierCash(old.id, created.id)
      const fresh = read()
      const o = fresh.invoices.find((i) => i.id === old.id)!
      const n = fresh.invoices.find((i) => i.id === created.id)!
      for (const pay of fresh.payments) if (pay.invoice_id === old.id) pay.invoice_id = n.id
      Object.assign(n, { replaces_invoice_id: o.id, paid_amount: o.paid_amount, payment_status: paymentStatus(n.total_amount, o.paid_amount) })
      Object.assign(o, {
        status: 'cancelled', cancel_reason: r, cancelled_at: now(), cancelled_by_name: user, replaced_by_invoice_id: n.id, paid_amount: 0, payment_status: 'unpaid',
      })
      write(fresh)
      return { ...n }
    },
    async createReturn(invoiceId, lines, reason, force = false) {
      if (!localCan('purchase_cancel')) throw new Error(tr().errNoPermission)
      const r = checkReason(reason)
      const checked = checkReturn(lines)
      const db = read()
      const invoice = db.invoices.find((i) => i.id === invoiceId)
      if (!invoice) throw new Error(tr().errInvoiceGone)
      if (isCancelled(invoice)) throw new Error(tr().errInvoiceCancelled)
      const out: StockOutLine[] = []
      const ret: SupplierReturn = { id: newId(), invoice_id: invoice.id, date: now().slice(0, 10), reason: r, amount: 0, user_name: await localUserName(), created_at: now(), items: [] }
      for (const l of checked) {
        const it = db.items.find((x) => x.id === l.invoice_item_id && x.invoice_id === invoice.id)
        if (!it || l.quantity > round3(it.quantity - (it.returned_quantity ?? 0))) throw new Error(tr().errReturnTooMuch)
        ret.items.push({ id: newId(), invoice_item_id: it.id, item_name: it.item_name, quantity: l.quantity, unit: it.unit, unit_price: it.unit_price })
        ret.amount = round2(ret.amount + lineTotal({ quantity: l.quantity, unit_price: it.unit_price }))
        if (it.stock_item_id) out.push({ stock_item_id: it.stock_item_id, quantity: round3(l.quantity * it.factor), unit_cost: Math.round((it.unit_price / it.factor) * 10000) / 10000 })
      }
      await localStockOut('supplier_return', invoice.id, out, `Retour fournisseur, facture n° ${invoice.number} : ${r}`, force)
      for (const x of ret.items) {
        const it = db.items.find((i) => i.id === x.invoice_item_id)!
        it.returned_quantity = round3((it.returned_quantity ?? 0) + x.quantity)
      }
      invoice.returned_amount = round2((invoice.returned_amount ?? 0) + ret.amount)
      invoice.payment_status = paymentStatus(netTotal(invoice), invoice.paid_amount)
      db.returns.push(ret)
      write(db)
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

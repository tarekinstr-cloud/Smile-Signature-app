import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { backOffice } from '../../lib/backoffice'
import { credit, DepotShortageError, invoiceNo, isCancelled, lineTotal, netTotal, purchases, remaining, round2, type DepotShortage, type InvoiceDetails } from '../../lib/purchases'
import { todayIso } from '../../lib/payroll'
import { SUPPLIER_PAYMENT_STATUSES, type StockItem, type Supplier, type SupplierInvoice, type SupplierInvoiceItem, type SupplierPaymentStatus } from '../../lib/types'
import { useI18n } from '../../lib/i18n'
import { money } from '../../lib/format'
import { usePermissions } from '../../lib/permissions'
import { newId } from '../../lib/id'
import { qtyText } from './StockPage'
import { errorText, locale, useLoad } from './useLoad'

/** Parses "2,5" or "2.5" (spaces ignored); null when it is not a number. */
const parseNum = (v: string) => {
  const n = Number(v.replace(/\s/g, '').replace(',', '.'))
  return v.trim() && Number.isFinite(n) ? n : null
}

/** "mer. 30 sept. 2026" from YYYY-MM-DD, in the app's language. */
function useDay() {
  const { lang } = useI18n()
  return (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number)
    return new Date(y, m - 1, d).toLocaleDateString(locale(lang), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  }
}

function StatusTag({ status }: { status: SupplierPaymentStatus }) {
  const { t } = useI18n()
  return <span className={`tag pay-status ${status}`}>{t.purStatus[status]}</span>
}

// ───────────── Effectuer un achat ─────────────

interface Line {
  key: string
  stockId: string
  qty: string
  /** Typed only for an item without a unit; otherwise the item's unit or its unité d'achat (fardeau…). */
  unit: string
  price: string
}

const emptyLine = (): Line => ({ key: newId(), stockId: '', qty: '', unit: '', price: '' })

/** Invoice line → form line (Modifier). */
const toLine = (it: SupplierInvoiceItem): Line => ({
  key: newId(), stockId: it.stock_item_id ?? '', qty: String(it.quantity), unit: it.unit, price: String(it.unit_price),
})

interface PurchaseFormProps {
  onSaved(invoice: SupplierInvoice): void
  /** Modifier: the invoice to correct, prefilled; validating cancels it and creates the corrected one. */
  editing?: { invoice: SupplierInvoice; items: SupplierInvoiceItem[] }
  onCancel?(): void
}

/**
 * Effectuer un achat: supplier, date, lines from the stock, payment status. Validating creates the invoice and adds the
 * quantities to the stock. With `editing` (Modifier): same form prefilled, plus the reason; the payments already made
 * move to the new invoice.
 */
export function NewPurchasePage({ onSaved, editing, onCancel }: PurchaseFormProps) {
  const { t } = useI18n()
  const load = useCallback(() => Promise.all([backOffice.listSuppliers(), backOffice.listStock()]), [])
  const { data, error: loadError, reload } = useLoad(load)
  useEffect(() => backOffice.subscribeStock(() => reload()), [reload])
  const [suppliers, stock]: [Supplier[], StockItem[]] = data ?? [[], []]

  const [supplierId, setSupplierId] = useState(editing?.invoice.supplier_id ?? '')
  const [date, setDate] = useState(() => editing?.invoice.date ?? todayIso())
  const [lines, setLines] = useState<Line[]>(() => (editing?.items.length ? editing.items.map(toLine) : [emptyLine()]))
  const [reason, setReason] = useState('')
  const [shortages, setShortages] = useState<DepotShortage[] | null>(null)
  const [status, setStatus] = useState<SupplierPaymentStatus>('unpaid')
  const [paidText, setPaidText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const byId = useMemo(() => new Map(stock.map((s) => [s.id, s])), [stock])
  const amounts = lines.map((l) => {
    const q = parseNum(l.qty)
    const p = parseNum(l.price)
    return q !== null && p !== null && q > 0 && p >= 0 ? lineTotal({ quantity: q, unit_price: p }) : null
  })
  const total = round2(amounts.reduce<number>((s, a) => s + (a ?? 0), 0))
  const paidPartial = parseNum(paidText)
  const paid = editing ? editing.invoice.paid_amount : status === 'paid' ? total : status === 'unpaid' ? 0 : paidPartial

  const setLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  function reset() {
    setSupplierId('')
    setDate(todayIso())
    setLines([emptyLine()])
    setStatus('unpaid')
    setPaidText('')
    setError(null)
  }

  async function save(e: FormEvent | null, force = false) {
    e?.preventDefault()
    if (!supplierId) return setError(t.errPurchaseSupplier)
    if (!date) return setError(t.errPurchaseDate)
    const filled = lines.filter((l) => l.stockId || l.qty.trim() || l.price.trim())
    if (!filled.length) return setError(t.errPurchaseLines)
    const out = []
    for (const l of filled) {
      const q = parseNum(l.qty)
      const p = parseNum(l.price)
      if (!l.stockId) return setError(t.errPurchaseItem)
      if (q === null || q <= 0) return setError(t.errQuantity)
      if (p === null || p < 0) return setError(t.errPurchasePrice)
      const item = byId.get(l.stockId)
      out.push({ stock_item_id: l.stockId, quantity: q, unit: item?.unit ? (l.unit === item.purchase_unit && item.purchase_unit ? l.unit : item.unit) : l.unit, unit_price: p })
    }
    if (editing) {
      if (!reason.trim()) return setError(t.errCancelReasonRequired)
      if (editing.invoice.paid_amount > total) return setError(t.errReplacePaid(money(editing.invoice.paid_amount)))
    } else if (paid === null || paid < 0 || paid > total || (status === 'partial' && (paid <= 0 || paid >= total))) return setError(t.errPurchasePaid)
    setBusy(true)
    try {
      setError(null)
      const invoice = editing
        ? await purchases.replace(editing.invoice.id, reason, { supplier_id: supplierId, date, lines: out }, force)
        : await purchases.createPurchase({ supplier_id: supplierId, date, lines: out, paid: paid ?? 0 })
      setShortages(null)
      if (!editing) reset()
      onSaved(invoice)
    } catch (err) {
      if (err instanceof DepotShortageError) setShortages(err.shortages)
      else setError(errorText(err))
    }
    setBusy(false)
  }

  return (
    <main className="content bo-content">
      {loadError && <div className="banner error">{loadError}</div>}
      <section className="panel">
        <h2>{editing ? t.purEditTitle(invoiceNo(editing.invoice), editing.invoice.supplier_name) : t.purNewItem}</h2>
        {editing && <p className="muted small">{t.purEditHint}</p>}
        {!data ? (
          !loadError && <p className="muted">{t.loading}</p>
        ) : !suppliers.length ? (
          <p className="muted small">{t.purNoSuppliers}</p>
        ) : !stock.length ? (
          <p className="muted small">{t.purNoStock}</p>
        ) : (
          <form className="res-form" onSubmit={save}>
            {error && <p className="error small" role="alert">{error}</p>}
            <div className="res-grid">
              <label>
                {t.purSupplier}
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} autoFocus>
                  <option value="">{t.purChooseSupplier}</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label>
                {t.purDate}
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
            </div>

            <h3>{t.purLines}</h3>
            <div className="pur-lines" role="table" aria-label={t.purLines}>
              <div className="pur-line pur-line-head" role="row">
                <span role="columnheader">{t.purColItem}</span>
                <span role="columnheader">{t.purColQty}</span>
                <span role="columnheader">{t.colUnit}</span>
                <span role="columnheader">{t.purColUnitPrice}</span>
                <span role="columnheader" className="num">{t.purColAmount}</span>
                <span />
              </div>
              {lines.map((l, i) => {
                const item = byId.get(l.stockId)
                return (
                  <div className="pur-line" role="row" key={l.key}>
                    <label className="pur-item">
                      <span className="pur-label">{t.purColItem}</span>
                      <select value={l.stockId} onChange={(e) => setLine(l.key, { stockId: e.target.value, unit: byId.get(e.target.value)?.purchase_unit ?? '' })}>
                        <option value="">{t.purChooseItem}</option>
                        {stock.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                      {item && <span className="muted small">{t.purInStock(`⁨${qtyText(item)}⁩`)}</span>}
                    </label>
                    <label>
                      <span className="pur-label">{t.purColQty}</span>
                      <input dir="ltr" inputMode="decimal" value={l.qty} placeholder="0" onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                    </label>
                    <label>
                      <span className="pur-label">{t.colUnit}</span>
                      {item?.unit && item.purchase_unit && item.purchase_factor ? (
                        <>
                          <select value={l.unit === item.purchase_unit ? l.unit : item.unit} onChange={(e) => setLine(l.key, { unit: e.target.value })}>
                            <option value={item.purchase_unit}>{item.purchase_unit}</option>
                            <option value={item.unit}>{item.unit}</option>
                          </select>
                          {l.unit === item.purchase_unit && parseNum(l.qty) != null && (
                            <span className="muted small" dir="ltr">= {qtyText(item, Math.round(parseNum(l.qty)! * item.purchase_factor * 1000) / 1000)}</span>
                          )}
                        </>
                      ) : item?.unit ? (
                        <input value={item.unit} readOnly tabIndex={-1} className="readonly" />
                      ) : (
                        <input value={l.unit} placeholder={t.stockUnitPh} onChange={(e) => setLine(l.key, { unit: e.target.value })} />
                      )}
                    </label>
                    <label>
                      <span className="pur-label">{t.purColUnitPrice}</span>
                      <input dir="ltr" inputMode="decimal" value={l.price} placeholder="0" onChange={(e) => setLine(l.key, { price: e.target.value })} />
                    </label>
                    <strong className="num pur-amount">{amounts[i] !== null ? money(amounts[i]!) : '—'}</strong>
                    <button type="button" className="ghost pur-remove" aria-label={t.purRemoveLine} title={t.purRemoveLine}
                      onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [emptyLine()]))}>✕</button>
                  </div>
                )
              })}
            </div>
            <div>
              <button type="button" onClick={() => setLines((ls) => [...ls, emptyLine()])}>{t.purAddLine}</button>
            </div>

            <div className="pur-total">
              <span>{t.purTotal}</span>
              <strong>{money(total)}</strong>
            </div>

            {editing ? (
              <div className="pur-payment">
                {editing.invoice.paid_amount > 0 && (
                  <p className="small">{t.purEditPaid(money(editing.invoice.paid_amount))} {total > 0 && t.purLeftToPay(money(Math.max(0, round2(total - editing.invoice.paid_amount))))}</p>
                )}
                <label className="pur-reason">
                  {t.purCancelReason}
                  <textarea rows={2} maxLength={300} value={reason} placeholder={t.purEditReasonPh} onChange={(e) => setReason(e.target.value)} />
                </label>
              </div>
            ) : (
              <div className="pur-payment">
                <span className="pur-label-block">{t.purPayment}</span>
                <div className="segmented" role="radiogroup" aria-label={t.purPayment}>
                  {(['paid', 'unpaid', 'partial'] as const).map((s) => (
                    <button key={s} type="button" role="radio" aria-checked={status === s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>
                      {t.purStatus[s]}
                    </button>
                  ))}
                </div>
                {status === 'partial' && (
                  <label className="pur-paid">
                    {t.purPaidNow}
                    <input dir="ltr" inputMode="decimal" value={paidText} placeholder="0" autoFocus onChange={(e) => setPaidText(e.target.value)} />
                  </label>
              )}
              {paid !== null && paid >= 0 && paid <= total && total > 0 && (
                <p className="muted small">{t.purLeftToPay(money(round2(total - paid)))}</p>
              )}
            </div>
            )}

            <p className="muted small">{editing ? t.purEditStockHint : t.purStockHint}</p>
            {shortages && (
              <ShortageWarning shortages={shortages} busy={busy} onConfirm={() => save(null, true)} onCancel={() => setShortages(null)} />
            )}
            <div className="dialog-actions">
              {editing ? <button type="button" onClick={onCancel}>{t.cancel}</button> : <button type="button" onClick={reset}>{t.purReset}</button>}
              <div className="spacer" />
              <button type="submit" className="primary" disabled={busy || !!shortages}>{busy ? t.saving : editing ? t.purEditSave : t.purValidate}</button>
            </div>
          </form>
        )}
      </section>
    </main>
  )
}

// ───────────── Liste des factures fournisseurs ─────────────

type StatusFilter = 'all' | 'toPay' | SupplierPaymentStatus
type View = 'active' | 'cancelled'
const supplierKey = (i: SupplierInvoice) => i.supplier_id ?? `name:${i.supplier_name}`

interface ListProps {
  /** The invoice just created from Effectuer un achat, highlighted and announced. */
  highlight?: SupplierInvoice | null
}

/**
 * Factures fournisseurs: Actives or Annulées, filters by status and supplier, Régler on what is not paid; unfolded, an
 * invoice offers Modifier, Retour fournisseur and Annuler la facture (permission purchase_cancel).
 */
export function InvoicesList({ highlight }: ListProps) {
  const { t } = useI18n()
  const load = useCallback(() => purchases.listInvoices(), [])
  const { data, error, setError, reload } = useLoad(load)
  const [version, setVersion] = useState(0)
  useEffect(() => purchases.subscribe(() => { reload(); setVersion((v) => v + 1) }), [reload])
  const [view, setView] = useState<View>('active')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [supplier, setSupplier] = useState('')
  const [open, setOpen] = useState<string | null>(highlight?.id ?? null)
  const [paying, setPaying] = useState<SupplierInvoice | null>(null)
  const [cancelling, setCancelling] = useState<SupplierInvoice | null>(null)
  const [returning, setReturning] = useState<{ invoice: SupplierInvoice; items: SupplierInvoiceItem[] } | null>(null)
  const [editing, setEditing] = useState<{ invoice: SupplierInvoice; items: SupplierInvoiceItem[] } | null>(null)
  const [notice, setNotice] = useState(highlight ? t.purSaved(highlight.supplier_name, money(highlight.total_amount)) : null)

  const changed = () => {
    reload()
    setVersion((v) => v + 1)
  }

  const byId = useMemo(() => new Map((data ?? []).map((i) => [i.id, i])), [data])
  const suppliers = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of data ?? []) m.set(supplierKey(i), i.supplier_name)
    return [...m].sort((a, b) => a[1].localeCompare(b[1]))
  }, [data])
  const cancelledCount = (data ?? []).filter(isCancelled).length
  const rows = (data ?? []).filter((i) =>
    (view === 'cancelled') === isCancelled(i)
    && (view === 'cancelled' || status === 'all' || (status === 'toPay' ? remaining(i) > 0 : i.payment_status === status))
    && (!supplier || supplierKey(i) === supplier))
  const sum = (f: (i: SupplierInvoice) => number) => round2(rows.reduce((s, i) => s + f(i), 0))

  if (editing) {
    return (
      <NewPurchasePage editing={editing} onCancel={() => setEditing(null)}
        onSaved={(inv) => {
          setNotice(t.purReplaced(invoiceNo(editing.invoice), invoiceNo(inv)))
          setEditing(null)
          setView('active')
          setOpen(inv.id)
          changed()
        }} />
    )
  }

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {notice && <div className="banner ok" onClick={() => setNotice(null)}>{notice}</div>}
      <div className="bo-toolbar pur-filters">
        <div className="segmented" role="radiogroup" aria-label={t.purViewLabel}>
          {(['active', 'cancelled'] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {t.purViews[v]}{v === 'cancelled' && cancelledCount > 0 ? ` (${cancelledCount})` : ''}
            </button>
          ))}
        </div>
        {view === 'active' && (
          <label>
            {t.purFilterStatus}
            <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="all">{t.purAllStatuses}</option>
              <option value="toPay">{t.purToPay}</option>
              {SUPPLIER_PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{t.purStatus[s]}</option>)}
            </select>
          </label>
        )}
        <label>
          {t.purFilterSupplier}
          <select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
            <option value="">{t.purAllSuppliers}</option>
            {suppliers.map(([k, name]) => <option key={k} value={k}>{name}</option>)}
          </select>
        </label>
      </div>

      {!data ? (
        !error && <div className="center muted">{t.loading}</div>
      ) : (
        <>
          {view === 'active' && (
            <section className="stat-tiles" aria-live="polite">
              <div className="stat-tile">
                <span className="muted small">{t.purSumTotal}</span>
                <strong>{money(sum(netTotal))}</strong>
              </div>
              <div className="stat-tile">
                <span className="muted small">{t.purSumPaid}</span>
                <strong>{money(sum((i) => i.paid_amount))}</strong>
              </div>
              <div className="stat-tile main">
                <span className="muted small">{t.purSumLeft}</span>
                <strong>{money(sum(remaining))}</strong>
              </div>
            </section>
          )}

          <section className="panel">
            {data.length === 0 ? (
              <p className="muted small">{t.purNone}</p>
            ) : rows.length === 0 ? (
              <p className="muted small">{view === 'cancelled' ? t.purNoneCancelled : t.noMatch}</p>
            ) : (
              <table className="bo-table payroll-table invoices-table">
                <thead>
                  <tr>
                    <th>{t.purColSupplier}</th>
                    <th>{t.purColDate}</th>
                    <th className="num">{t.purColTotal}</th>
                    <th className="num">{t.purColPaid}</th>
                    <th>{t.purColStatus}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
                    <InvoiceLine key={i.id} invoice={i} byId={byId} version={version} open={open === i.id} highlight={i.id === highlight?.id}
                      onToggle={() => setOpen(open === i.id ? null : i.id)} onPay={() => setPaying(i)} onError={setError}
                      onCancel={() => setCancelling(i)} onEdit={(items) => setEditing({ invoice: i, items })}
                      onReturn={(items) => setReturning({ invoice: i, items })} />
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted small">{t.purNote}</p>
          </section>
        </>
      )}

      {paying && (
        <PayDialog invoice={paying} onClose={() => setPaying(null)}
          onSaved={(inv) => { setPaying(null); setNotice(null); setOpen(inv.id); changed() }} />
      )}
      {cancelling && (
        <CancelInvoiceDialog invoice={cancelling} onClose={() => setCancelling(null)}
          onSaved={(inv) => {
            setCancelling(null)
            setNotice(t.purCancelled(invoiceNo(inv), (inv.cancel_cash_refund ?? 0) > 0 ? money(inv.cancel_cash_refund!) : null))
            setOpen(inv.id)
            changed()
          }} />
      )}
      {returning && (
        <ReturnDialog invoice={returning.invoice} items={returning.items} onClose={() => setReturning(null)}
          onSaved={() => { setReturning(null); setNotice(t.purReturnSaved); changed() }} />
      )}
    </main>
  )
}

interface LineProps {
  invoice: SupplierInvoice
  /** Every invoice, for « remplace la facture n° X ». */
  byId: Map<string, SupplierInvoice>
  version: number
  open: boolean
  highlight: boolean
  onToggle(): void
  onPay(): void
  onCancel(): void
  onEdit(items: SupplierInvoiceItem[]): void
  onReturn(items: SupplierInvoiceItem[]): void
  onError(message: string): void
}

/** One invoice; unfolds into its lines, payments, retours and actions. */
function InvoiceLine({ invoice: i, byId, version, open, highlight, onToggle, onPay, onCancel, onEdit, onReturn, onError }: LineProps) {
  const { t, lang } = useI18n()
  const { can } = usePermissions()
  const day = useDay()
  const [details, setDetails] = useState<InvoiceDetails | null>(null)
  const cancelled = isCancelled(i)
  const left = remaining(i)
  const owed = credit(i)
  const replaces = i.replaces_invoice_id ? byId.get(i.replaces_invoice_id) : undefined
  const replacedBy = i.replaced_by_invoice_id ? byId.get(i.replaced_by_invoice_id) : undefined

  useEffect(() => {
    if (!open) return
    let live = true
    purchases.details(i.id).then((d) => live && setDetails(d), (e) => onError(errorText(e)))
    return () => {
      live = false
    }
  }, [open, i.id, version, onError])

  const canReturn = details?.items.some((it) => it.quantity > (it.returned_quantity ?? 0))

  return (
    <>
      <tr className={[highlight && 'highlight', cancelled && 'cancelled'].filter(Boolean).join(' ') || undefined}>
        <td className="payroll-name">
          <button className="ghost link" onClick={onToggle} aria-expanded={open}>
            <span aria-hidden>{open ? '▾' : lang === 'ar' ? '◂' : '▸'}</span> <bdi>{i.supplier_name}</bdi>
            {i.number ? <span className="muted small"> · {invoiceNo(i)}</span> : null}
          </button>
          {replaces && <div className="muted small">{t.purReplaces(invoiceNo(replaces))}</div>}
        </td>
        <td data-label={t.purColDate}>{day(i.date)}</td>
        <td className="num strong" data-label={t.purColTotal}>
          {cancelled ? <s>{money(i.total_amount)}</s> : money(netTotal(i))}
          {!cancelled && (i.returned_amount ?? 0) > 0 && <div className="muted small">{t.purAfterReturn(money(i.total_amount))}</div>}
        </td>
        <td className="num" data-label={t.purColPaid}>{i.paid_amount ? money(i.paid_amount) : '—'}</td>
        <td data-label={t.purColStatus}>
          {cancelled ? <span className="tag pay-status cancelled">{t.purCancelledTag}</span> : <StatusTag status={i.payment_status} />}
        </td>
        <td className="row-actions">
          {!cancelled && left > 0 && <button className="primary" onClick={onPay}>{t.purPay}</button>}
        </td>
      </tr>
      {open && (
        <tr className="payroll-history">
          <td colSpan={6}>
            {!details ? (
              <p className="muted small">{t.loading}</p>
            ) : (
              <>
                {cancelled && (
                  <div className="banner warn pur-cancel-info">
                    <strong>{t.purCancelledOn(i.cancelled_at ? new Date(i.cancelled_at).toLocaleString(lang === 'ar' ? 'ar-DZ' : 'fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '', i.cancelled_by_name ?? '')}</strong>
                    <span>{t.purCancelReason} : <bdi>{i.cancel_reason}</bdi></span>
                    {replacedBy && <span>{t.purReplacedBy(invoiceNo(replacedBy))}</span>}
                    {(i.cancel_cash_refund ?? 0) > 0 && <span>{t.purCashRefunded(money(i.cancel_cash_refund!))}</span>}
                  </div>
                )}
                <div className="invoice-details">
                  <div>
                    <h4>{t.purInvoiceLines}</h4>
                    <ul className="advance-list invoice-items">
                      {details.items.map((it) => (
                        <li key={it.id}>
                          <span>
                            <bdi>{it.item_name}</bdi>
                            {(it.returned_quantity ?? 0) > 0 && <span className="muted small"> · {t.purReturnedQty(qtyText({ quantity: it.returned_quantity!, unit: it.unit }))}</span>}
                          </span>
                          <span className="muted" dir="ltr">{qtyText({ quantity: it.quantity, unit: it.unit })} × {money(it.unit_price)}</span>
                          <strong className="num">{money(lineTotal(it))}</strong>
                        </li>
                      ))}
                    </ul>
                    {details.returns.length > 0 && (
                      <>
                        <h4>{t.purReturns}</h4>
                        <ul className="advance-list invoice-payments">
                          {details.returns.map((r) => (
                            <li key={r.id}>
                              <span>
                                {day(r.date)} · <bdi>{r.reason}</bdi>
                                <span className="muted small"> · {r.items.map((x) => `${x.item_name} ${qtyText({ quantity: x.quantity, unit: x.unit })}`).join(', ')}</span>
                              </span>
                              <strong className="num neg">−{money(r.amount)}</strong>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                  <div>
                    <h4>{t.purInvoicePayments}</h4>
                    {details.payments.length === 0 ? (
                      <p className="muted small">{replacedBy && i.paid_amount === 0 ? t.purPaymentsMoved(invoiceNo(replacedBy)) : t.purNoPayments}</p>
                    ) : (
                      <ul className="advance-list invoice-payments">
                        {details.payments.map((p) => (
                          <li key={p.id}>
                            <span>{day(p.date)}</span>
                            <strong className="num">{money(p.amount)}</strong>
                          </li>
                        ))}
                      </ul>
                    )}
                    {!cancelled && left > 0 && <p className="small"><strong>{t.purLeftToPay(money(left))}</strong></p>}
                    {!cancelled && owed > 0 && <p className="small"><strong>{t.purCredit(money(owed))}</strong></p>}
                  </div>
                </div>
                {!cancelled && can('purchase_cancel') && (
                  <div className="pur-invoice-actions">
                    {can('purchases') && (i.returned_amount ?? 0) === 0 && <button onClick={() => onEdit(details.items)}>{t.purEdit}</button>}
                    {canReturn && <button onClick={() => onReturn(details.items)}>{t.purReturn}</button>}
                    <button className="danger" onClick={onCancel}>{t.purCancelInvoice}</button>
                  </div>
                )}
              </>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

/** Article par article: what the Dépôt cannot give back, and what will come out of the Cuisine instead. */
function ShortageWarning({ shortages, busy, onConfirm, onCancel }: { shortages: DepotShortage[]; busy: boolean; onConfirm(): void; onCancel(): void }) {
  const { t } = useI18n()
  return (
    <div className="banner warn pur-shortage" role="alert">
      <strong>{t.purShortageTitle}</strong>
      <table className="bo-table">
        <thead>
          <tr>
            <th>{t.stateColArticle}</th>
            <th className="num">{t.purShortNeeded}</th>
            <th className="num">{t.stockLocation.depot}</th>
            <th className="num">{t.purShortFromKitchen}</th>
            <th className="num">{t.purShortKitchenAfter}</th>
          </tr>
        </thead>
        <tbody>
          {shortages.map((s) => {
            const fromKitchen = round3(s.needed - Math.max(s.depot, 0))
            const after = round3(s.kitchen - fromKitchen)
            return (
              <tr key={s.item}>
                <td><bdi>{s.item}</bdi></td>
                <td className="num"><bdi>{qtyText({ quantity: s.needed, unit: s.unit })}</bdi></td>
                <td className="num"><bdi>{qtyText({ quantity: s.depot, unit: s.unit })}</bdi></td>
                <td className="num"><bdi>{qtyText({ quantity: fromKitchen, unit: s.unit })}</bdi></td>
                <td className="num"><bdi className={after < 0 ? 'neg' : undefined}>{qtyText({ quantity: after, unit: s.unit })}</bdi></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <span className="small">{t.purShortageHint}</span>
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>{t.purShortageBack}</button>
        <button type="button" className="danger" disabled={busy} onClick={onConfirm}>{busy ? t.saving : t.purShortageConfirm}</button>
      </div>
    </div>
  )
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** Annuler la facture: reason required; asks again, article by article, when the Dépôt no longer has the quantities. */
function CancelInvoiceDialog({ invoice, onClose, onSaved }: { invoice: SupplierInvoice; onClose(): void; onSaved(invoice: SupplierInvoice): void }) {
  const { t } = useI18n()
  const day = useDay()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [shortages, setShortages] = useState<DepotShortage[] | null>(null)
  const [busy, setBusy] = useState(false)

  async function save(e: FormEvent | null, force = false) {
    e?.preventDefault()
    if (!reason.trim()) return setError(t.errCancelReasonRequired)
    setBusy(true)
    setError(null)
    try {
      onSaved(await purchases.cancel(invoice.id, reason, force))
    } catch (err) {
      if (err instanceof DepotShortageError) setShortages(err.shortages)
      else setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog pur-cancel-dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-inv-title" onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2 id="cancel-inv-title">{t.purCancelTitle(invoiceNo(invoice), invoice.supplier_name, day(invoice.date))}</h2>
        {error && <p className="error small" role="alert">{error}</p>}
        <p className="small">{t.purColTotal} : <strong>{money(netTotal(invoice))}</strong>{invoice.paid_amount > 0 && <> · {t.purColPaid} : <strong>{money(invoice.paid_amount)}</strong></>}</p>
        <ul className="small pur-cancel-effects">
          <li>{t.purCancelStock}</li>
          {invoice.paid_amount > 0 && <li>{t.purCancelCash}</li>}
          <li>{t.purCancelKept}</li>
        </ul>
        <label>
          {t.purCancelReason}
          <textarea autoFocus rows={2} maxLength={300} value={reason} placeholder={t.purCancelReasonPh} onChange={(e) => setReason(e.target.value)} />
        </label>
        {shortages ? (
          <ShortageWarning shortages={shortages} busy={busy} onConfirm={() => save(null, true)} onCancel={onClose} />
        ) : (
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>{t.cancel}</button>
            <button type="submit" className="danger" disabled={busy}>{busy ? t.saving : t.purCancelInvoice}</button>
          </div>
        )}
      </form>
    </div>
  )
}

/** Retour fournisseur: quantity sent back per line (at most what is left), reason; the amount comes off what is left to pay. */
function ReturnDialog({ invoice, items, onClose, onSaved }: { invoice: SupplierInvoice; items: SupplierInvoiceItem[]; onClose(): void; onSaved(): void }) {
  const { t } = useI18n()
  const [qty, setQty] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [shortages, setShortages] = useState<DepotShortage[] | null>(null)
  const [busy, setBusy] = useState(false)
  const open = items.filter((it) => it.quantity > (it.returned_quantity ?? 0))
  const left = (it: SupplierInvoiceItem) => round3(it.quantity - (it.returned_quantity ?? 0))
  const parsed = open.map((it) => ({ it, q: parseNum(qty[it.id] ?? '') }))
  const amount = round2(parsed.reduce((s, { it, q }) => s + (q && q > 0 ? lineTotal({ quantity: q, unit_price: it.unit_price }) : 0), 0))
  const newLeft = Math.max(0, round2(netTotal(invoice) - amount - invoice.paid_amount))

  async function save(e: FormEvent | null, force = false) {
    e?.preventDefault()
    const lines = []
    for (const { it, q } of parsed) {
      if (q === null) continue
      if (q < 0 || q > left(it)) return setError(t.errReturnTooMuch)
      if (q > 0) lines.push({ invoice_item_id: it.id, quantity: q })
    }
    if (!lines.length) return setError(t.errReturnEmpty)
    if (!reason.trim()) return setError(t.errCancelReasonRequired)
    setBusy(true)
    setError(null)
    try {
      await purchases.createReturn(invoice.id, lines, reason, force)
      onSaved()
    } catch (err) {
      if (err instanceof DepotShortageError) setShortages(err.shortages)
      else setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog pur-cancel-dialog" role="dialog" aria-modal="true" aria-labelledby="return-title" onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2 id="return-title">{t.purReturnTitle(invoiceNo(invoice), invoice.supplier_name)}</h2>
        {error && <p className="error small" role="alert">{error}</p>}
        <p className="muted small">{t.purReturnHint}</p>
        <div className="pur-return-lines">
          {open.map((it) => (
            <label key={it.id} className="pur-return-line">
              <span>
                <bdi>{it.item_name}</bdi>
                <span className="muted small" dir="ltr"> {t.purReturnMax(qtyText({ quantity: left(it), unit: it.unit }))} × {money(it.unit_price)}</span>
              </span>
              <input dir="ltr" inputMode="decimal" placeholder="0" value={qty[it.id] ?? ''} onChange={(e) => setQty((m) => ({ ...m, [it.id]: e.target.value }))} />
            </label>
          ))}
        </div>
        <div className="pur-total">
          <span>{t.purReturnAmount}</span>
          <strong>−{money(amount)}</strong>
        </div>
        {amount > 0 && <p className="small">{t.purLeftToPay(money(newLeft))}{invoice.paid_amount > round2(netTotal(invoice) - amount) && <> · {t.purCredit(money(round2(invoice.paid_amount - (netTotal(invoice) - amount))))}</>}</p>}
        <label>
          {t.purCancelReason}
          <textarea rows={2} maxLength={300} value={reason} placeholder={t.purReturnReasonPh} onChange={(e) => setReason(e.target.value)} />
        </label>
        {shortages ? (
          <ShortageWarning shortages={shortages} busy={busy} onConfirm={() => save(null, true)} onCancel={onClose} />
        ) : (
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>{t.cancel}</button>
            <button type="submit" className="primary" disabled={busy}>{busy ? t.saving : t.purReturnSave}</button>
          </div>
        )}
      </form>
    </div>
  )
}

/** Régler/Payer: amount (what is left by default, or part of it) and the payment date. */
function PayDialog({ invoice, onClose, onSaved }: { invoice: SupplierInvoice; onClose(): void; onSaved(invoice: SupplierInvoice): void }) {
  const { t } = useI18n()
  const day = useDay()
  const left = remaining(invoice)
  const [value, setValue] = useState(String(left))
  const [date, setDate] = useState(todayIso)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const n = parseNum(value)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (n === null || n <= 0 || round2(n) > left) return setError(t.errPurchasePaid)
    if (!date) return setError(t.errPurchaseDate)
    setBusy(true)
    try {
      onSaved(await purchases.pay(invoice.id, n, date))
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="pay-title" onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2 id="pay-title">{t.purPayTitle(invoice.supplier_name, day(invoice.date))}</h2>
        {error && <p className="error small" role="alert">{error}</p>}
        <p className="muted small">{t.purColTotal} : {money(invoice.total_amount)} · {t.purLeftToPay(money(left))}</p>
        <div className="res-grid">
          <label>
            {t.purPayAmount}
            <span className="pur-pay-amount">
              <input autoFocus dir="ltr" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
              <button type="button" onClick={() => setValue(String(left))}>{t.purPayAll}</button>
            </span>
          </label>
          <label>
            {t.purPayDate}
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        {n !== null && n > 0 && round2(n) <= left && (
          <p className="small"><StatusTag status={round2(n) >= left ? 'paid' : 'partial'} /> {round2(n) < left && t.purLeftToPay(money(round2(left - n)))}</p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>{t.cancel}</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? t.saving : t.purPaySave}</button>
        </div>
      </form>
    </div>
  )
}

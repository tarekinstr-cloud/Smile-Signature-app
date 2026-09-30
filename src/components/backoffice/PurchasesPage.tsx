import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { backOffice } from '../../lib/backoffice'
import { lineTotal, purchases, remaining, round2 } from '../../lib/purchases'
import { todayIso } from '../../lib/payroll'
import { SUPPLIER_PAYMENT_STATUSES, type StockItem, type Supplier, type SupplierInvoice, type SupplierInvoiceItem, type SupplierPayment, type SupplierPaymentStatus } from '../../lib/types'
import { useI18n } from '../../lib/i18n'
import { money } from '../../lib/format'
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
  /** Typed only for an item without a unit; otherwise the item's unit. */
  unit: string
  price: string
}

const emptyLine = (): Line => ({ key: newId(), stockId: '', qty: '', unit: '', price: '' })

/** Effectuer un achat: supplier, date, lines from the stock, payment status. Validating creates the invoice and adds the quantities to the stock. */
export function NewPurchasePage({ onSaved }: { onSaved(invoice: SupplierInvoice): void }) {
  const { t } = useI18n()
  const load = useCallback(() => Promise.all([backOffice.listSuppliers(), backOffice.listStock()]), [])
  const { data, error: loadError, reload } = useLoad(load)
  useEffect(() => backOffice.subscribeStock(() => reload()), [reload])
  const [suppliers, stock]: [Supplier[], StockItem[]] = data ?? [[], []]

  const [supplierId, setSupplierId] = useState('')
  const [date, setDate] = useState(todayIso)
  const [lines, setLines] = useState<Line[]>(() => [emptyLine()])
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
  const paid = status === 'paid' ? total : status === 'unpaid' ? 0 : paidPartial

  const setLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  function reset() {
    setSupplierId('')
    setDate(todayIso())
    setLines([emptyLine()])
    setStatus('unpaid')
    setPaidText('')
    setError(null)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
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
      out.push({ stock_item_id: l.stockId, quantity: q, unit: item?.unit || l.unit, unit_price: p })
    }
    if (paid === null || paid < 0 || paid > total || (status === 'partial' && (paid <= 0 || paid >= total))) return setError(t.errPurchasePaid)
    setBusy(true)
    try {
      setError(null)
      const invoice = await purchases.createPurchase({ supplier_id: supplierId, date, lines: out, paid })
      reset()
      onSaved(invoice)
    } catch (err) {
      setError(errorText(err))
    }
    setBusy(false)
  }

  return (
    <main className="content bo-content">
      {loadError && <div className="banner error">{loadError}</div>}
      <section className="panel">
        <h2>{t.purNewItem}</h2>
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
                      <select value={l.stockId} onChange={(e) => setLine(l.key, { stockId: e.target.value })}>
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
                      {item?.unit ? (
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

            <p className="muted small">{t.purStockHint}</p>
            <div className="dialog-actions">
              <button type="button" onClick={reset}>{t.purReset}</button>
              <div className="spacer" />
              <button type="submit" className="primary" disabled={busy}>{busy ? t.saving : t.purValidate}</button>
            </div>
          </form>
        )}
      </section>
    </main>
  )
}

// ───────────── Liste des factures fournisseurs ─────────────

type StatusFilter = 'all' | 'toPay' | SupplierPaymentStatus
const supplierKey = (i: SupplierInvoice) => i.supplier_id ?? `name:${i.supplier_name}`

interface ListProps {
  /** The invoice just created from Effectuer un achat, highlighted and announced. */
  highlight?: SupplierInvoice | null
}

/** Factures fournisseurs: every invoice (unpaid first), filters by status and supplier, Régler on what is not paid. */
export function InvoicesList({ highlight }: ListProps) {
  const { t } = useI18n()
  const load = useCallback(() => purchases.listInvoices(), [])
  const { data, error, setError, reload } = useLoad(load)
  const [version, setVersion] = useState(0)
  useEffect(() => purchases.subscribe(() => { reload(); setVersion((v) => v + 1) }), [reload])
  const [status, setStatus] = useState<StatusFilter>('all')
  const [supplier, setSupplier] = useState('')
  const [open, setOpen] = useState<string | null>(highlight?.id ?? null)
  const [paying, setPaying] = useState<SupplierInvoice | null>(null)
  const [notice, setNotice] = useState(highlight ? t.purSaved(highlight.supplier_name, money(highlight.total_amount)) : null)

  const changed = () => {
    reload()
    setVersion((v) => v + 1)
  }

  const suppliers = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of data ?? []) m.set(supplierKey(i), i.supplier_name)
    return [...m].sort((a, b) => a[1].localeCompare(b[1]))
  }, [data])
  const rows = (data ?? []).filter((i) =>
    (status === 'all' || (status === 'toPay' ? i.payment_status !== 'paid' : i.payment_status === status))
    && (!supplier || supplierKey(i) === supplier))
  const sum = (f: (i: SupplierInvoice) => number) => round2(rows.reduce((s, i) => s + f(i), 0))

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {notice && <div className="banner ok" onClick={() => setNotice(null)}>{notice}</div>}
      <div className="bo-toolbar pur-filters">
        <label>
          {t.purFilterStatus}
          <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="all">{t.purAllStatuses}</option>
            <option value="toPay">{t.purToPay}</option>
            {SUPPLIER_PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{t.purStatus[s]}</option>)}
          </select>
        </label>
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
          <section className="stat-tiles" aria-live="polite">
            <div className="stat-tile">
              <span className="muted small">{t.purSumTotal}</span>
              <strong>{money(sum((i) => i.total_amount))}</strong>
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

          <section className="panel">
            {data.length === 0 ? (
              <p className="muted small">{t.purNone}</p>
            ) : rows.length === 0 ? (
              <p className="muted small">{t.noMatch}</p>
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
                    <InvoiceLine key={i.id} invoice={i} version={version} open={open === i.id} highlight={i.id === highlight?.id}
                      onToggle={() => setOpen(open === i.id ? null : i.id)} onPay={() => setPaying(i)} onError={setError} />
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
    </main>
  )
}

interface LineProps {
  invoice: SupplierInvoice
  version: number
  open: boolean
  highlight: boolean
  onToggle(): void
  onPay(): void
  onError(message: string): void
}

/** One invoice; unfolds into its lines and payments. */
function InvoiceLine({ invoice: i, version, open, highlight, onToggle, onPay, onError }: LineProps) {
  const { t, lang } = useI18n()
  const day = useDay()
  const [details, setDetails] = useState<{ items: SupplierInvoiceItem[]; payments: SupplierPayment[] } | null>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    purchases.details(i.id).then((d) => live && setDetails(d), (e) => onError(errorText(e)))
    return () => {
      live = false
    }
  }, [open, i.id, version, onError])

  return (
    <>
      <tr className={highlight ? 'highlight' : undefined}>
        <td className="payroll-name">
          <button className="ghost link" onClick={onToggle} aria-expanded={open}>
            <span aria-hidden>{open ? '▾' : lang === 'ar' ? '◂' : '▸'}</span> <bdi>{i.supplier_name}</bdi>
          </button>
        </td>
        <td data-label={t.purColDate}>{day(i.date)}</td>
        <td className="num strong" data-label={t.purColTotal}>{money(i.total_amount)}</td>
        <td className="num" data-label={t.purColPaid}>{i.paid_amount ? money(i.paid_amount) : '—'}</td>
        <td data-label={t.purColStatus}><StatusTag status={i.payment_status} /></td>
        <td className="row-actions">
          {i.payment_status !== 'paid' && <button className="primary" onClick={onPay}>{t.purPay}</button>}
        </td>
      </tr>
      {open && (
        <tr className="payroll-history">
          <td colSpan={6}>
            {!details ? (
              <p className="muted small">{t.loading}</p>
            ) : (
              <div className="invoice-details">
                <div>
                  <h4>{t.purInvoiceLines}</h4>
                  <ul className="advance-list invoice-items">
                    {details.items.map((it) => (
                      <li key={it.id}>
                        <bdi>{it.item_name}</bdi>
                        <span className="muted" dir="ltr">{qtyText({ quantity: it.quantity, unit: it.unit })} × {money(it.unit_price)}</span>
                        <strong className="num">{money(lineTotal(it))}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4>{t.purInvoicePayments}</h4>
                  {details.payments.length === 0 ? (
                    <p className="muted small">{t.purNoPayments}</p>
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
                  {i.payment_status !== 'paid' && <p className="small"><strong>{t.purLeftToPay(money(remaining(i)))}</strong></p>}
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
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

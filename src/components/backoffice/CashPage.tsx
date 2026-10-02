import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { cash } from '../../lib/cash'
import { expenses } from '../../lib/expenses'
import { purchases, remaining } from '../../lib/purchases'
import { download, stamp, toCsv } from '../../lib/admin'
import { csvDa, money } from '../../lib/format'
import { useI18n } from '../../lib/i18n'
import { usePermissions } from '../../lib/permissions'
import type { CashDay, CashMovement, CashMovementKind, ExpenseCategory, NumberReset, SupplierInvoice } from '../../lib/types'
import { useDialog } from '../Dialog'
import PeriodFilter, { initialPeriod, periodRange, rangeLabel, type Period } from './PeriodFilter'
import { parseAmount } from './StatsPage'
import { errorText, locale, useLoad } from './useLoad'

const whenText = (iso: string, lang: 'fr' | 'ar') =>
  new Date(iso).toLocaleString(locale(lang), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** Fond de caisse: opens the working day with the cash in the drawer, or corrects it while the day is open. */
export function CashFloatPage({ onOpenStats }: { onOpenStats?(): void }) {
  const { t, lang } = useI18n()
  const { data: day, error, setError, reload } = useLoad(cash.currentDay)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  useEffect(() => cash.subscribe(reload), [reload])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const n = parseAmount(amount)
    if (n === null || n < 0) return setError(t.errCashAmount)
    setBusy(true)
    try {
      setError(null)
      if (day) {
        await cash.setFloat(n)
        setNotice(t.floatUpdated(money(n)))
        setEditing(false)
      } else {
        const d = await cash.openDay(n)
        setNotice(t.dayOpened(d.day_no, money(n)))
      }
      setAmount('')
      reload()
    } catch (err) {
      setError(errorText(err))
    }
    setBusy(false)
  }

  const form = (label: string, button: string) => (
    <form className="res-form cash-form" onSubmit={submit}>
      <label>
        {label}
        <input autoFocus dir="ltr" inputMode="decimal" value={amount} placeholder="0" onChange={(e) => setAmount(e.target.value)} />
      </label>
      <div className="dialog-actions">
        {day && <button type="button" onClick={() => { setEditing(false); setAmount('') }}>{t.cancel}</button>}
        <button type="submit" className="primary" disabled={busy || parseAmount(amount) === null}>{busy ? t.saving : button}</button>
      </div>
    </form>
  )

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {notice && <div className="banner ok" role="status" onClick={() => setNotice(null)}>{notice}</div>}
      <section className="panel">
        {day === null && !error ? (
          <>
            <h2>{t.dayNotOpen}</h2>
            <p className="muted small">{t.floatIntro}</p>
            {form(t.floatAmount, t.floatOpen)}
            <p className="muted small">{t.floatResetNote}</p>
          </>
        ) : day ? (
          <>
            <div className="panel-head">
              <h2>{t.dayNo(day.day_no)}</h2>
              <span className="tag day-open-tag">{t.dayOpenTag}</span>
            </div>
            <div className="float-amount">
              <span className="muted small">{t.floatLabel}</span>
              <strong>{money(day.opening_float)}</strong>
            </div>
            <p className="small">{t.dayOpenedBy(whenText(day.opened_at, lang), day.opened_by_name || '—')}</p>
            {day.float_updated_at && (
              <p className="muted small">{t.floatCorrected(whenText(day.float_updated_at, lang), day.float_updated_by_name || '—')}</p>
            )}
            {editing ? form(t.floatNewAmount, t.save) : (
              <div className="bo-toolbar">
                <button type="button" onClick={() => setEditing(true)}>{t.floatCorrect}</button>
                {onOpenStats && <button type="button" onClick={onOpenStats}>{t.dailyStatsTitle}</button>}
              </div>
            )}
          </>
        ) : null}
      </section>
    </main>
  )
}

/** Fond d'entrée / Fond de sortie: the form (open day only), then the list over a period with its total and CSV. */
export function CashMovesPage({ kind, onOpenFloat }: { kind: CashMovementKind; onOpenFloat?(): void }) {
  const { t, lang } = useI18n()
  const { can } = usePermissions()
  const dayLoad = useLoad(cash.currentDay)
  const day = dayLoad.data
  const [period, setPeriod] = useState<Period>(() => initialPeriod('day'))
  const range = useMemo(() => periodRange(period, day?.period_start), [period, day?.period_start])
  const load = useCallback(
    () => (period.preset === 'day' ? (day ? cash.movements({ dayId: day.id }) : Promise.resolve([])) : cash.movements({ from: range[0], to: range[1] }))
      .then((ms) => ms.filter((m) => m.kind === kind).reverse()),
    [period.preset, day, range, kind],
  )
  const { data, error, setError, reload } = useLoad(load)
  const dialog = useDialog()
  const reloadDay = dayLoad.reload
  useEffect(() => cash.subscribe(() => { reloadDay(); reload() }), [reload, reloadDay])

  /** Fonds de sortie: all, only the vidanges (coffre), or the other outs. */
  const [show, setShow] = useState<'all' | 'drops' | 'others'>('all')
  const rows = (data ?? []).filter((m) => show === 'all' || (show === 'drops') === !!m.is_drop)
  const total = rows.reduce((s, m) => s + m.amount, 0)

  async function remove(m: CashMovement) {
    if (!(await dialog.confirm(t.cashDeleteConfirm(money(m.amount))))) return
    try {
      await cash.deleteMovement(m.id)
      reload()
    } catch (err) {
      setError(errorText(err))
    }
  }

  const exportCsv = () => download(`${kind === 'in' ? 'fonds-entree' : 'fonds-sortie'}-${stamp()}.csv`, toCsv(rows.map((m) => ({
    [t.colDate]: new Date(m.created_at).toLocaleString(locale(lang)), [t.colAmount]: csvDa(m.amount), [t.cashReason]: m.reason,
    [t.cashInvoiceCol]: m.supplier_name ?? '', [t.colEmployee]: m.user_name, [t.dropTag]: m.is_drop ? '✓' : '',
  }))), 'text/csv;charset=utf-8')

  return (
    <main className="content bo-content">
      {(error || dayLoad.error) && <div className="banner error" onClick={() => { setError(null); dayLoad.setError(null) }}>{error ?? dayLoad.error}</div>}
      {day === null && !dayLoad.error ? (
        <section className="panel">
          <h2>{t.dayNotOpen}</h2>
          <p className="muted small">{t.cashNeedOpenDay}</p>
          {onOpenFloat && can('cash_open') && <div><button type="button" className="primary" onClick={onOpenFloat}>{t.floatTitle}</button></div>}
        </section>
      ) : day ? (
        <MoveForm kind={kind} day={day} canPayInvoice={kind === 'out' && can('purchases')} onSaved={reload} />
      ) : null}

      <section className="panel">
        <div className="bo-toolbar">
          <h2>{kind === 'in' ? t.cashInList : t.cashOutList}</h2>
          <div className="spacer" />
          <button type="button" onClick={exportCsv} disabled={!rows.length}>{t.exportCsv}</button>
        </div>
        <div className="bo-toolbar">
          <PeriodFilter value={period} onChange={setPeriod} />
          <span className="muted small">{period.preset === 'day' ? (day ? t.dayNo(day.day_no) : t.dayNotOpen) : rangeLabel(range, locale(lang))}</span>
          {kind === 'out' && (
            <select className="auto-width" value={show} aria-label={t.dropFilter} onChange={(e) => setShow(e.target.value as typeof show)}>
              <option value="all">{t.dropAll}</option>
              <option value="drops">{t.dropOnly}</option>
              <option value="others">{t.dropOthers}</option>
            </select>
          )}
        </div>
        {!data ? (
          !error && <p className="muted">{t.loading}</p>
        ) : !rows.length ? (
          <p className="muted small">{t.cashNone}</p>
        ) : (
          <table className="bo-table">
            <thead>
              <tr>
                <th>{t.colDate}</th>
                <th className="num">{t.colAmount}</th>
                <th>{t.cashReason}</th>
                <th>{t.colEmployee}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td>{whenText(m.created_at, lang)}</td>
                  <td className="num"><strong>{money(m.amount)}</strong></td>
                  <td>
                    <bdi>{m.reason}</bdi>
                    {m.is_drop && <> <span className="tag">{t.dropTag}</span></>}
                    {m.supplier_name && <div className="muted small">{m.kind === 'in' ? t.cashRefundInvoice(m.supplier_name) : t.cashPaidInvoice(m.supplier_name)}</div>}
                  </td>
                  <td>{m.user_name || '—'}</td>
                  <td className="end">
                    {day && m.day_id === day.id && !m.supplier_invoice_id && can(kind === 'in' ? 'cash_in' : 'cash_out') && (
                      <button type="button" className="ghost" onClick={() => remove(m)} aria-label={t.delete} title={t.delete}>🗑</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="total">
                <td>{t.total}</td>
                <td className="num">{money(total)}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        )}
      </section>
      {dialog.element}
    </main>
  )
}

function MoveForm({ kind, day, canPayInvoice, onSaved }: { kind: CashMovementKind; day: CashDay; canPayInvoice: boolean; onSaved(): void }) {
  const { t } = useI18n()
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [invoiceId, setInvoiceId] = useState('')
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([])
  const [categoryId, setCategoryId] = useState('')
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  /** Vidange (coffre): cash to the safe, neither an expense nor an invoice payment. */
  const [drop, setDrop] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const loadInvoices = useCallback(() => {
    if (canPayInvoice) purchases.listInvoices().then((l) => setInvoices(l.filter((i) => remaining(i) > 0)), () => setInvoices([]))
  }, [canPayInvoice])
  useEffect(loadInvoices, [loadInvoices])
  useEffect(() => {
    if (kind === 'out') expenses.categories().then((l) => setCategories(l.filter((c) => c.active)), () => setCategories([]))
  }, [kind])
  const invoice = drop ? null : invoices.find((i) => i.id === invoiceId) ?? null
  const presets = kind === 'in' ? t.cashInPresets : t.cashOutPresets

  async function submit(e: FormEvent) {
    e.preventDefault()
    setNotice(null)
    const n = parseAmount(amount)
    if (n === null || n <= 0) return setError(t.errCashAmount)
    if (invoice && n > remaining(invoice) + 0.001) return setError(t.errPayAmount)
    const category = !invoice && !drop ? categories.find((c) => c.id === categoryId) : undefined
    if (!reason.trim() && !invoice && !category && !drop) return setError(t.errCashReason)
    setBusy(true)
    try {
      setError(null)
      const m = await cash.addMovement({
        kind, amount: n, reason: reason.trim() || (drop ? t.dropReason : invoice ? t.cashInvoiceReason(invoice.supplier_name) : category?.name ?? ''), supplier_invoice_id: invoice?.id ?? null,
        expense_category_id: !invoice && !drop && categoryId ? categoryId : null, is_drop: drop,
      })
      setNotice(kind === 'in' ? t.cashInSaved(money(m.amount)) : t.cashOutSaved(money(m.amount)))
      setAmount('')
      setReason('')
      setInvoiceId('')
      setCategoryId('')
      setDrop(false)
      loadInvoices()
      onSaved()
    } catch (err) {
      setError(errorText(err))
    }
    setBusy(false)
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{kind === 'in' ? t.cashInNew : t.cashOutNew}</h2>
        <span className="muted small">{t.dayNo(day.day_no)}</span>
      </div>
      {notice && <div className="banner ok" role="status" onClick={() => setNotice(null)}>{notice}</div>}
      <form className="res-form" onSubmit={submit}>
        {error && <p className="error small" role="alert">{error}</p>}
        {kind === 'out' && (
          <label className="check">
            <input type="checkbox" checked={drop} onChange={(e) => { setDrop(e.target.checked); setInvoiceId(''); setCategoryId('') }} />
            <span><strong>{t.dropReason}</strong> <span className="muted small">— {t.dropHint}</span></span>
          </label>
        )}
        {canPayInvoice && !drop && invoices.length > 0 && (
          <label>
            {t.cashPayInvoice}
            <select value={invoiceId} onChange={(e) => {
              const inv = invoices.find((i) => i.id === e.target.value)
              setInvoiceId(e.target.value)
              if (inv) setAmount(String(remaining(inv)))
            }}>
              <option value="">{t.cashNoInvoice}</option>
              {invoices.map((i) => (
                <option key={i.id} value={i.id}>{i.supplier_name} · {i.date} · {t.cashInvoiceLeft(money(remaining(i)))}</option>
              ))}
            </select>
          </label>
        )}
        {kind === 'out' && !invoice && !drop && categories.length > 0 && (
          <label>
            {t.cashExpenseCategory} ({t.optional})
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">{t.cashNoExpense}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <div className="res-grid">
          <label>
            {t.colAmount}
            <input dir="ltr" inputMode="decimal" value={amount} placeholder="0" onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label>
            {t.cashReason}{invoice || drop ? ` (${t.optional})` : ''}
            <input value={reason} placeholder={drop ? t.dropReason : invoice ? t.cashInvoiceReason(invoice.supplier_name) : kind === 'in' ? t.cashReasonPh : t.cashReasonOutPh} maxLength={300}
              onChange={(e) => setReason(e.target.value)} />
          </label>
        </div>
        {!invoice && !drop && (
          <div className="chip-row">
            {presets.map((p) => (
              <button key={p} type="button" className={`chip${reason === p ? ' on' : ''}`} onClick={() => setReason(p)}>{p}</button>
            ))}
          </div>
        )}
        <div className="dialog-actions">
          <div className="spacer" />
          <button type="submit" className="primary" disabled={busy}>{busy ? t.saving : t.save}</button>
        </div>
      </form>
    </section>
  )
}

/** Re-Initialiser le N° des Commandes: explanation, confirmation, and the last resets. */
export function ResetNumbersPage() {
  const { t, lang } = useI18n()
  const { data, error, setError, reload } = useLoad(cash.lastResets)
  const dialog = useDialog()
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run() {
    if (!(await dialog.confirm(t.resetConfirm, t.resetBtn))) return
    setBusy(true)
    try {
      setError(null)
      await cash.resetNumbers()
      setNotice(t.resetDone)
      reload()
    } catch (err) {
      setError(errorText(err))
    }
    setBusy(false)
  }

  const last = (r: NumberReset) => [
    r.last_ticket_no != null && t.resetLastTicket(r.last_ticket_no),
    r.last_takeaway_no != null && t.resetLastTakeaway(r.last_takeaway_no),
    r.last_delivery_no != null && t.resetLastDelivery(r.last_delivery_no),
  ].filter(Boolean).join(' · ') || '—'

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {notice && <div className="banner ok" role="status" onClick={() => setNotice(null)}>{notice}</div>}
      <section className="panel">
        <h2>{t.resetTitle}</h2>
        <p className="small">{t.resetIntro}</p>
        <ul className="small reset-points">
          {t.resetPoints.map((p) => <li key={p}>{p}</li>)}
        </ul>
        <div><button type="button" className="danger solid" onClick={run} disabled={busy}>{t.resetBtn}</button></div>
      </section>
      <section className="panel">
        <h2>{t.resetHistory}</h2>
        {!data ? (
          !error && <p className="muted">{t.loading}</p>
        ) : !data.length ? (
          <p className="muted small">{t.resetNone}</p>
        ) : (
          <table className="bo-table">
            <thead>
              <tr>
                <th>{t.colDate}</th>
                <th>{t.resetReasonCol}</th>
                <th>{t.resetBefore}</th>
                <th>{t.colEmployee}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td>{whenText(r.created_at, lang)}</td>
                  <td>{t.resetReasons[r.reason]}</td>
                  <td className="small">{last(r)}</td>
                  <td>{r.user_name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {dialog.element}
    </main>
  )
}

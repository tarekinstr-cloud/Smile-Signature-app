import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { cash } from '../../lib/cash'
import { repo } from '../../lib/repo'
import { reportCsvRows } from '../../lib/dayReport'
import { loadLive } from '../../lib/liveDay'
import { download, stamp, toCsv } from '../../lib/admin'
import { csvDa, money } from '../../lib/format'
import { useI18n } from '../../lib/i18n'
import { usePermissions } from '../../lib/permissions'
import type { CashDay, SalesData } from '../../lib/types'
import { PaidTicketsTable, paidTickets } from './ControlPages'
import PeriodFilter, { initialPeriod, periodRange, rangeLabel, type Period } from './PeriodFilter'
import { DayReportView, ZDialog, gapClass, gapText } from './DayReportView'
import { errorText, locale, useLoad } from './useLoad'

/** Parses a DA amount typed with a comma or a dot; null when it is not a number. */
export const parseAmount = (text: string) => {
  const n = Number(text.replace(/\s/g, '').replace(',', '.'))
  return text.trim() && Number.isFinite(n) ? n : null
}

/** Calls `fn` at most once per `ms` while events keep coming (payments on several tablets). */
function useThrottled(fn: () => void, ms: number) {
  const last = useRef(0)
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  return useCallback(() => {
    if (timer.current) return
    const wait = Math.max(0, last.current + ms - Date.now())
    timer.current = window.setTimeout(() => {
      timer.current = null
      last.current = Date.now()
      fn()
    }, wait)
  }, [fn, ms])
}

export type Tab = 'current' | 'closed'

/** Statistique Journalier: the day in progress (live), its closing, and the closed days. */
export default function StatsPage({ initialTab = 'current', initialPeriod: start }: { initialTab?: Tab; initialPeriod?: Period } = {}) {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>(initialTab)
  useEffect(() => setTab(initialTab), [initialTab])
  return (
    <main className="content bo-content">
      <div className="segmented bo-tabs inline-tabs" role="tablist" aria-label={t.dailyStatsTitle}>
        {(['current', 'closed'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {k === 'current' ? t.dayCurrentTab : t.dayClosedTab}
          </button>
        ))}
      </div>
      {tab === 'current' ? <CurrentDay onClosed={() => setTab('closed')} /> : <ClosedDays start={start} />}
    </main>
  )
}

/** Commandes encaissées of the day in progress, each with « Annuler la facture » for the accounts allowed to. */
function PaidOrdersPanel({ sales, onDone }: { sales: SalesData; onDone(): void }) {
  const { t } = useI18n()
  const { orders, cashOf } = useMemo(() => paidTickets(sales), [sales])
  return (
    <section className="panel">
      <div className="panel-head"><h2>{t.dayPaidOrders(orders.length)}</h2></div>
      <PaidTicketsTable orders={orders} cashOf={cashOf} onDone={onDone} />
    </section>
  )
}

function CurrentDay({ onClosed }: { onClosed(): void }) {
  const { t, lang } = useI18n()
  const { can } = usePermissions()
  const { data, error, setError, reload } = useLoad(loadLive)
  const [closing, setClosing] = useState(false)
  const [z, setZ] = useState<CashDay | null>(null)
  const refresh = useThrottled(reload, 1500)
  // Payments and drawer movements on any tablet update the figures (shared « orders » and « cash » channels).
  useEffect(() => {
    const offOrders = repo.subscribeOrders(refresh)
    const offCash = cash.subscribe(refresh)
    return () => {
      offOrders()
      offCash()
    }
  }, [refresh])

  const when = (iso: string) => new Date(iso).toLocaleString(locale(lang), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const day = data?.day ?? null
  const exportCsv = () => data && download(`journee-${stamp()}.csv`, toCsv(reportCsvRows(data.report)), 'text/csv;charset=utf-8')

  return (
    <>
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {!data ? (
        !error && <div className="center muted">{t.loading}</div>
      ) : (
        <>
          <div className="bo-toolbar">
            <div className="day-state">
              {day ? (
                <>
                  <strong>{t.dayNo(day.day_no)}</strong>
                  <span className="muted small">{t.dayOpenedBy(when(day.opened_at), day.opened_by_name || '—')}</span>
                  {new Date(day.period_start).getTime() < new Date(day.opened_at).getTime() - 60_000 && (
                    <span className="muted small">{t.daySalesSince(when(day.period_start))}</span>
                  )}
                </>
              ) : (
                <>
                  <strong>{t.dayNotOpen}</strong>
                  <span className="muted small">{t.daySalesSince(when(data.report.from))}</span>
                </>
              )}
            </div>
            <div className="spacer" />
            <button type="button" onClick={exportCsv}>{t.exportCsv}</button>
            {day && <button type="button" onClick={() => setZ(day)}>{t.zPreview}</button>}
            {day && can('day_close') && <button type="button" className="primary" onClick={() => setClosing(true)}>{t.dayCloseBtn}</button>}
          </div>
          {!day && (
            <div className="banner error" role="status">
              <strong>{t.dayClosedBanner}</strong> {t.dayOpenHint}
              {data.report.closedSales && <> {t.dayClosedPending(data.report.closedSales.orders, money(data.report.closedSales.amount))}</>}
            </div>
          )}
          {day && data.report.closedSales && (
            <div className="banner">{t.dayClosedIncluded(data.report.closedSales.orders, money(data.report.closedSales.amount))}</div>
          )}
          <DayReportView report={data.report} day={day} />
          <PaidOrdersPanel sales={data.sales} onDone={reload} />
        </>
      )}
      {closing && day && data && (
        <CloseDialog day={day} onClose={() => setClosing(false)}
          onDone={(closed) => { setClosing(false); setZ(closed); reload() }} />
      )}
      {z && (z.closed_at ? z.report : data?.report) && (
        <ZDialog day={z} report={(z.closed_at ? z.report : data!.report)!} onClose={() => { const was = z.closed_at; setZ(null); if (was) onClosed() }} />
      )}
    </>
  )
}

/** Clôturer la journée: the counted cash, the gap shown live, then the closing (once). */
function CloseDialog({ day, onClose, onDone }: { day: CashDay; onClose(): void; onDone(d: CashDay): void }) {
  const { t } = useI18n()
  const [counted, setCounted] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Figures reloaded when the dialog opens, so the expected cash is the latest.
  const { data } = useLoad(loadLive)
  const n = parseAmount(counted)
  const expected = data?.report.cash?.expected ?? null
  const gap = n !== null && expected !== null ? Math.round((n - expected) * 100) / 100 : null

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (n === null || n < 0) return setError(t.errCashAmount)
    if (!data) return
    setBusy(true)
    try {
      setError(null)
      onDone(await cash.closeDay(day.id, n, data.report, note))
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="close-title" onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
        <h2 id="close-title">{t.dayCloseTitle(day.day_no)}</h2>
        {error && <p className="error small" role="alert">{error}</p>}
        {data && data.report.openOrders > 0 && <div className="banner">{t.dayCloseOpenOrders(data.report.openOrders)}</div>}
        <table className="bo-table day-summary">
          <tbody>
            <tr><td>{t.dayNet}</td><td className="num">{data ? money(data.report.net) : '…'}</td></tr>
            <tr className="total"><td>{t.cashExpected}</td><td className="num">{expected !== null ? money(expected) : '…'}</td></tr>
          </tbody>
        </table>
        <label>
          {t.cashCounted}
          <input autoFocus dir="ltr" inputMode="decimal" value={counted} placeholder="0" onChange={(e) => setCounted(e.target.value)} />
        </label>
        {gap !== null && (
          <p className={`day-gap ${gapClass(gap)}`}>
            {t.cashGap} : <strong>{gapText(gap)}</strong> {gap < 0 ? t.gapMissing : gap > 0 ? t.gapExtra : ''}
          </p>
        )}
        <label>
          {t.resNote}
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <p className="muted small">{t.dayCloseWarning}</p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>{t.cancel}</button>
          <button type="submit" className="primary" disabled={busy || n === null || !data}>{busy ? t.saving : t.dayCloseConfirm}</button>
        </div>
      </form>
    </div>
  )
}

/** Journées clôturées: list over a period, each day's report and its Z ticket. */
function ClosedDays({ start }: { start?: Period }) {
  const { t, lang } = useI18n()
  const [period, setPeriod] = useState<Period>(() => start ?? initialPeriod('month'))
  const range = useMemo(() => periodRange(period), [period])
  const load = useCallback(() => cash.closedDays(range[0], range[1]), [range])
  const { data, error, setError, reload } = useLoad(load)
  const [open, setOpen] = useState<CashDay | null>(null)
  const [z, setZ] = useState<CashDay | null>(null)
  useEffect(() => cash.subscribe(reload), [reload])
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale(lang), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—')
  const days = data ?? []
  const sum = (f: (d: CashDay) => number) => days.reduce((s, d) => s + f(d), 0)

  const exportCsv = () => download(`journees-${stamp()}.csv`, toCsv(days.map((d) => ({
    [t.dayNoCol]: d.day_no, [t.dayOpenedAt]: d.opened_at, [t.dayClosedAt]: d.closed_at, [t.dayOpenedByCol]: d.opened_by_name,
    [t.dayClosedByCol]: d.closed_by_name, [t.dayNet]: csvDa(d.report?.net), [t.paidOrders]: d.report?.orders ?? '',
    [t.cashOpening]: csvDa(d.opening_float), [t.cashSales]: csvDa(d.cash_sales), [t.cashInTotal]: csvDa(d.cash_in), [t.cashOutTotal]: csvDa(d.cash_out),
    [t.cashExpected]: csvDa(d.expected_cash), [t.cashCounted]: csvDa(d.counted_cash), [t.cashGap]: csvDa(d.difference), [t.resNote]: d.note,
  }))), 'text/csv;charset=utf-8')

  if (open) {
    return (
      <>
        <div className="bo-toolbar">
          <button type="button" className="ghost" onClick={() => setOpen(null)}>{t.back}</button>
          <div className="day-state">
            <strong>{t.dayNo(open.day_no)}</strong>
            <span className="muted small">{when(open.opened_at)} → {when(open.closed_at)} · {open.closed_by_name}</span>
          </div>
          <div className="spacer" />
          {open.report && <button type="button" onClick={() => download(`journee-${open.day_no}.csv`, toCsv(reportCsvRows(open.report!)), 'text/csv;charset=utf-8')}>{t.exportCsv}</button>}
          {open.report && <button type="button" className="primary" onClick={() => setZ(open)}>{t.zPrint}</button>}
        </div>
        {open.report ? <DayReportView report={open.report} day={open} /> : <p className="muted">{t.dayNoReport}</p>}
        {z?.report && <ZDialog day={z} report={z.report} onClose={() => setZ(null)} />}
      </>
    )
  }

  return (
    <>
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <div className="bo-toolbar">
        <PeriodFilter value={period} onChange={setPeriod} presets={['today', '7d', 'month', 'lastMonth', 'custom']} />
        <span className="muted small">{rangeLabel(range, locale(lang))}</span>
        <div className="spacer" />
        <button type="button" onClick={exportCsv} disabled={!days.length}>{t.exportCsv}</button>
      </div>
      <section className="panel">
        {!data ? (
          !error && <p className="muted">{t.loading}</p>
        ) : !days.length ? (
          <p className="muted small">{t.dayNoClosed}</p>
        ) : (
          <table className="bo-table days-table">
            <thead>
              <tr>
                <th>{t.dayNoCol}</th>
                <th>{t.dayOpenedAt}</th>
                <th>{t.dayClosedAt}</th>
                <th className="num">{t.dayNet}</th>
                <th className="num">{t.cashExpected}</th>
                <th className="num">{t.cashCounted}</th>
                <th className="num">{t.cashGap}</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.id}>
                  <td><button type="button" className="link" onClick={() => setOpen(d)}>{d.day_no}</button></td>
                  <td>{when(d.opened_at)}</td>
                  <td>{when(d.closed_at)}</td>
                  <td className="num">{d.report ? money(d.report.net) : '—'}</td>
                  <td className="num">{money(d.expected_cash ?? 0)}</td>
                  <td className="num">{money(d.counted_cash ?? 0)}</td>
                  <td className={`num ${gapClass(d.difference ?? 0)}`}>{gapText(d.difference ?? 0)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="total">
                <td colSpan={3}>{t.total}</td>
                <td className="num">{money(sum((d) => d.report?.net ?? 0))}</td>
                <td className="num">{money(sum((d) => d.expected_cash ?? 0))}</td>
                <td className="num">{money(sum((d) => d.counted_cash ?? 0))}</td>
                <td className={`num ${gapClass(sum((d) => d.difference ?? 0))}`}>{gapText(sum((d) => d.difference ?? 0))}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </section>
    </>
  )
}

import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { defaultReceiptSettings, repo } from '../../lib/repo'
import type { CashDay, DayReport, ReceiptSettings, SalesRow } from '../../lib/types'
import { money } from '../../lib/format'
import { isCash, paymentLabel, usePaymentModes } from '../../lib/settings'
import { useI18n } from '../../lib/i18n'

const TOP = 15

/** Figures of a day on screen: tiles, cash, payment methods, order types, then sales by category, item and employee. */
export function DayReportView({ report, day }: { report: DayReport; day: CashDay | null }) {
  const { t } = useI18n()
  const [allItems, setAllItems] = useState(false)
  const items = allItems ? report.items : report.items.slice(0, TOP)
  const closed = !!day?.closed_at
  const modes = usePaymentModes()
  // In the order of Paramètres > Paiement; a mode removed since (old payments) comes last.
  const rank = (code: string) => {
    const i = modes.findIndex((m) => m.code === code)
    return i < 0 ? modes.length : i
  }
  const methods = Object.entries(report.payments).sort(([a], [b]) => rank(a) - rank(b))
  return (
    <>
      <section className="stat-tiles" aria-live="polite">
        <div className="stat-tile main">
          <span className="muted small">{t.dayNet}</span>
          <strong>{money(report.net)}</strong>
        </div>
        <div className="stat-tile">
          <span className="muted small">{t.paidOrders}</span>
          <strong>{report.orders}</strong>
        </div>
        <div className="stat-tile">
          <span className="muted small">{t.avgTicket}</span>
          <strong>{report.orders ? money(report.avgTicket) : '—'}</strong>
        </div>
        {report.guests != null && (
          <div className="stat-tile">
            <span className="muted small">{t.dayGuests}</span>
            <strong>{report.guests}</strong>
            <small className="muted">{t.avgPerGuest} : {report.guests ? money(report.avgPerGuest ?? 0) : '—'}</small>
          </div>
        )}
        {!closed && (
          <div className="stat-tile">
            <span className="muted small">{t.openOrdersNow}</span>
            <strong>{report.openOrders}</strong>
          </div>
        )}
      </section>

      <div className="day-grid">
        <section className="panel">
          <h2>{t.daySales}</h2>
          <table className="bo-table day-summary">
            <tbody>
              <tr><td>{t.dayGross}</td><td className="num">{money(report.gross)}</td></tr>
              <tr><td>{t.dayDiscounts}</td><td className="num">{report.discounts ? <bdi dir="ltr">−{money(report.discounts)}</bdi> : money(0)}</td></tr>
              <tr><td>{t.dayOffered}</td><td className="num">{report.offered ? <bdi dir="ltr">−{money(report.offered)}</bdi> : money(0)}</td></tr>
              {report.delivery > 0 && <tr><td>{t.dayDelivery}</td><td className="num">+{money(report.delivery)}</td></tr>}
              <tr className="total"><td>{t.dayNet}</td><td className="num">{money(report.net)}</td></tr>
              {report.closedSales && (
                <tr className="closed-sales">
                  <td>{t.dayClosedSales} ({report.closedSales.orders})</td>
                  <td className="num">{money(report.closedSales.amount)}</td>
                </tr>
              )}
            </tbody>
          </table>
          {report.voids && (
            <p className="muted small day-voids">{t.dayVoidsHint(report.voids.orders, money(report.voids.amount), money(report.voids.cash))}</p>
          )}
          {report.closedSales && <p className="muted small">{t.dayClosedSalesHint(money(report.closedSales.cash))}</p>}
          <h3 className="day-sub">{t.dayPayments}</h3>
          <table className="bo-table day-summary">
            <tbody>
              {methods.length === 0 && <tr><td className="muted">{t.noSales}</td><td /></tr>}
              {methods.map(([m, v]) => (
                <tr key={m}>
                  <td><bdi>{paymentLabel(t, m, modes)}</bdi> {isCash(m) ? <span className="muted small">· {t.inDrawer}</span> : <span className="muted small">· {t.notInDrawer}</span>}</td>
                  <td className="num">{money(v)}</td>
                </tr>
              ))}
              {report.voids && report.voids.cash > 0 && (
                <tr><td>{t.dayVoids}</td><td className="num neg">−{money(report.voids.cash)}</td></tr>
              )}
            </tbody>
          </table>
          <h3 className="day-sub">{t.dayByType}</h3>
          <table className="bo-table day-summary">
            <tbody>
              {(['dine_in', 'takeaway', 'delivery'] as const).map((k) => (
                <tr key={k}>
                  <td>{t.dayTypes[k]} <span className="muted small">({report.byType[k].orders}{report.byType[k].guests != null && ` · ${report.byType[k].guests} 👤`})</span></td>
                  <td className="num">{money(report.byType[k].amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {report.cash && <CashBox cash={report.cash} day={day} />}
      </div>

      <section className="panel">
        <h2>{t.dayByCategory}</h2>
        <SalesTable rows={report.categories} />
      </section>
      <section className="panel">
        <h2>{t.dayByItem}</h2>
        <SalesTable rows={items} withCategory />
        {report.items.length > TOP && (
          <button type="button" className="ghost" onClick={() => setAllItems(!allItems)}>
            {allItems ? t.dayShowLess : t.dayShowAll(report.items.length)}
          </button>
        )}
      </section>
      <section className="panel">
        <h2>{t.dayByEmployee}</h2>
        <SalesTable rows={report.employees} employees />
      </section>
      {!!report.drivers?.length && (
        <section className="panel">
          <h2>{t.dayByDriver}</h2>
          <SalesTable rows={report.drivers} employees nameLabel={t.driverCol} countLabel={t.dayDeliveriesCol} />
        </section>
      )}
    </>
  )
}

function CashBox({ cash, day }: { cash: NonNullable<DayReport['cash']>; day: CashDay | null }) {
  const { t } = useI18n()
  const closed = day?.closed_at && day.counted_cash != null
  return (
    <section className="panel">
      <h2>{t.dayCash}</h2>
      <table className="bo-table day-summary">
        <tbody>
          <tr><td>{t.cashOpening}</td><td className="num">{money(cash.opening)}</td></tr>
          <tr><td>+ {t.cashSales}</td><td className="num">{money(cash.sales)}</td></tr>
          <tr><td>+ {t.cashInTotal}</td><td className="num">{money(cash.in)}</td></tr>
          <tr><td>− {t.cashOutTotal}</td><td className="num">{money(cash.out)}</td></tr>
          <tr className="total"><td>{t.cashExpected}</td><td className="num">{money(cash.expected)}</td></tr>
          {closed && (
            <>
              <tr><td>{t.cashCounted}</td><td className="num">{money(day.counted_cash!)}</td></tr>
              <tr className={`total ${gapClass(day.difference ?? 0)}`}><td>{t.cashGap}</td><td className="num">{gapText(day.difference ?? 0)}</td></tr>
            </>
          )}
        </tbody>
      </table>
    </section>
  )
}

export const gapClass = (n: number) => (Math.abs(n) < 0.005 ? '' : n < 0 ? 'neg' : 'pos')
export const gapText = (n: number) => (Math.abs(n) < 0.005 ? money(0) : <bdi dir="ltr">{n > 0 ? '+' : '−'}{money(Math.abs(n))}</bdi>)

function SalesTable({ rows, withCategory, employees, nameLabel, countLabel }: { rows: SalesRow[]; withCategory?: boolean; employees?: boolean; nameLabel?: string; countLabel?: string }) {
  const { t } = useI18n()
  if (!rows.length) return <p className="muted small">{t.noSales}</p>
  const max = Math.max(1, ...rows.map((r) => r.amount))
  return (
    <table className="bo-table top-items">
      <thead>
        <tr>
          <th>{nameLabel ?? (employees ? t.dayEmployee : withCategory ? t.colItem : t.dayCategory)}</th>
          <th className="num">{countLabel ?? (employees ? t.dayOrdersCol : t.colQty)}</th>
          <th className="num">{t.colAmount}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.category ?? ''}/${r.name}`}>
            <td>
              <bdi>{r.name}</bdi>
              {withCategory && r.category && <span className="muted small"> · <bdi>{r.category}</bdi></span>}
              <span className="qty-bar" style={{ width: `${(Math.max(0, r.amount) / max) * 100}%` }} aria-hidden />
            </td>
            <td className="num"><strong>{employees ? r.orders ?? 0 : r.quantity}</strong></td>
            <td className="num">{money(r.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ───────────── Rapport Z (ticket) ─────────────

/** The closing report on 80 mm paper. */
export function ZTicket({ day, report, settings }: { day: CashDay; report: DayReport; settings: ReceiptSettings }) {
  const { t } = useI18n()
  const modes = usePaymentModes()
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(t.locale, { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }) : '—')
  const row = (label: string, value: ReactNode, strong = false) => (
    <div key={label} className={`receipt-row${strong ? ' receipt-strong' : ''}`}><span>{label}</span><span>{value}</span></div>
  )
  return (
    <div className="receipt z-ticket">
      <div className="receipt-name" dir="auto">{settings.name}</div>
      <div className="z-title">{day.closed_at ? t.zTitle : t.zTitleX}</div>
      <div className="receipt-meta"><span>{t.dayNo(day.day_no)}</span></div>
      {row(t.dayOpenedAt, when(day.opened_at))}
      <div className="receipt-sub">{day.opened_by_name}</div>
      {row(t.dayClosedAt, when(day.closed_at))}
      {day.closed_by_name && <div className="receipt-sub">{day.closed_by_name}</div>}
      <div className="receipt-sep" />
      {row(t.dayGross, money(report.gross))}
      {row(t.dayDiscounts, `−${money(report.discounts)}`)}
      {row(t.dayOffered, `−${money(report.offered)}`)}
      {report.delivery > 0 && row(t.dayDelivery, `+${money(report.delivery)}`)}
      {row(t.dayNet, money(report.net), true)}
      {row(t.paidOrders, String(report.orders))}
      {row(t.avgTicket, money(report.avgTicket))}
      {report.closedSales && row(`${t.dayClosedSales} (${report.closedSales.orders})`, money(report.closedSales.amount))}
      {report.voids && row(`${t.dayVoids} (${report.voids.orders})`, `−${money(report.voids.cash)}`)}
      <div className="receipt-sep" />
      <div className="receipt-subtitle">{t.dayPayments}</div>
      {Object.entries(report.payments).map(([m, v]) => row(paymentLabel(t, m, modes), money(v)))}
      <div className="receipt-subtitle">{t.dayByType}</div>
      {(['dine_in', 'takeaway', 'delivery'] as const).map((k) => row(`${t.dayTypes[k]} (${report.byType[k].orders})`, money(report.byType[k].amount)))}
      {report.cash && (
        <>
          <div className="receipt-sep" />
          <div className="receipt-subtitle">{t.dayCash}</div>
          {row(t.cashOpening, money(report.cash.opening))}
          {row(`+ ${t.cashSales}`, money(report.cash.sales))}
          {row(`+ ${t.cashInTotal}`, money(report.cash.in))}
          {row(`− ${t.cashOutTotal}`, money(report.cash.out))}
          {row(t.cashExpected, money(report.cash.expected), true)}
          {day.counted_cash != null && row(t.cashCounted, money(day.counted_cash))}
          {day.difference != null && row(t.cashGap, gapText(day.difference), true)}
        </>
      )}
      <div className="receipt-sep" />
      <div className="receipt-subtitle">{t.dayByCategory}</div>
      {report.categories.map((c) => row(`${c.quantity} × ${c.name}`, money(c.amount)))}
      <div className="receipt-subtitle">{t.dayByEmployee}</div>
      {report.employees.map((e) => row(`${e.name} (${e.orders ?? 0})`, money(e.amount)))}
      {!!report.drivers?.length && <div className="receipt-subtitle">{t.dayByDriver}</div>}
      {report.drivers?.map((d) => row(`${d.name} (${d.orders ?? 0})`, money(d.amount)))}
      {day.note && (
        <>
          <div className="receipt-sep" />
          <div dir="auto">{day.note}</div>
        </>
      )}
      <div className="receipt-sep" />
      <div className="receipt-sub receipt-note">{t.zPrinted(when(new Date().toISOString()))}</div>
    </div>
  )
}

/** Rapport Z in a dialog, with the browser print button (the paper alone is printed). */
export function ZDialog({ day, report, onClose }: { day: CashDay; report: DayReport; onClose(): void }) {
  const { t } = useI18n()
  const [settings, setSettings] = useState<ReceiptSettings | null>(null)
  useEffect(() => {
    repo.getReceiptSettings().then(setSettings, () => setSettings(defaultReceiptSettings()))
  }, [])
  const paper = settings && <ZTicket day={day} report={report} settings={settings} />
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog receipt-dialog" role="dialog" aria-modal="true" aria-labelledby="z-title" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="panel-head">
          <h2 id="z-title">{day.closed_at ? t.zTitle : t.zTitleX}</h2>
        </div>
        <div className="receipt-paper">{paper ?? <p className="muted">{t.loading}</p>}</div>
        <div className="dialog-actions">
          <div className="spacer" />
          <button type="button" onClick={() => window.print()} disabled={!settings}>{t.print}</button>
          <button type="button" className="primary" autoFocus onClick={onClose}>{t.close}</button>
        </div>
      </div>
      {paper && createPortal(<div className="print-area">{paper}</div>, document.body)}
    </div>
  )
}

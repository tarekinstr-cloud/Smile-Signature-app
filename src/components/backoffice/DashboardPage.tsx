import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { cash } from '../../lib/cash'
import { repo } from '../../lib/repo'
import { customers } from '../../lib/customers'
import { settings, paymentLabel, usePaymentModes } from '../../lib/settings'
import { download, stamp, toCsv } from '../../lib/admin'
import { csvDa, money } from '../../lib/format'
import { useI18n } from '../../lib/i18n'
import { usePermissions } from '../../lib/permissions'
import { placeText } from '../../lib/place'
import {
  NO_CASHIER, chartSeries, dashOrderNo, dashboardView, loadDashboard, noFilters, staffReport,
  type ChartMode, type ChartPoint, type DashFilters, type DashOrder, type DashType,
} from '../../lib/dashboard'
import type { DiningTable } from '../../lib/types'
import { isoDay, type Period } from './PeriodFilter'
import { locale, useLoad } from './useLoad'
import { appNow, tzAddDays, tzDayStart, tzParts } from '../../lib/tz'
import { serverNow } from '../../lib/serverClock'

const csvType = 'text/csv;charset=utf-8'

/** Pages the dashboard opens on the same period (existing screens, not copies). */
export type DashboardLink = 'expenses' | 'zReport' | 'xReport' | 'cancelledOrders' | 'closeDay'

type SortKey = 'no' | 'place' | 'server' | 'cashier' | 'gross' | 'discount' | 'net' | 'method'

/**
 * Statistiques > Tableau de bord: filters for the whole screen, the tiles of the period, the analysis (chart, top 5,
 * links to the existing reports) and the list of orders with its totals and the server / cashier reports.
 */
export default function DashboardPage({ onOpen }: { onOpen?(page: DashboardLink, period: Period): void }) {
  const { t, lang } = useI18n()
  const loc = locale(lang)
  const { can } = usePermissions()
  const modes = usePaymentModes()
  const today = isoDay(appNow())
  const [first, setFirst] = useState(today)
  const [last, setLast] = useState(today)
  const [filters, setFilters] = useState<DashFilters>(noFilters)
  const [chart, setChart] = useState<ChartMode>('hour')
  const [topBy, setTopBy] = useState<'quantity' | 'amount'>('quantity')
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'no', desc: true })
  const [modal, setModal] = useState<'categories' | 'server' | 'cashier' | null>(null)
  const [alertAt, setAlertAt] = useState<number | null>(null)
  const [tables, setTables] = useState<Map<string, DiningTable>>(new Map())

  // Up to a year, so a few months (e.g. 2) load at once.
  const range = useMemo((): [Date, Date] => {
    const a = tzDayStart(first)
    const b = tzAddDays(tzDayStart(last < first ? first : last), 1)
    const p = tzParts(a)
    const max = tzDayStart(`${p.year + 1}-${p.month + 1}-${p.day}`)
    return [a, b < max ? b : max]
  }, [first, last])
  const period: Period = { preset: 'custom', from: first, to: last < first ? first : last }
  const load = useCallback(() => loadDashboard(range[0], range[1]), [range])
  const { data, error, setError, reload } = useLoad(load)
  useEffect(() => {
    const offs = [repo.subscribeOrders(reload), cash.subscribe(reload), customers.subscribe(reload)]
    return () => offs.forEach((off) => off())
  }, [reload])
  useEffect(() => {
    const read = () => settings.getCancelAlert().then(setAlertAt, () => setAlertAt(null))
    read()
    return settings.subscribe(read)
  }, [])
  useEffect(() => {
    repo.listAllTables().then((l) => setTables(new Map(l.map((x) => [x.id, x]))), () => setTables(new Map()))
  }, [])

  const view = useMemo(() => (data ? dashboardView(data, filters) : null), [data, filters])
  const series = useMemo(() => (view && data ? chartSeries(view.rows, chart, data.from, data.to) : []), [view, data, chart])
  const set = (patch: Partial<DashFilters>) => setFilters((f) => ({ ...f, ...patch }))
  const place = (r: DashOrder) => placeText(t, r.order, r.order.table_id ? tables.get(r.order.table_id) ?? null : null)
  const label = (m: string) => paymentLabel(t, m, modes)

  const sorted = useMemo(() => {
    if (!view) return []
    const val = (r: DashOrder): string | number => {
      switch (sort.key) {
        case 'no': return dashOrderNo(r.order) ?? 0
        case 'place': return place(r)
        case 'server': return r.order.created_by_name ?? ''
        case 'cashier': return r.cashier
        case 'gross': return r.gross
        case 'discount': return r.discount
        case 'net': return r.net
        case 'method': return r.methods.join(', ')
      }
    }
    return [...view.rows].sort((a, b) => {
      const [x, y] = [val(a), val(b)]
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })
      return sort.desc ? -c : c
    })
  }, [view, sort, tables])

  const exportOrders = () => view && download(`tableau-de-bord-${stamp()}.csv`, toCsv(sorted.map((r) => ({
    [t.orderNoCol]: dashOrderNo(r.order) ?? '', [t.colDate]: r.order.closed_at ?? '', [t.placeCol]: place(r), [t.dashServer]: r.order.created_by_name ?? '',
    [t.dashCashier]: r.cashier || t.notRecorded, [t.dashGross]: csvDa(r.gross), [t.dashDiscount]: csvDa(r.discount), [t.dayDelivery]: csvDa(r.delivery),
    [t.dashNet]: csvDa(r.net), [t.payMethodLabel]: r.methods.map(label).join(' + '),
  }))), csvType)

  const tile = (name: string, value: string, extra?: ReactNode, cls = '') => (
    <div className={`stat-tile ${cls}`}><span>{name}</span><strong>{value}</strong>{extra}</div>
  )
  const th = (key: SortKey, text: string, num = false) => (
    <th className={num ? 'num' : ''} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="sort-btn" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'place' && key !== 'server' && key !== 'cashier' && key !== 'method' }))}>
        {text}{sort.key === key ? (sort.desc ? ' ▼' : ' ▲') : ''}
      </button>
    </th>
  )
  const alert = !!view && alertAt !== null && view.tiles.cancelledAmount > alertAt
  // The Caisse tile is about the open working day, whatever the period: say which one, and warn when it is not closed for 24 h.
  const day = data?.currentDay ?? null
  const openedText = day ? new Date(day.opened_at).toLocaleString(loc, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : ''
  const stale = !!day && serverNow() - new Date(day.opened_at).getTime() > 24 * 3_600_000
  const top = view ? [...view.report.items].sort((a, b) => (topBy === 'quantity' ? b.quantity - a.quantity : b.amount - a.amount)).slice(0, 5) : []

  return (
    <main className="content bo-content dashboard">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <section className="panel dash-filters" aria-label={t.dashFilters}>
        <label className="inline-label">
          {t.dashType}
          <select className="auto-width" value={filters.type} onChange={(e) => set({ type: e.target.value as DashType })}>
            <option value="all">{t.dashAll}</option>
            <option value="dine_in">{t.dayTypes.dine_in}</option>
            <option value="takeaway">{t.dayTypes.takeaway}</option>
            <option value="delivery">{t.dayTypes.delivery}</option>
            <option value="drops">{t.dashDrops}</option>
          </select>
        </label>
        <label className="inline-label">
          {t.payMethodLabel}
          <select className="auto-width" value={filters.method} onChange={(e) => set({ method: e.target.value })}>
            <option value="">{t.dashAll}</option>
            {modes.map((m) => <option key={m.code} value={m.code}>{label(m.code)}</option>)}
          </select>
        </label>
        <label className="inline-label">
          {t.dashLaunchedBy}
          <select className="auto-width" value={filters.launchedBy} onChange={(e) => set({ launchedBy: e.target.value })}>
            <option value="">{t.dashAll}</option>
            {(view?.waiters ?? []).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="inline-label">
          {t.dashCashedBy}
          <select className="auto-width" value={filters.cashedBy} onChange={(e) => set({ cashedBy: e.target.value })}>
            <option value="">{t.dashAll}</option>
            {(view?.cashiers ?? []).map((n) => <option key={n} value={n}>{n}</option>)}
            <option value={NO_CASHIER}>{t.notRecorded}</option>
          </select>
        </label>
        {JSON.stringify(filters) !== JSON.stringify(noFilters()) && <button type="button" className="link" onClick={() => setFilters(noFilters())}>{t.dashReset}</button>}
      </section>

      {!view ? (!error && <div className="center muted">{t.loading}</div>) : (
        <>
          <section className="stat-tiles dash-tiles" aria-live="polite">
            {tile(t.dashFloat, money(view.tiles.float))}
            {tile(t.dashGuests, String(view.tiles.guests), <small className="muted" title={t.dashGuestsHint}>{t.dashOrders(view.tiles.orders)}</small>)}
            {tile(t.dashSales, money(view.tiles.sales), view.tva && <small className="muted">{t.dashHt} {money(view.tva.ht)} · {t.tvaShort} {money(view.tva.tva)}</small>, 'main')}
            {tile(t.dashIn, money(view.tiles.cashIn))}
            <div className={`stat-tile${stale ? ' alert-tile' : ''}`}>
              <span>{t.dashCash}</span>
              <strong>{view.tiles.expectedCash === null ? '—' : money(view.tiles.expectedCash)}</strong>
              {day ? <small className="muted">{t.dashCashDay(day.day_no, openedText)}</small> : <small className="muted">{t.dashNoOpenDay}</small>}
              {stale && <small>⚠ {t.dashDayStale}</small>}
              {stale && onOpen && can('day_close') && <button type="button" className="link" onClick={() => onOpen('closeDay', period)}>{t.dashCloseDay}</button>}
            </div>
            {tile(t.dashDebts, money(view.tiles.debts), undefined, view.tiles.debts ? 'warn-tile' : '')}
            {tile(t.dashStaff, money(view.tiles.staff))}
            {tile(t.dashPurchases, money(view.tiles.purchases))}
            {tile(t.dashOut, money(view.tiles.cashOut))}
            {tile(t.dashDropsTile, money(view.tiles.drops))}
            {tile(t.dashProfit, view.tiles.profit === null ? '—' : money(view.tiles.profit), undefined, view.tiles.profit !== null && view.tiles.profit < 0 ? 'neg-tile' : '')}
            <div className={`stat-tile${alert ? ' alert-tile' : ''}`}>
              <span>{alert && '⚠ '}{t.dashCancelled}</span>
              <strong>{view.tiles.cancelledCount} · {money(view.tiles.cancelledAmount)}</strong>
              {alert && <small>{t.dashCancelAlert(money(alertAt!))}</small>}
              {onOpen && can('cancelled_orders') && <button type="button" className="link" onClick={() => onOpen('cancelledOrders', period)}>{t.dashSeeCancelled}</button>}
            </div>
          </section>
          {view.tva && (
            <p className="muted small">{t.dashTvaLine(money(view.tva.ht), String(view.tva.rate), money(view.tva.tva), money(view.tva.ttc))}</p>
          )}

          <div className="dash-split">
            <section className="panel dash-left">
              <h2>{t.dashAnalysis}</h2>
              <div className="dash-range">
                <label>{t.dashFrom}<input type="date" value={first} max={today} onChange={(e) => e.target.value && setFirst(e.target.value)} /></label>
                <label>{t.dashTo}<input type="date" value={last} min={first} onChange={(e) => e.target.value && setLast(e.target.value)} /></label>
                <label>{t.dashHourFrom}<input type="time" value={filters.hourFrom} onChange={(e) => set({ hourFrom: e.target.value })} /></label>
                <label>{t.dashHourTo}<input type="time" value={filters.hourTo} onChange={(e) => set({ hourTo: e.target.value })} /></label>
              </div>
              <div className="segmented" role="group" aria-label={t.dashChart}>
                {(['day', 'week', 'month', 'weekday', 'hour'] as const).map((m) => (
                  <button key={m} type="button" className={chart === m ? 'on' : ''} aria-pressed={chart === m} onClick={() => setChart(m)}>{t.dashChartModes[m]}</button>
                ))}
              </div>
              <SalesChart points={series} mode={chart} loc={loc} />
              <div className="panel-head">
                <h3 className="day-sub">{t.dashTop5}</h3>
                <div className="segmented" role="group" aria-label={t.dashTop5}>
                  <button type="button" className={topBy === 'quantity' ? 'on' : ''} aria-pressed={topBy === 'quantity'} onClick={() => setTopBy('quantity')}>{t.dashByQty}</button>
                  <button type="button" className={topBy === 'amount' ? 'on' : ''} aria-pressed={topBy === 'amount'} onClick={() => setTopBy('amount')}>{t.dashByAmount}</button>
                </div>
              </div>
              {!top.length ? <p className="muted small">{t.noSales}</p> : (
                <ol className="dash-top">
                  {top.map((i) => (
                    <li key={`${i.category}-${i.name}`}><bdi>{i.name}</bdi> <span className="muted small">{i.category}</span>
                      <strong>{topBy === 'quantity' ? `× ${i.quantity}` : money(i.amount)}</strong></li>
                  ))}
                </ol>
              )}
              <div className="row-actions dash-links">
                <button type="button" onClick={() => setModal('categories')}>{t.dashByCategory}</button>
                {onOpen && can('expenses') && <button type="button" onClick={() => onOpen('expenses', period)}>{t.expensesTitle}</button>}
                {onOpen && can('stats') && <button type="button" onClick={() => onOpen('zReport', period)}>{t.dashZ}</button>}
                {onOpen && can('stats') && <button type="button" onClick={() => onOpen('xReport', period)}>{t.dashX}</button>}
              </div>
            </section>

            <section className="panel dash-right">
              <div className="panel-head">
                <h2>{filters.type === 'drops' ? t.dashDropsList : t.dashOrders(view.rows.length)}</h2>
                <div className="row-actions">
                  <button type="button" onClick={() => setModal('server')}>{t.dashServerReport}</button>
                  <button type="button" onClick={() => setModal('cashier')}>{t.dashCashierReport}</button>
                  {filters.type !== 'drops' && <button type="button" onClick={exportOrders} disabled={!view.rows.length}>{t.exportCsv}</button>}
                </div>
              </div>
              {filters.type === 'drops' ? (
                !view.drops.length ? <p className="muted small">{t.dashNoDrops}</p> : (
                  <table className="bo-table control-table">
                    <thead><tr><th>{t.colDate}</th><th>{t.cashReason}</th><th>{t.colEmployee}</th><th className="num">{t.colAmount}</th></tr></thead>
                    <tbody>
                      {view.drops.map((m) => (
                        <tr key={m.id}><td>{new Date(m.created_at).toLocaleString(loc, { dateStyle: 'short', timeStyle: 'short' })}</td><td><bdi>{m.reason}</bdi></td><td>{m.user_name || '—'}</td><td className="num">{money(m.amount)}</td></tr>
                      ))}
                    </tbody>
                    <tfoot><tr className="total"><td colSpan={3}>{t.total}</td><td className="num">{money(view.tiles.drops)}</td></tr></tfoot>
                  </table>
                )
              ) : !view.rows.length ? <p className="muted small">{t.noSales}</p> : (
                <div className="table-scroll dash-orders">
                  <table className="bo-table control-table">
                    <thead>
                      <tr>
                        {th('no', t.orderNoCol)}{th('place', t.placeCol)}{th('server', t.dashServer)}{th('cashier', t.dashCashier)}
                        {th('gross', t.dashGross, true)}{th('discount', t.dashDiscount, true)}{th('net', t.dashNet, true)}{th('method', t.payMethodLabel)}
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((r) => (
                        <tr key={r.order.id}>
                          <td>{dashOrderNo(r.order) ?? '—'}</td>
                          <td>{place(r)}</td>
                          <td><bdi>{r.order.created_by_name || '—'}</bdi></td>
                          <td>{r.cashier ? <bdi>{r.cashier}</bdi> : <span className="muted">{t.notRecorded}</span>}</td>
                          <td className="num">{money(r.gross)}</td>
                          <td className="num">{r.discount ? `−${money(r.discount)}` : '—'}</td>
                          <td className="num"><strong>{money(r.net)}</strong></td>
                          <td>{r.methods.map(label).join(' + ') || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {filters.type !== 'drops' && (
                <dl className="dash-totals">
                  <div><dt>{t.dashDiscountsTotal}</dt><dd>{money(view.totals.discounts)}</dd></div>
                  <div><dt>{t.dayDelivery}</dt><dd>{money(view.totals.delivery)}</dd></div>
                  <div><dt>{t.dashNet}</dt><dd><strong>{money(view.totals.net)}</strong></dd></div>
                </dl>
              )}
            </section>
          </div>
        </>
      )}

      {modal && view && (
        <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setModal(null)}>
          <div className="dialog dash-dialog" role="dialog" aria-modal="true" aria-labelledby="dash-modal-title" onKeyDown={(e) => e.key === 'Escape' && setModal(null)}>
            <div className="panel-head">
              <h2 id="dash-modal-title">{modal === 'categories' ? t.dashByCategory : modal === 'server' ? t.dashServerReport : t.dashCashierReport}</h2>
              <button className="ghost" autoFocus onClick={() => setModal(null)} aria-label={t.close}>✕</button>
            </div>
            {modal === 'categories' ? (
              <table className="bo-table control-table">
                <thead><tr><th>{t.categoryCol}</th><th className="num">{t.colQty}</th><th className="num">{t.colAmount}</th></tr></thead>
                <tbody>{view.report.categories.map((c) => <tr key={c.name}><td><bdi>{c.name}</bdi></td><td className="num">{c.quantity}</td><td className="num">{money(c.amount)}</td></tr>)}</tbody>
                <tfoot><tr className="total"><td>{t.total}</td><td /><td className="num">{money(view.report.categories.reduce((s, c) => s + c.amount, 0))}</td></tr></tfoot>
              </table>
            ) : (
              <StaffTable rows={staffReport(modal, view.sales, view.cancelled, modal === 'cashier' ? t.notRecorded : t.dayUnknownEmployee)} label={label} kind={modal} />
            )}
          </div>
        </div>
      )}
    </main>
  )
}

/** Rapport Serveur / Caissier: one row per employee, with the payments by mode, and a CSV. */
function StaffTable({ rows, label, kind }: { rows: ReturnType<typeof staffReport>; label(m: string): string; kind: 'server' | 'cashier' }) {
  const { t } = useI18n()
  const methods = [...new Set(rows.flatMap((r) => Object.keys(r.payments)))]
  const exportCsv = () => download(`rapport-${kind === 'server' ? 'serveur' : 'caissier'}-${stamp()}.csv`, toCsv(rows.map((r) => ({
    [t.colEmployee]: r.name, [t.dashOrdersCol]: r.orders, [t.dashSales]: csvDa(r.sales), [t.dayDiscounts]: csvDa(r.discounts), [t.dayOffered]: csvDa(r.offered),
    [t.dashCancelled]: r.cancelled, [t.dashCancelledAmount]: csvDa(r.cancelledAmount),
    ...Object.fromEntries(methods.map((m) => [label(m), csvDa(r.payments[m] ?? 0)])),
  }))), csvType)
  if (!rows.length) return <p className="muted small">{t.noSales}</p>
  return (
    <>
      <div className="table-scroll">
        <table className="bo-table control-table">
          <thead>
            <tr>
              <th>{t.colEmployee}</th><th className="num">{t.dashOrdersCol}</th><th className="num">{t.dashSales}</th><th className="num">{t.dayDiscounts}</th>
              <th className="num">{t.dayOffered}</th><th className="num">{t.dashCancelled}</th>
              {methods.map((m) => <th key={m} className="num">{label(m)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td><bdi>{r.name}</bdi></td><td className="num">{r.orders}</td><td className="num">{money(r.sales)}</td>
                <td className="num">{money(r.discounts)}</td><td className="num">{money(r.offered)}</td>
                <td className="num">{r.cancelled ? `${r.cancelled} · ${money(r.cancelledAmount)}` : '—'}</td>
                {methods.map((m) => <td key={m} className="num">{money(r.payments[m] ?? 0)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="dialog-actions"><div className="spacer" /><button type="button" onClick={exportCsv}>{t.exportCsv}</button></div>
    </>
  )
}

/** CA by day / week / month / weekday / hour: one series, so one colour and no legend; a readout on hover. */
function SalesChart({ points, mode, loc }: { points: ChartPoint[]; mode: ChartMode; loc: string }) {
  const { t } = useI18n()
  const [hover, setHover] = useState<number | null>(null)
  const W = 640
  const H = 220
  const pad = { l: 52, r: 8, t: 10, b: 28 }
  const max = Math.max(1, ...points.map((p) => p.amount))
  const step = 10 ** Math.floor(Math.log10(max))
  const top = Math.ceil(max / step) * step
  const ticks = [0, top / 2, top]
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / top)
  const band = (W - pad.l - pad.r) / Math.max(1, points.length)
  const bar = Math.max(2, Math.min(36, band - 2))
  const short = (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v)))
  const name = (k: string) => {
    if (mode === 'hour') return `${k}h`
    if (mode === 'weekday') return t.weekdaysShort[Number(k)]
    if (mode === 'month') return tzDayStart(`${k}-01`).toLocaleDateString(loc, { month: 'short', year: '2-digit' })
    return tzDayStart(k).toLocaleDateString(loc, { day: '2-digit', month: '2-digit' })
  }
  const every = Math.max(1, Math.ceil(points.length / 12))
  const shown = hover !== null ? points[hover] : null
  return (
    <div className="week-chart dash-chart">
      <div className="chart-legend">
        <span>{t.dashChartTitle}</span>
        <span className="chart-readout">{shown ? <>{name(shown.key)} · <strong>{money(shown.amount)}</strong> · {t.dashOrders(shown.orders)}</> : t.dashChartHint}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t.dashChartTitle} style={{ direction: 'ltr' }} onPointerLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="chart-grid" />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="chart-axis">{short(v)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const x = pad.l + band * i + (band - bar) / 2
          const h = Math.max(0, y(0) - y(p.amount))
          return (
            <g key={p.key} className={hover === i ? 'on' : ''} onPointerEnter={() => setHover(i)}>
              <rect className="chart-hit" x={pad.l + band * i} y={pad.t} width={band} height={H - pad.t - pad.b} />
              {h > 0 && <path className="dash-bar" d={`M${x},${y(0)} V${y(0) - h + Math.min(4, h)} q0,-${Math.min(4, h)} ${Math.min(4, bar / 2)},-${Math.min(4, h)} H${x + bar - Math.min(4, bar / 2)} q${Math.min(4, bar / 2)},0 ${Math.min(4, bar / 2)},${Math.min(4, h)} V${y(0)} Z`} />}
              <title>{`${name(p.key)} : ${money(p.amount)} (${p.orders})`}</title>
              {i % every === 0 && <text x={pad.l + band * i + band / 2} y={H - 8} textAnchor="middle" className="chart-axis">{name(p.key)}</text>}
            </g>
          )
        })}
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="chart-base" />
      </svg>
    </div>
  )
}

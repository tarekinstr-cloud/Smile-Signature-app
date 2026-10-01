import { useCallback, useEffect, useMemo, useState } from 'react'
import { cash } from '../../lib/cash'
import { expenses } from '../../lib/expenses'
import { repo } from '../../lib/repo'
import { download, toCsv } from '../../lib/admin'
import { da, money } from '../../lib/format'
import { useI18n } from '../../lib/i18n'
import type { CashDay, Expense, SalesData } from '../../lib/types'
import { isoDay } from './PeriodFilter'
import { guestsOf } from '../../lib/dayReport'
import { gapClass, gapText } from './DayReportView'
import { locale, useLoad } from './useLoad'

const WEEK_START_KEY = 'smile.weekStart'
/** First day of the week: 6 = samedi (default, week-end vendredi in Algeria), 0 = dimanche, 1 = lundi. */
const readWeekStart = () => {
  try {
    const n = Number(localStorage.getItem(WEEK_START_KEY))
    return localStorage.getItem(WEEK_START_KEY) !== null && [0, 1, 6].includes(n) ? n : 6
  } catch {
    return 6
  }
}

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const parseDay = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
/** Start (local midnight) of the week containing `d`. */
const weekOf = (d: Date, start: number) => addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -((d.getDay() - start + 7) % 7))

export interface WeekDay {
  day: string
  net: number
  orders: number
  avg: number
  /** Personnes servies (1 for an order without its number of people) and the ticket moyen par personne. */
  guests: number
  avgGuest: number
  /** Sales of the tables (the only orders with a number of people), for the ticket moyen par personne. */
  dineNet: number
  cash: number
  card: number
  expenses: number
  /** Écart de caisse of the days closed that started on this date; null when none was closed. */
  gap: number | null
}

/**
 * Working day of an instant: the date the cash day containing it was opened (sales after midnight count for the
 * evening before). Outside any cash day, its calendar date.
 */
function dayKeyOf(days: CashDay[]) {
  const spans = days.map((d) => ({ from: new Date(d.period_start).getTime(), to: d.closed_at ? new Date(d.closed_at).getTime() : Infinity, key: isoDay(new Date(d.opened_at)) }))
  return (iso: string) => {
    const t = new Date(iso).getTime()
    return spans.find((s) => t >= s.from && t < s.to)?.key ?? isoDay(new Date(iso))
  }
}

/** Figures of each day of [first, first + n days). */
export function weekDays(first: Date, n: number, sales: SalesData, days: CashDay[], spent: Expense[]): WeekDay[] {
  const keyOf = dayKeyOf(days)
  const rows = new Map<string, WeekDay>()
  for (let i = 0; i < n; i++) {
    const day = isoDay(addDays(first, i))
    rows.set(day, { day, net: 0, orders: 0, avg: 0, guests: 0, avgGuest: 0, dineNet: 0, cash: 0, card: 0, expenses: 0, gap: null })
  }
  for (const o of sales.orders) {
    const r = rows.get(keyOf(o.closed_at ?? o.created_at))
    if (!r) continue
    r.net += o.total ?? 0
    r.orders += 1
    r.guests += guestsOf(o)
    if ((o.order_type ?? 'dine_in') === 'dine_in') r.dineNet += o.total ?? 0
  }
  for (const p of sales.payments) {
    const r = rows.get(keyOf(p.created_at))
    if (r) r[p.method === 'cash' ? 'cash' : 'card'] += p.amount
  }
  for (const e of spent) {
    const r = rows.get(e.date)
    if (r) r.expenses += e.amount
  }
  for (const d of days) {
    const r = d.closed_at ? rows.get(isoDay(new Date(d.opened_at))) : undefined
    if (r) r.gap = (r.gap ?? 0) + (d.difference ?? 0)
  }
  const c = da
  return [...rows.values()].map((r) => ({
    ...r, net: c(r.net), cash: c(r.cash), card: c(r.card), expenses: c(r.expenses), gap: r.gap === null ? null : c(r.gap),
    avg: r.orders ? c(r.net / r.orders) : 0, avgGuest: r.guests ? c(r.dineNet / r.guests) : 0, dineNet: c(r.dineNet),
  }))
}

interface Week {
  current: WeekDay[]
  previous: WeekDay[]
}

/** Récapitulatif Hebdomadaire: each working day of a week, its total, and the comparison with the week before. */
export default function WeeklyPage() {
  const { t, lang } = useI18n()
  const [weekStart, setWeekStart] = useState(readWeekStart)
  const [anchor, setAnchor] = useState(() => isoDay(new Date()))
  const first = useMemo(() => weekOf(parseDay(anchor), weekStart), [anchor, weekStart])
  const last = addDays(first, 6)

  const load = useCallback(async (): Promise<Week> => {
    const prev = addDays(first, -7)
    const end = addDays(first, 7)
    // Cash days a little wider, for sales made after midnight or before the opening.
    const [sales, closed, open, spent] = await Promise.all([
      cash.sales(addDays(prev, -1), addDays(end, 1)),
      cash.closedDays(addDays(prev, -1), addDays(end, 2)),
      cash.currentDay(),
      expenses.list(isoDay(prev), isoDay(addDays(end, -1))),
    ])
    const days = open ? [...closed, open] : closed
    return { current: weekDays(first, 7, sales, days, spent), previous: weekDays(prev, 7, sales, days, spent) }
  }, [first])
  const { data, error, setError, reload } = useLoad(load)
  useEffect(() => {
    const offs = [repo.subscribeOrders(reload), cash.subscribe(reload), expenses.subscribe(reload)]
    return () => offs.forEach((off) => off())
  }, [reload])

  const changeStart = (n: number) => {
    setWeekStart(n)
    try {
      localStorage.setItem(WEEK_START_KEY, String(n))
    } catch {
      // Kept for this visit only.
    }
  }
  const loc = locale(lang)
  const dayName = (day: string) => parseDay(day).toLocaleDateString(loc, { weekday: 'long', day: '2-digit', month: '2-digit' })
  const short = (d: Date) => d.toLocaleDateString(loc, { day: '2-digit', month: '2-digit', year: 'numeric' })

  const total = (rows: WeekDay[]) => {
    const s = (f: (r: WeekDay) => number) => da(rows.reduce((a, r) => a + f(r), 0))
    const orders = s((r) => r.orders)
    const gaps = rows.filter((r) => r.gap !== null)
    return {
      net: s((r) => r.net), orders, avg: orders ? da(s((r) => r.net) / orders) : 0, cash: s((r) => r.cash),
      guests: s((r) => r.guests), avgGuest: s((r) => r.guests) ? da(s((r) => r.dineNet) / s((r) => r.guests)) : 0, dineNet: s((r) => r.dineNet),
      card: s((r) => r.card), expenses: s((r) => r.expenses), gap: gaps.length ? s((r) => r.gap ?? 0) : null,
    }
  }
  const cur = data ? total(data.current) : null
  const prev = data ? total(data.previous) : null
  const change = cur && prev && prev.net > 0 ? Math.round(((cur.net - prev.net) / prev.net) * 1000) / 10 : null

  const exportCsv = () => {
    if (!data || !cur) return
    const row = (label: string, r: Omit<WeekDay, 'day'>, prevNet: number | null) => ({
      [t.colDate]: label, [t.dayNet]: r.net, [t.dayOrdersCol]: r.orders, [t.weekAvg]: r.avg, [t.dayGuests]: r.guests, [t.avgPerGuest]: r.avgGuest, [t.weekCash]: r.cash, [t.weekCard]: r.card,
      [t.weekExpenses]: r.expenses, [t.cashGap]: r.gap ?? '', [t.weekPrevNet]: prevNet ?? '',
    })
    const rows = data.current.map((r, i) => row(r.day, r, data.previous[i].net))
    download(`hebdo-${isoDay(first)}.csv`, toCsv([...rows, row(t.total, cur, prev?.net ?? null)]), 'text/csv;charset=utf-8')
  }

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <div className="bo-toolbar">
        <div className="week-nav">
          <button type="button" aria-label={t.weekPrev} onClick={() => setAnchor(isoDay(addDays(first, -7)))}>{lang === 'ar' ? '→' : '←'}</button>
          <input type="date" value={anchor} aria-label={t.weekPick} onChange={(e) => e.target.value && setAnchor(e.target.value)} />
          <button type="button" aria-label={t.weekNext} onClick={() => setAnchor(isoDay(addDays(first, 7)))}>{lang === 'ar' ? '←' : '→'}</button>
          <button type="button" onClick={() => setAnchor(isoDay(new Date()))}>{t.weekThis}</button>
        </div>
        <strong>{t.weekRange(short(first), short(last))}</strong>
        <div className="spacer" />
        <label className="inline-label">
          {t.weekStartsOn}
          <select value={weekStart} onChange={(e) => changeStart(Number(e.target.value))}>
            <option value={6}>{t.weekDays[6]}</option>
            <option value={0}>{t.weekDays[0]}</option>
            <option value={1}>{t.weekDays[1]}</option>
          </select>
        </label>
        <button type="button" onClick={exportCsv} disabled={!data}>{t.exportCsv}</button>
      </div>
      {!data || !cur || !prev ? (
        !error && <div className="center muted">{t.loading}</div>
      ) : (
        <>
          <div className="stat-tiles">
            <div className="stat-tile"><span>{t.dayNet}</span><strong>{money(cur.net)}</strong>
              <small className={change === null ? 'muted' : change < 0 ? 'neg' : 'pos'}>
                {change === null ? t.weekNoPrev : t.weekVsPrev(`${change > 0 ? '+' : ''}${change.toLocaleString(loc)} %`, money(prev.net))}
              </small>
            </div>
            <div className="stat-tile"><span>{t.dayOrdersCol}</span><strong>{cur.orders}</strong><small className="muted">{t.weekPrevShort(String(prev.orders))}</small></div>
            <div className="stat-tile"><span>{t.weekAvg}</span><strong>{money(cur.avg)}</strong><small className="muted">{t.weekPrevShort(money(prev.avg))}</small></div>
            <div className="stat-tile"><span>{t.dayGuests}</span><strong>{cur.guests}</strong><small className="muted">{t.avgPerGuest} : {money(cur.avgGuest)} · {t.weekPrevShort(money(prev.avgGuest))}</small></div>
            <div className="stat-tile"><span>{t.weekExpenses}</span><strong>{money(cur.expenses)}</strong><small className="muted">{t.weekPrevShort(money(prev.expenses))}</small></div>
          </div>
          <section className="panel">
            <div className="panel-head"><h2>{t.weekChartTitle}</h2></div>
            <WeekChart current={data.current} previous={data.previous} />
          </section>
          <section className="panel">
            <div className="table-scroll">
              <table className="bo-table days-table week-table">
                <thead>
                  <tr>
                    <th>{t.colDate}</th>
                    <th className="num">{t.dayNet}</th>
                    <th className="num">{t.dayOrdersCol}</th>
                    <th className="num">{t.weekAvg}</th>
                    <th className="num">{t.dayGuests}</th>
                    <th className="num">{t.avgPerGuest}</th>
                    <th className="num">{t.weekCash}</th>
                    <th className="num">{t.weekCard}</th>
                    <th className="num">{t.weekExpenses}</th>
                    <th className="num">{t.cashGap}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.current.map((r) => (
                    <tr key={r.day} className={r.orders ? '' : 'muted'}>
                      <td>{dayName(r.day)}</td>
                      <td className="num">{money(r.net)}</td>
                      <td className="num">{r.orders}</td>
                      <td className="num">{money(r.avg)}</td>
                      <td className="num">{r.guests}</td>
                      <td className="num">{money(r.avgGuest)}</td>
                      <td className="num">{money(r.cash)}</td>
                      <td className="num">{money(r.card)}</td>
                      <td className="num">{money(r.expenses)}</td>
                      <td className={`num ${r.gap === null ? '' : gapClass(r.gap)}`}>{r.gap === null ? '—' : gapText(r.gap)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="total">
                    <td>{t.weekTotal}</td>
                    <td className="num">{money(cur.net)}</td>
                    <td className="num">{cur.orders}</td>
                    <td className="num">{money(cur.avg)}</td>
                    <td className="num">{cur.guests}</td>
                    <td className="num">{money(cur.avgGuest)}</td>
                    <td className="num">{money(cur.cash)}</td>
                    <td className="num">{money(cur.card)}</td>
                    <td className="num">{money(cur.expenses)}</td>
                    <td className={`num ${cur.gap === null ? '' : gapClass(cur.gap)}`}>{cur.gap === null ? '—' : gapText(cur.gap)}</td>
                  </tr>
                  <tr className="muted">
                    <td>{t.weekPrevTotal}</td>
                    <td className="num">{money(prev.net)}</td>
                    <td className="num">{prev.orders}</td>
                    <td className="num">{money(prev.avg)}</td>
                    <td className="num">{prev.guests}</td>
                    <td className="num">{money(prev.avgGuest)}</td>
                    <td className="num">{money(prev.cash)}</td>
                    <td className="num">{money(prev.card)}</td>
                    <td className="num">{money(prev.expenses)}</td>
                    <td className="num">{prev.gap === null ? '—' : gapText(prev.gap)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  )
}

/** Rounded top only, anchored to the baseline. */
function barPath(x: number, y: number, w: number, h: number, r = 4) {
  if (h <= 0) return ''
  const rr = Math.min(r, h, w / 2)
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
}

/** Nice round top for the axis. */
function niceMax(v: number) {
  if (v <= 0) return 1000
  const p = 10 ** Math.floor(Math.log10(v))
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p
}

/** CA net of each day, this week (orange) next to the same day of the week before (blue). */
function WeekChart({ current, previous }: { current: WeekDay[]; previous: WeekDay[] }) {
  const { t, lang } = useI18n()
  const loc = locale(lang)
  const [hover, setHover] = useState<number | null>(null)
  const W = 700
  const H = 240
  const pad = { l: 64, r: 8, t: 12, b: 28 }
  const max = niceMax(Math.max(...current.map((d) => d.net), ...previous.map((d) => d.net)))
  const plotH = H - pad.t - pad.b
  const band = (W - pad.l - pad.r) / 7
  const barW = Math.min(28, (band - 18) / 2)
  const y = (v: number) => pad.t + plotH - (v / max) * plotH
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max)
  const label = (day: string) => parseDay(day).toLocaleDateString(loc, { weekday: 'short', day: 'numeric' })
  const short = (v: number) => (v >= 1000 ? `${(v / 1000).toLocaleString(loc, { maximumFractionDigits: 1 })} k` : v.toLocaleString(loc))
  const h = hover !== null ? { cur: current[hover], prev: previous[hover] } : null

  return (
    <div className="week-chart">
      <div className="chart-legend">
        <span><i style={{ background: 'var(--chart-this)' }} />{t.weekThisLegend}</span>
        <span><i style={{ background: 'var(--chart-prev)' }} />{t.weekPrevLegend}</span>
        {h && <span className="chart-readout">{label(h.cur.day)} : <strong>{money(h.cur.net)}</strong> · {label(h.prev.day)} : {money(h.prev.net)}</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t.weekChartTitle} style={{ direction: 'ltr' }} onPointerLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="chart-grid" />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="chart-axis">{short(v)}</text>
          </g>
        ))}
        {current.map((d, i) => {
          const x0 = pad.l + i * band + (band - barW * 2 - 2) / 2
          const p = previous[i]
          return (
            <g key={d.day} onPointerEnter={() => setHover(i)} className={hover === i ? 'on' : ''}>
              <rect x={pad.l + i * band} y={pad.t} width={band} height={plotH} className="chart-hit" />
              <path d={barPath(x0, y(d.net), barW, y(0) - y(d.net))} fill="var(--chart-this)">
                <title>{`${label(d.day)} : ${money(d.net)}`}</title>
              </path>
              <path d={barPath(x0 + barW + 2, y(p.net), barW, y(0) - y(p.net))} fill="var(--chart-prev)">
                <title>{`${label(p.day)} : ${money(p.net)}`}</title>
              </path>
              <text x={pad.l + i * band + band / 2} y={H - 8} textAnchor="middle" className="chart-axis">{label(d.day)}</text>
            </g>
          )
        })}
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="chart-base" />
      </svg>
    </div>
  )
}

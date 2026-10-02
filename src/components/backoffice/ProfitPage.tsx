import { appNow, daysInMonth, tzParts } from '../../lib/tz'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { cash } from '../../lib/cash'
import { expenses } from '../../lib/expenses'
import { computeProfit, type ProfitRow } from '../../lib/profit'
import { repo } from '../../lib/repo'
import { download, stamp, toCsv } from '../../lib/admin'
import { money } from '../../lib/format'
import { useI18n } from '../../lib/i18n'
import PeriodFilter, { initialPeriod, isoDay, periodRange, rangeLabel, type Period } from './PeriodFilter'
import { locale, useLoad } from './useLoad'

type SortKey = 'name' | 'quantity' | 'sales' | 'cost' | 'margin' | 'marginPct'

const pctText = (v: number | null, loc: string) => (v === null ? '—' : `${v.toLocaleString(loc, { maximumFractionDigits: 1 })} %`)

/** Bénéfice: compte de résultat of a period, then the margin of each item and size. */
export default function ProfitPage() {
  const { t, lang } = useI18n()
  const loc = locale(lang)
  const [period, setPeriod] = useState<Period>(() => initialPeriod('month'))
  /** Journée en cours: working day in progress (since the last closing), not midnight to midnight. */
  const [workDay, setWorkDay] = useState<{ start: string; date: string } | null>(null)
  useEffect(() => {
    if (period.preset !== 'day') return
    let live = true
    Promise.all([cash.currentDay(), cash.closedDays(new Date(0), new Date(appNow().getTime() + 86_400_000))]).then(([day, closed]) => {
      if (!live) return
      const start = day?.period_start ?? closed[0]?.closed_at ?? null
      setWorkDay(start ? { start, date: isoDay(day?.opened_at ? new Date(day.opened_at) : appNow()) } : null)
    }, () => live && setWorkDay(null))
    return () => { live = false }
  }, [period.preset])
  const range = useMemo(() => periodRange(period, workDay?.start), [period, workDay])
  const load = useCallback(async () => {
    const [from, to] = range
    // Salaries and expenses of the working day: its date only.
    const first = period.preset === 'day' ? workDay?.date ?? isoDay(appNow()) : isoDay(from)
    const last = period.preset === 'day' ? first : isoDay(new Date(to.getTime() - 1))
    const [sales, menu, costs] = await Promise.all([
      cash.sales(from, to),
      repo.getMenu({ includeHidden: true }).catch(() => null),
      expenses.profitCosts(from, to, first, last),
    ])
    return computeProfit(sales, menu, costs)
  }, [range, period.preset, workDay])
  const { data, error, setError, reload } = useLoad(load)
  // « 1 jours / 31 jours du mois » under Salaires: elapsed days counted, out of the period.
  const salaryHint = (() => {
    const c = data?.costs
    if (c?.salary_days == null || c.period_days == null) return t.profitSalariesHint
    const [from] = range
    const f = tzParts(from)
    const whole = f.day === 1 && c.period_days === daysInMonth(f.year, f.month) && period.preset !== 'day'
    return t.profitSalaryDays(c.salary_days, c.period_days, whole)
  })()
  useEffect(() => {
    const offs = [repo.subscribeOrders(reload), expenses.subscribe(reload)]
    return () => offs.forEach((off) => off())
  }, [reload])
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'margin', desc: true })

  const rows = useMemo(() => {
    const list = [...(data?.rows ?? [])]
    const val = (r: ProfitRow) => (sort.key === 'name' ? `${r.name} ${r.size}` : r[sort.key] ?? -Infinity)
    list.sort((a, b) => {
      const x = val(a)
      const y = val(b)
      const c = typeof x === 'string' ? x.localeCompare(y as string, loc) : (x as number) - (y as number)
      return sort.desc ? -c : c
    })
    return list
  }, [data, sort, loc])

  const statement = data
    ? [
        { label: t.dayNet, value: data.net, kind: 'plus' },
        { label: t.profitMaterial, value: -data.material, kind: 'minus', hint: t.profitMaterialHint },
        { label: t.profitGross, value: data.grossMargin, kind: 'sub', pct: data.grossMarginPct },
        { label: t.profitCharges, value: -data.costs.charges, kind: 'minus' },
        { label: t.profitInventory, value: -data.costs.inventory_loss, kind: 'minus' },
        { label: t.profitSalaries, value: -data.costs.salaries, kind: 'minus', hint: salaryHint },
        { label: t.profitExpenses, value: -data.costs.expenses, kind: 'minus' },
        { label: t.profitNet, value: data.netProfit, kind: 'total', pct: data.netProfitPct },
      ]
    : []

  const exportCsv = () => {
    if (!data) return
    const lines: Record<string, unknown>[] = statement.map((s) => ({ [t.profitLine]: s.label, [t.colAmount]: s.value, '%': 'pct' in s ? s.pct ?? '' : '' }))
    lines.push({})
    for (const r of rows) {
      lines.push({
        [t.profitLine]: r.size ? `${r.name} (${r.size})` : r.name, [t.colAmount]: '', '%': '', [t.colQty]: r.quantity, [t.dayNet]: r.sales, [t.profitCost]: r.cost,
        [t.profitMargin]: r.margin, [t.profitMarginPct]: r.marginPct ?? '', [t.profitUnknownCol]: r.unknown || '',
      })
    }
    download(`benefice-${stamp()}.csv`, toCsv(lines), 'text/csv;charset=utf-8')
  }

  const head = (key: SortKey, label: string, num = true) => (
    <th className={num ? 'num' : ''} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="sort-btn" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }))}>
        {label}{sort.key === key ? (sort.desc ? ' ▼' : ' ▲') : ''}
      </button>
    </th>
  )

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <div className="bo-toolbar">
        <PeriodFilter value={period} onChange={setPeriod} presets={['day', 'today', '7d', 'month', 'lastMonth', 'custom']} />
        <span className="muted small">{rangeLabel(range, loc)}</span>
        <div className="spacer" />
        <button type="button" onClick={exportCsv} disabled={!data}>{t.exportCsv}</button>
      </div>
      {!data ? (
        !error && <div className="center muted">{t.loading}</div>
      ) : (
        <>
          {data.unknown > 0 && <div className="banner">{t.profitUnknownBanner(data.unknown)}</div>}
          <div className="stat-tiles">
            <div className="stat-tile"><span>{t.dayNet}</span><strong>{money(data.net)}</strong><small className="muted">{t.profitOrders(data.orders)}</small></div>
            <div className="stat-tile"><span>{t.profitGross}</span><strong>{money(data.grossMargin)}</strong><small className="muted">{pctText(data.grossMarginPct, loc)}</small></div>
            <div className={`stat-tile main ${data.netProfit < 0 ? 'loss' : ''}`}><span>{t.profitNet}</span><strong>{money(data.netProfit)}</strong><small className="muted">{pctText(data.netProfitPct, loc)}</small></div>
          </div>
          <section className="panel">
            <div className="panel-head"><h2>{t.profitStatement}</h2></div>
            <table className="bo-table profit-statement">
              <tbody>
                {statement.map((s) => (
                  <tr key={s.label} className={s.kind === 'sub' ? 'subtotal' : s.kind === 'total' ? 'total' : ''}>
                    <td>
                      {s.kind === 'minus' ? '− ' : s.kind === 'plus' ? '' : '= '}{s.label}
                      {s.hint && <span className="muted small"> · {s.hint}</span>}
                    </td>
                    <td className="num pct">{'pct' in s ? pctText(s.pct ?? null, loc) : ''}</td>
                    <td className={`num ${s.kind === 'total' || s.kind === 'sub' ? (s.value < 0 ? 'neg' : 'pos') : ''}`}>{money(Math.abs(s.value) === 0 ? 0 : s.kind === 'minus' ? -s.value : s.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>{t.profitByItem}</h2></div>
            {!rows.length ? (
              <p className="muted small">{t.profitNoSales}</p>
            ) : (
              <div className="table-scroll">
                <table className="bo-table profit-items">
                  <thead>
                    <tr>
                      {head('name', t.profitItemCol, false)}
                      {head('quantity', t.colQty)}
                      {head('sales', t.dayNet)}
                      {head('cost', t.profitCost)}
                      {head('margin', t.profitMargin)}
                      {head('marginPct', t.profitMarginPct)}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key}>
                        <td>
                          {r.name}{r.size && <span className="muted"> · {r.size}</span>}
                          {r.unknown > 0 && <span className="tag warn cost-tag">{t.profitUnknownTag(r.unknown)}</span>}
                          {r.noPrice > 0 && <span className="tag cost-tag">{t.profitNoPriceTag(r.noPrice)}</span>}
                        </td>
                        <td className="num">{r.quantity}</td>
                        <td className="num">{money(r.sales)}</td>
                        <td className="num">{money(r.cost)}</td>
                        <td className={`num ${r.margin < 0 ? 'neg' : ''}`}>{money(r.margin)}</td>
                        <td className={`num ${r.marginPct !== null && r.marginPct < 0 ? 'neg' : ''}`}>{pctText(r.marginPct, loc)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small">{t.profitItemsHint}</p>
          </section>
        </>
      )}
    </main>
  )
}

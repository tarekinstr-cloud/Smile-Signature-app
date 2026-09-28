import { useCallback, useState } from 'react'
import { backOffice, dayRange } from '../../lib/backoffice'
import { money } from '../../lib/format'
import { useI18n } from '../../lib/i18n'
import { locale, useLoad } from './useLoad'

/** Statistiques: read-only dashboard of one day's sales, from the orders already paid. */
export default function StatsPage() {
  const { t, lang } = useI18n()
  const [day, setDay] = useState(() => dayRange(new Date())[0])
  const load = useCallback(() => backOffice.dayStats(day), [day])
  const { data: stats, error, setError } = useLoad(load)

  const today = dayRange(new Date())[0]
  const isToday = day.getTime() === today.getTime()
  const shift = (n: number) => setDay(new Date(day.getFullYear(), day.getMonth(), day.getDate() + n))
  const dayLabel = day.toLocaleDateString(locale(lang), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const maxQty = Math.max(1, ...(stats?.topItems.map((i) => i.quantity) ?? []))

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <div className="bo-toolbar">
        <div className="segmented day-nav" role="group">
          <button onClick={() => shift(-1)} aria-label={t.prevDay} title={t.prevDay}>{lang === 'ar' ? '›' : '‹'}</button>
          <button className={isToday ? 'on' : ''} onClick={() => setDay(today)}>{t.today}</button>
          <button onClick={() => shift(1)} disabled={isToday} aria-label={t.nextDay} title={t.nextDay}>{lang === 'ar' ? '‹' : '›'}</button>
        </div>
        <strong className="day-label">{dayLabel}</strong>
      </div>

      {!stats ? (
        !error && <div className="center muted">{t.loading}</div>
      ) : (
        <>
          <section className="stat-tiles" aria-live="polite">
            <div className="stat-tile main">
              <span className="muted small">{t.salesOfDay}</span>
              <strong>{money(stats.sales)}</strong>
            </div>
            <div className="stat-tile">
              <span className="muted small">{t.paidOrders}</span>
              <strong>{stats.orders}</strong>
            </div>
            <div className="stat-tile">
              <span className="muted small">{t.avgTicket}</span>
              <strong>{stats.orders ? money(Math.round(stats.sales / stats.orders)) : '—'}</strong>
            </div>
            {isToday && (
              <div className="stat-tile">
                <span className="muted small">{t.openOrdersNow}</span>
                <strong>{stats.openOrders}</strong>
              </div>
            )}
          </section>

          <section className="panel">
            <h2>{t.topItems}</h2>
            {stats.topItems.length === 0 ? (
              <p className="muted small">{t.noSales}</p>
            ) : (
              <table className="bo-table top-items">
                <thead>
                  <tr>
                    <th className="rank">#</th>
                    <th>{t.colItem}</th>
                    <th className="num">{t.colQty}</th>
                    <th className="num">{t.colAmount}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.topItems.map((it, i) => (
                    <tr key={it.name}>
                      <td className="rank muted">{i + 1}</td>
                      <td>
                        <bdi>{it.name}</bdi>
                        <span className="qty-bar" style={{ width: `${(it.quantity / maxQty) * 100}%` }} aria-hidden />
                      </td>
                      <td className="num"><strong>{it.quantity}</strong></td>
                      <td className="num">{money(it.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted small">{t.statsNote}</p>
          </section>
        </>
      )}
    </main>
  )
}

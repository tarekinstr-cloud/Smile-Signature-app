import { useCallback, useEffect, useMemo, useState } from 'react'
import { INVENTORY_LIMIT, InventoryStaleError, isNegative, stockLevel, stockState, stockValue, totalQty } from '../../lib/stockState'
import { recipes } from '../../lib/recipes'
import { download, stamp, toCsv } from '../../lib/admin'
import { usePermissions } from '../../lib/permissions'
import { todayIso } from '../../lib/payroll'
import type { ConsumptionRow, StockInventory, StockInventoryLine, StockLocation, StockReportRow, StockStateRow } from '../../lib/types'
import { useI18n } from '../../lib/i18n'
import { money } from '../../lib/format'
import { useDialog } from '../Dialog'
import { qtyText } from './StockPage'
import { errorText, locale, useLoad } from './useLoad'

type Tab = 'overview' | 'moves' | 'consumption' | 'inventories' | 'count'
type LevelFilter = 'all' | 'low' | 'out' | 'negative'
type Period = 'today' | 'week' | 'month' | 'custom'

const round2 = (n: number) => Math.round(n * 100) / 100
const round3 = (n: number) => Math.round(n * 1000) / 1000
/** Parses "2,5" or "2.5" (spaces ignored); null when empty or not a number. */
const parseNum = (v: string) => {
  const n = Number(v.replace(/\s/g, '').replace(',', '.'))
  return v.trim() && Number.isFinite(n) ? n : null
}
/** Numbers in the CSV files: decimal comma, no thousands separator, as Excel in French reads them. */
const csvNum = (n: number | null) => (n == null ? '' : String(round3(n)).replace('.', ','))
/** "+2 kg", "−1,5 L", "0". */
const signed = (s: { unit: string }, n: number) => (n > 0 ? `+${qtyText({ quantity: n, unit: s.unit })}` : n < 0 ? `−${qtyText({ quantity: -n, unit: s.unit })}` : '0')
const signedMoney = (n: number) => (n > 0 ? `+${money(n)}` : n < 0 ? `−${money(-n)}` : money(0))

/** Local midnight of a YYYY-MM-DD date, plus `days`. */
function midnight(iso: string, days = 0) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d + days)
}
function isoDay(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
/** Start (included) and end (excluded) of a period, in local days. */
function periodRange(period: Period, from: string, to: string): [Date, Date] {
  const today = todayIso()
  if (period === 'today') return [midnight(today), midnight(today, 1)]
  if (period === 'week') return [midnight(today, -6), midnight(today, 1)]
  if (period === 'month') return [midnight(today.slice(0, 8) + '01'), midnight(today, 1)]
  return [midnight(from || today), midnight(to || today, 1)]
}

/**
 * État du stock (menu Gestion du Stock): every item with its quantities and value, low stock alerts, Mouvements par
 * période, and the inventaire physique with its history. Updates live on the shared « stock » channel.
 */
export default function StockStatePage() {
  const { t } = useI18n()
  const { can } = usePermissions()
  const load = useCallback(() => stockState.overview(), [])
  const { data: items, error, setError, reload } = useLoad(load)
  const [tab, setTab] = useState<Tab>('overview')
  const [version, setVersion] = useState(0)
  // Another tablet buying, transferring or counting updates the page (shared « stock » channel).
  useEffect(() => stockState.subscribe(() => { reload(); setVersion((v) => v + 1) }), [reload])
  const [notice, setNotice] = useState<string | null>(null)
  const dialog = useDialog()
  const [level, setLevel] = useState<LevelFilter>('all')
  /** Paid orders whose automatic consumption failed (Supabase only), waiting for Réessayer. */
  const [failed, setFailed] = useState(0)
  useEffect(() => {
    let live = true
    recipes.failures().then((n) => live && setFailed(n), () => {})
    return () => {
      live = false
    }
  }, [version])
  const negatives = (items ?? []).filter(isNegative).length

  async function retry() {
    try {
      const n = await recipes.retry()
      setNotice(t.consumptionRetried(n))
      setFailed(await recipes.failures())
      await reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function leaveCount(next: Tab) {
    if (tab === 'count' && next !== 'count' && !(await dialog.confirm(t.invConfirmLeave, t.invAbandon))) return
    setTab(next)
  }

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {notice && <div className="banner ok" role="status" onClick={() => setNotice(null)}>{notice}</div>}
      {negatives > 0 && tab !== 'count' && (
        <div className="banner warn-banner" role="alert">
          <span>{t.negativeAlert(negatives)}</span>
          <button type="button" onClick={() => { setLevel('negative'); setTab('overview') }}>{t.negativeShow}</button>
        </div>
      )}
      {failed > 0 && (
        <div className="banner error" role="alert">
          <span>{t.consumptionFailed(failed)}</span>
          <button type="button" onClick={retry}>{t.consumptionRetry}</button>
        </div>
      )}
      <div className="state-tabs">
        <div className="segmented" role="tablist" aria-label={t.stateItem}>
          {(['overview', 'moves', 'consumption', 'inventories'] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => leaveCount(k)}>
              {t.stateTabs[k]}
            </button>
          ))}
        </div>
        {can('inventory') && tab !== 'count' && (
          <button className="primary" onClick={() => { setNotice(null); setTab('count') }}>{t.stateDoInventory}</button>
        )}
      </div>
      {tab === 'overview' && <Overview items={items} level={level} setLevel={setLevel} />}
      {tab === 'moves' && <Moves version={version} />}
      {tab === 'consumption' && <Consumption version={version} />}
      {tab === 'inventories' && <Inventories version={version} />}
      {tab === 'count' && items && (
        <InventoryForm items={items} onReload={reload}
          onDone={(message) => { setNotice(message); setTab('inventories') }}
          onAbandon={() => leaveCount('overview')} />
      )}
      {dialog.element}
    </main>
  )
}

// ───────────── Vue d'ensemble ─────────────

function Overview({ items, level, setLevel }: { items: StockStateRow[] | null; level: LevelFilter; setLevel(l: LevelFilter): void }) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [supplier, setSupplier] = useState('')

  const all = items ?? []
  const suppliers = useMemo(() => {
    const byId = new Map<string, string>()
    for (const s of all) for (const x of s.suppliers) byId.set(x.id, x.name)
    return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [all])
  const q = query.trim().toLowerCase()
  const bySearch = all.filter((s) => (!q || s.name.toLowerCase().includes(q)) && (!supplier || s.suppliers.some((x) => x.id === supplier)))
  const counts: Record<LevelFilter, number> = {
    all: bySearch.length,
    low: bySearch.filter((s) => stockLevel(s) === 'low').length,
    out: bySearch.filter((s) => stockLevel(s) === 'out').length,
    negative: bySearch.filter(isNegative).length,
  }
  const shown = bySearch.filter((s) => level === 'all' || (level === 'negative' ? isNegative(s) : stockLevel(s) === level))

  const sum = (f: (s: StockStateRow) => number | null) => round2(shown.reduce((a, s) => a + (f(s) ?? 0), 0))
  const depotValue = sum((s) => stockValue(s.quantity, s.last_price))
  const kitchenValue = sum((s) => stockValue(s.kitchen_quantity, s.last_price))
  const unpriced = shown.filter((s) => s.last_price == null && totalQty(s) > 0).length

  function exportCsv() {
    download(`smile-signature_etat-stock_${stamp()}.csv`, toCsv(shown.map((s) => {
      const lv = stockLevel(s)
      return {
        [t.stateColArticle]: s.name,
        [t.colUnit]: s.unit,
        [t.colDepot]: csvNum(s.quantity),
        [t.colKitchen]: csvNum(s.kitchen_quantity),
        [t.stateColTotal]: csvNum(totalQty(s)),
        [t.stockMinLabel]: csvNum(s.min_quantity),
        [t.stateColPrice]: csvNum(s.last_price),
        [t.stateValueDepot]: csvNum(stockValue(s.quantity, s.last_price)),
        [t.stateValueKitchen]: csvNum(stockValue(s.kitchen_quantity, s.last_price)),
        [t.stateColValue]: csvNum(stockValue(totalQty(s), s.last_price)),
        [t.stateSupplier]: s.last_supplier_name ?? '',
        [t.stateColAlert]: [lv === 'ok' ? '' : t.stateLevelFilter[lv], isNegative(s) ? t.stateLevelFilter.negative : ''].filter(Boolean).join(', '),
      }
    })), 'text/csv;charset=utf-8')
  }

  return (
    <section className="panel">
      <div className="bo-toolbar pur-filters state-filters">
        <label>
          {t.search.replace('…', '')}
          <input type="search" className="bo-search" placeholder={t.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {suppliers.length > 0 && (
          <label>
            {t.stateSupplier}
            <select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
              <option value="">{t.stateAllSuppliers}</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        <div className="segmented state-levels" role="radiogroup" aria-label={t.stateLevelFilter.all}>
          {(['all', 'low', 'out', 'negative'] as const).map((l) => (
            <button key={l} type="button" role="radio" aria-checked={level === l} className={level === l ? 'on' : ''} onClick={() => setLevel(l)}>
              {t.stateLevelFilter[l]} <span className={`state-count ${l}`}>{counts[l]}</span>
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button onClick={exportCsv} disabled={!shown.length}>{t.stateExport}</button>
      </div>

      {!items ? (
        <p className="muted">{t.loading}</p>
      ) : !shown.length ? (
        <p className="muted small">{all.length ? t.stateNone : t.noStock}</p>
      ) : (
        <table className="bo-table payroll-table state-table">
          <thead>
            <tr>
              <th>{t.stateColArticle}</th>
              <th>{t.colUnit}</th>
              <th className="num">{t.colDepot}</th>
              <th className="num">{t.colKitchen}</th>
              <th className="num">{t.stateColTotal}</th>
              <th className="num">{t.stateColMin}</th>
              <th className="num">{t.stateColPrice}</th>
              <th className="num">{t.stateColValue}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => {
              const lv = stockLevel(s)
              const value = stockValue(totalQty(s), s.last_price)
              return (
                <tr key={s.id} className={lv !== 'ok' ? `state-${lv}` : undefined}>
                  <td className="payroll-name">
                    <bdi>{s.name}</bdi>
                    {lv !== 'ok' && <span className={`tag state-level ${lv}`}>{t.stateLevelFilter[lv]}</span>}
                    {isNegative(s) && <span className="tag state-level negative">{t.stateLevelFilter.negative}</span>}
                    {s.last_supplier_name && <div className="muted small"><bdi>{t.stateLastSupplier(s.last_supplier_name)}</bdi></div>}
                  </td>
                  <td className="state-unit" data-label={t.colUnit}>{s.unit || '—'}</td>
                  <td className={`num${s.quantity < 0 ? ' neg' : ''}`} data-label={t.colDepot}><bdi>{qtyText({ quantity: s.quantity, unit: '' })}</bdi></td>
                  <td className={`num${s.kitchen_quantity < 0 ? ' neg strong' : ''}`} data-label={t.colKitchen}><bdi>{qtyText({ quantity: s.kitchen_quantity, unit: '' })}</bdi></td>
                  <td className="num strong" data-label={t.stateColTotal}><bdi>{qtyText({ quantity: totalQty(s), unit: '' })}</bdi></td>
                  <td className="num" data-label={t.stateColMin}>{s.min_quantity == null ? '—' : <bdi>{qtyText({ quantity: s.min_quantity, unit: '' })}</bdi>}</td>
                  <td className="num" data-label={t.stateColPrice}>{s.last_price == null ? '—' : money(s.last_price)}</td>
                  <td className="num strong" data-label={t.stateColValue}>{value == null ? '—' : money(value)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {items && shown.length > 0 && (
        <>
          <section className="stat-tiles moves-tiles" aria-live="polite">
            <div className="stat-tile">
              <span className="muted small">{t.stateValueDepot}</span>
              <strong>{money(depotValue)}</strong>
            </div>
            <div className="stat-tile">
              <span className="muted small">{t.stateValueKitchen}</span>
              <strong>{money(kitchenValue)}</strong>
            </div>
            <div className="stat-tile main">
              <span className="muted small">{t.stateValueTotal}</span>
              <strong>{money(round2(depotValue + kitchenValue))}</strong>
            </div>
          </section>
          <p className="muted small">
            {t.stateShown(shown.length, all.length)} · {t.stateValueNote}{unpriced ? ` ${t.stateUnpriced(unpriced)}` : ''}
          </p>
        </>
      )}
      <p className="muted small">{t.stateLowHint}</p>
    </section>
  )
}

// ───────────── Mouvements par période ─────────────

/** Period of a report (Aujourd'hui, 7 jours, Ce mois, Personnalisé) and its fields. */
function usePeriod() {
  const [period, setPeriod] = useState<Period>('week')
  const [from, setFrom] = useState(() => isoDay(midnight(todayIso(), -6)))
  const [to, setTo] = useState(todayIso)
  const [start, end] = periodRange(period, from, to)
  return { period, setPeriod, from, setFrom, to, setTo, start, end }
}

function PeriodFields({ p }: { p: ReturnType<typeof usePeriod> }) {
  const { t } = useI18n()
  return (
    <>
      <div>
        <span className="pur-label-block">{t.statePeriod}</span>
        <div className="segmented" role="radiogroup" aria-label={t.statePeriod}>
          {(['today', 'week', 'month', 'custom'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={p.period === k} className={p.period === k ? 'on' : ''} onClick={() => p.setPeriod(k)}>
              {t.statePeriods[k]}
            </button>
          ))}
        </div>
      </div>
      {p.period === 'custom' && (
        <>
          <label>
            {t.moveFrom}
            <input type="date" value={p.from} max={p.to || undefined} onChange={(e) => p.setFrom(e.target.value)} />
          </label>
          <label>
            {t.moveTo}
            <input type="date" value={p.to} min={p.from || undefined} onChange={(e) => p.setTo(e.target.value)} />
          </label>
        </>
      )}
    </>
  )
}

function Moves({ version }: { version: number }) {
  const { t } = useI18n()
  const p = usePeriod()
  const [query, setQuery] = useState('')
  const [onlyMoved, setOnlyMoved] = useState(false)
  const [rows, setRows] = useState<StockReportRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { start, end } = p
  const startKey = start.getTime()
  const endKey = end.getTime()
  useEffect(() => {
    let live = true
    setError(null)
    stockState.report(new Date(startKey), new Date(endKey)).then(
      (r) => live && setRows(r),
      (e) => live && setError(errorText(e)),
    )
    return () => {
      live = false
    }
  }, [startKey, endKey, version])

  const q = query.trim().toLowerCase()
  const moved = (r: StockReportRow) => r.purchases || r.transfers || r.returns || r.charges || r.consumption || r.adjustments
  const shown = (rows ?? []).filter((r) => (!q || r.name.toLowerCase().includes(q)) && (!onlyMoved || moved(r)))
  const lastDay = isoDay(new Date(endKey - 1))

  function exportCsv() {
    download(`smile-signature_mouvements-stock_${isoDay(start)}_${lastDay}.csv`, toCsv(shown.map((r) => ({
      [t.stateColArticle]: r.name,
      [t.colUnit]: r.unit,
      [`${t.repColInitial} ${t.stockLocation.depot}`]: csvNum(r.initial_depot),
      [`${t.repColInitial} ${t.stockLocation.kitchen}`]: csvNum(r.initial_kitchen),
      [t.repColInitial]: csvNum(r.initial_depot + r.initial_kitchen),
      [t.repColIn]: csvNum(r.purchases),
      [`${t.repColTransfers} ${t.repToKitchen}`]: csvNum(r.transfers),
      [`${t.repColTransfers} ${t.repToDepot}`]: csvNum(r.returns),
      [t.repColOut]: csvNum(r.charges),
      [t.repColSales]: csvNum(r.consumption),
      [t.repColAdjust]: csvNum(r.adjustments),
      [`${t.repColFinal} ${t.stockLocation.depot}`]: csvNum(r.final_depot),
      [`${t.repColFinal} ${t.stockLocation.kitchen}`]: csvNum(r.final_kitchen),
      [t.repColFinal]: csvNum(r.final_depot + r.final_kitchen),
    }))), 'text/csv;charset=utf-8')
  }

  const split = (r: StockReportRow, depot: number, kitchen: number) =>
    `${t.stockLocation.depot} ${qtyText({ quantity: depot, unit: '' })} · ${t.stockLocation.kitchen} ${qtyText({ quantity: kitchen, unit: '' })}${r.unit ? ` (${r.unit})` : ''}`

  return (
    <section className="panel">
      <div className="bo-toolbar pur-filters state-filters">
        <PeriodFields p={p} />
        <label>
          {t.search.replace('…', '')}
          <input type="search" className="bo-search" placeholder={t.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={onlyMoved} onChange={(e) => setOnlyMoved(e.target.checked)} />
          {t.repOnlyMoved}
        </label>
        <div className="spacer" />
        <button onClick={exportCsv} disabled={!shown.length}>{t.stateExport}</button>
      </div>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {!rows ? (
        !error && <p className="muted">{t.loading}</p>
      ) : !shown.length ? (
        <p className="muted small">{t.stateNone}</p>
      ) : (
        <table className="bo-table payroll-table state-table report-table">
          <thead>
            <tr>
              <th>{t.stateColArticle}</th>
              <th className="num">{t.repColInitial}</th>
              <th className="num">{t.repColIn}</th>
              <th className="num">{t.repColTransfers}</th>
              <th className="num">{t.repColOut}</th>
              <th className="num">{t.repColSales}</th>
              <th className="num">{t.repColAdjust}</th>
              <th className="num">{t.repColFinal}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td className="payroll-name"><bdi>{r.name}</bdi></td>
                <td className="num" data-label={t.repColInitial} title={split(r, r.initial_depot, r.initial_kitchen)}>
                  <bdi>{qtyText({ quantity: round3(r.initial_depot + r.initial_kitchen), unit: r.unit })}</bdi>
                </td>
                <td className="num" data-label={t.repColIn}>{r.purchases ? <bdi className="pos">+{qtyText({ quantity: r.purchases, unit: r.unit })}</bdi> : '—'}</td>
                <td className="num report-transfers" data-label={t.repColTransfers}>
                  {r.transfers || r.returns ? (
                    <>
                      {r.transfers > 0 && <bdi>{t.repToKitchen} {qtyText({ quantity: r.transfers, unit: r.unit })}</bdi>}
                      {r.returns > 0 && <bdi>{t.repToDepot} {qtyText({ quantity: r.returns, unit: r.unit })}</bdi>}
                    </>
                  ) : '—'}
                </td>
                <td className="num" data-label={t.repColOut}>{r.charges ? <bdi className="neg">−{qtyText({ quantity: r.charges, unit: r.unit })}</bdi> : '—'}</td>
                <td className="num" data-label={t.repColSales}>{r.consumption ? <bdi className="neg">−{qtyText({ quantity: r.consumption, unit: r.unit })}</bdi> : '—'}</td>
                <td className="num" data-label={t.repColAdjust}>{r.adjustments ? <bdi className={r.adjustments < 0 ? 'neg' : 'pos'}>{signed(r, r.adjustments)}</bdi> : '—'}</td>
                <td className="num strong" data-label={t.repColFinal} title={split(r, r.final_depot, r.final_kitchen)}>
                  <bdi>{qtyText({ quantity: round3(r.final_depot + r.final_kitchen), unit: r.unit })}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">{t.repNote}</p>
    </section>
  )
}

// ───────────── Consommation théorique vs réelle ─────────────

function Consumption({ version }: { version: number }) {
  const { t } = useI18n()
  const p = usePeriod()
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<ConsumptionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const startKey = p.start.getTime()
  const endKey = p.end.getTime()
  useEffect(() => {
    let live = true
    setError(null)
    recipes.consumption(new Date(startKey), new Date(endKey)).then(
      (r) => live && setRows(r),
      (e) => live && setError(errorText(e)),
    )
    return () => {
      live = false
    }
  }, [startKey, endKey, version])

  const q = query.trim().toLowerCase()
  const shown = (rows ?? []).filter((r) => !q || r.name.toLowerCase().includes(q))
  /** What the sales and the charges do not explain: the inventory shortfall, as a quantity and a value (a loss is < 0). */
  const loss = (r: ConsumptionRow) => stockValue(r.inventory_gap, r.last_price)
  /** The unexplained share: inventory gaps / theoretical consumption, with the sign of the gap (charges are declared, so left out). */
  const gapPct = (r: ConsumptionRow) => (r.theoretical > 0 ? Math.round((r.inventory_gap / r.theoretical) * 1000) / 10 : null)
  const totalLoss = round2(shown.reduce((a, r) => a + (loss(r) ?? 0), 0))
  const theoreticalValue = round2(shown.reduce((a, r) => a + (stockValue(r.theoretical, r.last_price) ?? 0), 0))
  const lastDay = isoDay(new Date(endKey - 1))

  function exportCsv() {
    download(`smile-signature_consommation_${isoDay(p.start)}_${lastDay}.csv`, toCsv(shown.map((r) => ({
      [t.stateColArticle]: r.name,
      [t.colUnit]: r.unit,
      [t.consColTheory]: csvNum(r.theoretical),
      [t.consColCharges]: csvNum(r.charges),
      [t.consColGap]: csvNum(r.inventory_gap),
      [t.consColActual]: csvNum(r.actual),
      [t.consColGapPct]: csvNum(gapPct(r)),
      [t.consColLoss]: csvNum(loss(r)),
    }))), 'text/csv;charset=utf-8')
  }

  return (
    <section className="panel">
      <div className="bo-toolbar pur-filters state-filters">
        <PeriodFields p={p} />
        <label>
          {t.search.replace('…', '')}
          <input type="search" className="bo-search" placeholder={t.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="spacer" />
        <button onClick={exportCsv} disabled={!shown.length}>{t.stateExport}</button>
      </div>
      <p className="muted small">{t.consIntro}</p>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {!rows ? (
        !error && <p className="muted">{t.loading}</p>
      ) : !shown.length ? (
        <p className="muted small">{rows.length ? t.stateNone : t.consNone}</p>
      ) : (
        <table className="bo-table payroll-table state-table report-table">
          <thead>
            <tr>
              <th>{t.stateColArticle}</th>
              <th className="num">{t.consColTheory}</th>
              <th className="num">{t.consColCharges}</th>
              <th className="num">{t.consColGap}</th>
              <th className="num">{t.consColActual}</th>
              <th className="num">{t.consColGapPct}</th>
              <th className="num">{t.consColLoss}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const pct = gapPct(r)
              const value = loss(r)
              return (
                <tr key={r.id} className={r.inventory_gap < 0 ? 'state-low' : undefined}>
                  <td className="payroll-name"><bdi>{r.name}</bdi></td>
                  <td className="num" data-label={t.consColTheory}>{r.theoretical ? <bdi>{qtyText({ quantity: r.theoretical, unit: r.unit })}</bdi> : '—'}</td>
                  <td className="num" data-label={t.consColCharges}>{r.charges ? <bdi>{qtyText({ quantity: r.charges, unit: r.unit })}</bdi> : '—'}</td>
                  <td className="num" data-label={t.consColGap}>
                    {r.inventory_gap ? <bdi className={r.inventory_gap < 0 ? 'neg' : 'pos'}>{signed(r, r.inventory_gap)}</bdi> : '—'}
                  </td>
                  <td className="num strong" data-label={t.consColActual}><bdi>{qtyText({ quantity: r.actual, unit: r.unit })}</bdi></td>
                  <td className={`num${pct ? (pct < 0 ? ' neg' : ' pos') : ''}`} data-label={t.consColGapPct}>
                    {pct == null ? '—' : `${pct > 0 ? '+' : ''}${pct.toLocaleString('fr-FR')} %`}
                  </td>
                  <td className="num" data-label={t.consColLoss} title={r.inventory_gap && value == null ? t.invNoPrice : undefined}>
                    {value == null || !r.inventory_gap ? '—' : <span className={value < 0 ? 'neg' : 'pos'}>{signedMoney(value)}</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {rows && shown.length > 0 && (
        <section className="stat-tiles moves-tiles" aria-live="polite">
          <div className="stat-tile">
            <span className="muted small">{t.consTheoryValue}</span>
            <strong>{money(theoreticalValue)}</strong>
          </div>
          <div className="stat-tile main">
            <span className="muted small">{t.consLossTotal}</span>
            <strong className={totalLoss < 0 ? 'neg' : ''}>{signedMoney(totalLoss)}</strong>
          </div>
        </section>
      )}
      <p className="muted small">{t.consNote}</p>
    </section>
  )
}

// ───────────── Inventaire physique ─────────────

const countKey = (id: string, l: StockLocation) => `${id}:${l}`

function InventoryForm({ items, onReload, onDone, onAbandon }: {
  items: StockStateRow[]
  onReload(): Promise<void>
  onDone(message: string): void
  onAbandon(): void
}) {
  const { t } = useI18n()
  /** Theoretical quantities taken when the count starts; the database refuses the inventory if they moved since. */
  const [snapshot, setSnapshot] = useState(items)
  const [location, setLocation] = useState<StockLocation>('depot')
  const [counts, setCounts] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshed, setRefreshed] = useState(false)
  const dialog = useDialog()

  const held = (s: StockStateRow, l: StockLocation) => (l === 'depot' ? s.quantity : s.kitchen_quantity)
  const lines = snapshot.flatMap((s) => (['depot', 'kitchen'] as const).flatMap((l) => {
    const raw = counts[countKey(s.id, l)] ?? ''
    if (!raw.trim()) return []
    const counted = parseNum(raw)
    const gap = counted == null ? null : round3(counted - held(s, l))
    return [{ item: s, location: l, raw, counted, gap, value: gap == null ? null : stockValue(gap, s.last_price) }]
  }))
  const invalid = lines.filter((l) => l.counted == null || l.counted < 0)
  const gapValue = round2(lines.reduce((a, l) => a + (l.value ?? 0), 0))
  const perLocation = (l: StockLocation) => lines.filter((x) => x.location === l).length

  const q = query.trim().toLowerCase()
  const shown = snapshot.filter((s) => !q || s.name.toLowerCase().includes(q))

  async function validate() {
    setError(null)
    if (!lines.length) return setError(t.errInventoryEmpty)
    if (invalid.length) return setError(`${invalid[0].item.name} : ${t.errQuantity}`)
    if (!(await dialog.confirm(t.invConfirm(lines.length, signedMoney(gapValue)), t.invValidate))) return
    setBusy(true)
    try {
      const inv = await stockState.recordInventory(
        lines.map((l) => ({ stock_item_id: l.item.id, location: l.location, counted: l.counted!, expected: held(l.item, l.location) })),
        note,
      )
      onDone(t.invSaved(inv.line_count, signedMoney(inv.gap_value)))
    } catch (e) {
      setError(errorText(e))
      if (e instanceof InventoryStaleError) {
        // New theoretical quantities, counts kept: the user checks and validates again.
        try {
          setSnapshot(await stockState.overview())
          setRefreshed(true)
          await onReload()
        } catch {
          // The error above stays shown.
        }
      }
    }
    setBusy(false)
  }

  return (
    <section className="panel">
      <h2>{t.invTitle}</h2>
      <p className="muted small">{t.invIntro}</p>
      <div className="bo-toolbar pur-filters state-filters">
        <div>
          <span className="pur-label-block">{t.invLocation}</span>
          <div className="segmented" role="radiogroup" aria-label={t.invLocation}>
            {(['depot', 'kitchen'] as const).map((l) => (
              <button key={l} type="button" role="radio" aria-checked={location === l} className={location === l ? 'on' : ''} onClick={() => setLocation(l)}>
                {t.stockLocation[l]}{perLocation(l) ? ` (${perLocation(l)})` : ''}
              </button>
            ))}
          </div>
        </div>
        <label>
          {t.search.replace('…', '')}
          <input type="search" className="bo-search" placeholder={t.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      {refreshed && <div className="banner" role="status">{t.invReloaded}</div>}
      {error && <p className="error small" role="alert">{error}</p>}

      {!shown.length ? (
        <p className="muted small">{snapshot.length ? t.stateNone : t.noStock}</p>
      ) : (
        <table className="bo-table payroll-table state-table inventory-table">
          <thead>
            <tr>
              <th>{t.stateColArticle}</th>
              <th className="num">{t.invColTheory}</th>
              <th className="num">{t.invColCounted}</th>
              <th className="num">{t.invColGap}</th>
              <th className="num">{t.invColGapValue}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => {
              const key = countKey(s.id, location)
              const raw = counts[key] ?? ''
              const counted = parseNum(raw)
              const bad = raw.trim() !== '' && (counted == null || counted < 0)
              const gap = counted == null || bad ? null : round3(counted - held(s, location))
              const value = gap == null ? null : stockValue(gap, s.last_price)
              return (
                <tr key={s.id} className={raw.trim() ? 'inv-counted' : undefined}>
                  <td className="payroll-name"><bdi>{s.name}</bdi></td>
                  <td className="num" data-label={t.invColTheory}><bdi>{qtyText(s, held(s, location))}</bdi></td>
                  <td className="num" data-label={t.invColCounted}>
                    <span className="moves-qty inv-input">
                      <input dir="ltr" inputMode="decimal" value={raw} placeholder="—" aria-invalid={bad || undefined}
                        aria-label={`${t.invColCounted} ${s.name} (${t.stockLocation[location]})`}
                        onChange={(e) => setCounts((c) => ({ ...c, [key]: e.target.value }))} />
                      {s.unit && <span className="muted small">{s.unit}</span>}
                    </span>
                  </td>
                  <td className="num strong" data-label={t.invColGap}>
                    {gap == null ? '—' : <bdi className={gap < 0 ? 'neg' : gap > 0 ? 'pos' : ''}>{signed(s, gap)}</bdi>}
                  </td>
                  <td className="num" data-label={t.invColGapValue} title={gap != null && value == null ? t.invNoPrice : undefined}>
                    {value == null ? '—' : <span className={value < 0 ? 'neg' : value > 0 ? 'pos' : ''}>{signedMoney(value)}</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <section className="stat-tiles moves-tiles" aria-live="polite">
        <div className="stat-tile">
          <span className="muted small">{t.invLinesCount}</span>
          <strong>{lines.length}</strong>
        </div>
        <div className="stat-tile main">
          <span className="muted small">{t.invGapTotal}</span>
          <strong className={gapValue < 0 ? 'neg' : ''}>{signedMoney(gapValue)}</strong>
        </div>
      </section>
      <label className="res-form">
        {t.moveNote}
        <input value={note} placeholder={t.moveNotePh} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="dialog-actions">
        <button type="button" onClick={onAbandon}>{t.invAbandon}</button>
        <div className="spacer" />
        <button type="button" className="primary" disabled={busy || !lines.length} onClick={validate}>{busy ? t.saving : t.invValidate}</button>
      </div>
      {dialog.element}
    </section>
  )
}

// ───────────── Historique des inventaires ─────────────

function Inventories({ version }: { version: number }) {
  const { t, lang } = useI18n()
  const [rows, setRows] = useState<StockInventory[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [lines, setLines] = useState<StockInventoryLine[] | null>(null)

  useEffect(() => {
    let live = true
    stockState.listInventories().then((r) => live && setRows(r), (e) => live && setError(errorText(e)))
    return () => {
      live = false
    }
  }, [version])
  useEffect(() => {
    if (!open) return
    let live = true
    setLines(null)
    stockState.inventoryLines(open).then((l) => live && setLines(l), (e) => live && setError(errorText(e)))
    return () => {
      live = false
    }
  }, [open])

  const when = (iso: string) => new Date(iso).toLocaleString(locale(lang), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <section className="panel">
      <h2>{t.invHistory}</h2>
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {!rows ? (
        !error && <p className="muted">{t.loading}</p>
      ) : !rows.length ? (
        <p className="muted small">{t.invNone}</p>
      ) : (
        <table className="bo-table payroll-table state-table">
          <thead>
            <tr>
              <th>{t.moveColDate}</th>
              <th>{t.moveColUser}</th>
              <th className="num">{t.invColLines}</th>
              <th className="num">{t.invGapTotal}</th>
              <th>{t.moveNote}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => [
              <tr key={r.id}>
                <td className="payroll-name moves-date">{when(r.created_at)}</td>
                <td data-label={t.moveColUser}><bdi>{r.user_name || '—'}</bdi></td>
                <td className="num" data-label={t.invColLines}>{r.line_count}</td>
                <td className="num strong" data-label={t.invGapTotal}>
                  <span className={r.gap_value < 0 ? 'neg' : r.gap_value > 0 ? 'pos' : ''}>{signedMoney(r.gap_value)}</span>
                </td>
                <td className="muted small moves-note"><bdi>{r.note}</bdi></td>
                <td className="row-actions">
                  <button aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? t.invHide : t.invDetails}</button>
                </td>
              </tr>,
              open === r.id && (
                <tr key={`${r.id}-lines`} className="payroll-history">
                  <td colSpan={6}>
                    {!lines ? (
                      <p className="muted small">{t.loading}</p>
                    ) : (
                      <table className="bo-table inv-lines">
                        <thead>
                          <tr>
                            <th>{t.stateColArticle}</th>
                            <th>{t.invLocation}</th>
                            <th className="num">{t.invColTheory}</th>
                            <th className="num">{t.invColCounted}</th>
                            <th className="num">{t.invColGap}</th>
                            <th className="num">{t.invColGapValue}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {lines.map((l) => {
                            const value = stockValue(l.gap, l.unit_cost)
                            return (
                              <tr key={l.id}>
                                <td><bdi>{l.item_name}</bdi></td>
                                <td>{t.stockLocation[l.location]}</td>
                                <td className="num"><bdi>{qtyText({ quantity: l.theoretical, unit: l.unit })}</bdi></td>
                                <td className="num"><bdi>{qtyText({ quantity: l.counted, unit: l.unit })}</bdi></td>
                                <td className="num strong">
                                  <bdi className={l.gap < 0 ? 'neg' : l.gap > 0 ? 'pos' : ''}>{signed(l, l.gap)}</bdi>
                                </td>
                                <td className="num" title={value == null ? t.invNoPrice : undefined}>{value == null ? '—' : signedMoney(value)}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    )}
                  </td>
                </tr>
              ),
            ])}
          </tbody>
        </table>
      )}
      {rows && rows.length >= INVENTORY_LIMIT && <p className="muted small">{t.moveLimit(INVENTORY_LIMIT)}</p>}
    </section>
  )
}


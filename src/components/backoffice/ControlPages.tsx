import { useCallback, useEffect, useMemo, useState } from 'react'
import { cash } from '../../lib/cash'
import { priceLog } from '../../lib/control'
import { repo } from '../../lib/repo'
import { download, stamp, toCsv } from '../../lib/admin'
import { csvDa, money } from '../../lib/format'
import { useI18n } from '../../lib/i18n'
import { usePermissions } from '../../lib/permissions'
import { placeText } from '../../lib/place'
import { CANCEL_REASONS, type CancelledOrder, type DiningTable, type Order, type PriceChange, type SalesData } from '../../lib/types'
import CancelDialog, { reasonText } from '../CancelDialog'
import PeriodFilter, { initialPeriod, periodRange, rangeLabel, type Period } from './PeriodFilter'
import { locale, useLoad } from './useLoad'

const PRESETS = ['today', '7d', 'month', 'lastMonth', 'custom'] as const
const csvType = 'text/csv;charset=utf-8'

/** Tables by id, to name where each order was ("Table 4", "À emporter n° 12"). */
function useTables() {
  const [tables, setTables] = useState<Map<string, DiningTable>>(new Map())
  useEffect(() => {
    repo.listAllTables().then((l) => setTables(new Map(l.map((x) => [x.id, x]))), () => setTables(new Map()))
  }, [])
  return tables
}

function usePeriod(preset: Period['preset'] = 'month') {
  const [period, setPeriod] = useState<Period>(() => initialPeriod(preset))
  const range = useMemo(() => periodRange(period), [period])
  return { period, setPeriod, range }
}

/** Cancelled orders of a period, reloaded on any order change (shared « orders » channel). */
function useCancelled(range: [Date, Date]) {
  const load = useCallback(() => repo.listCancelled(range[0], range[1]), [range])
  const res = useLoad(load)
  useEffect(() => repo.subscribeOrders(res.reload), [res.reload])
  return res
}

type Numbered = Order & { ticket_no?: number | null }
/** N° of an order: its ticket once paid, else its takeaway / delivery number. */
const orderNo = (o: Order) => (o as Numbered).ticket_no ?? o.takeaway_no ?? o.delivery_no ?? null
/** Billed = cancelled after printing, invoicing or payment: listed in Factures Annulées, not Commandes Annulées. */
const billed = (o: CancelledOrder) => o.voided || !!o.printed_at || o.invoice_no != null

const when = (iso: string | null | undefined, loc: string) =>
  iso ? new Date(iso).toLocaleString(loc, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—'

/** Commandes Annulées: every order cancelled with items, its reason, who, when, and what was already sent to the kitchen. */
export function CancelledOrdersPage() {
  const { t, lang } = useI18n()
  const loc = locale(lang)
  const { period, setPeriod, range } = usePeriod()
  const { data, error, setError } = useCancelled(range)
  const tables = useTables()
  const [reason, setReason] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const rows = (data ?? []).filter((o) => !billed(o) && (!reason || o.cancel_reason === reason))
  const total = Math.round(rows.reduce((s, o) => s + (o.cancelled_total ?? 0), 0) * 100) / 100
  const byReason = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of rows) m.set(o.cancel_reason || '', (m.get(o.cancel_reason || '') ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])
  // Default codes, plus the reasons written in Paramètres > Motifs that appear in the period.
  const reasonOptions = useMemo(() => [...new Set([...CANCEL_REASONS, ...(data ?? []).map((o) => o.cancel_reason).filter((r): r is string => !!r)])], [data])
  const place = (o: Order) => placeText(t, o, o.table_id ? tables.get(o.table_id) ?? null : null)

  const exportCsv = () => download(`commandes-annulees-${stamp()}.csv`, toCsv(rows.map((o) => ({
    [t.cancelledAtCol]: o.cancelled_at, [t.orderNoCol]: orderNo(o) ?? '', [t.placeCol]: place(o), [t.openedAtCol]: o.created_at, [t.dayEmployee]: o.created_by_name ?? '',
    [t.cancelledByCol]: o.cancelled_by_name ?? '', [t.cancelReasonLabel]: o.cancel_reason ? t.cancelReasons[o.cancel_reason] ?? o.cancel_reason : '',
    [t.cancelNoteCol]: o.cancel_note ?? '', [t.itemsCol]: o.lines.map((l) => `${l.quantity} × ${l.name}`).join(' | '),
    [t.sentKitchenCol]: `${o.sent}/${o.lines.length}`, [t.colAmount]: csvDa(o.cancelled_total),
  }))), csvType)

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <div className="bo-toolbar">
        <PeriodFilter value={period} onChange={setPeriod} presets={PRESETS} />
        <span className="muted small">{rangeLabel(range, loc)}</span>
        <select className="auto-width" value={reason} aria-label={t.cancelReasonLabel} onChange={(e) => setReason(e.target.value)}>
          <option value="">{t.allReasons}</option>
          {reasonOptions.map((r) => <option key={r} value={r}>{t.cancelReasons[r] ?? r}</option>)}
        </select>
        <div className="spacer" />
        <button type="button" onClick={exportCsv} disabled={!rows.length}>{t.exportCsv}</button>
      </div>
      <div className="stat-tiles">
        <div className="stat-tile main"><span>{t.cancelledCount}</span><strong>{rows.length}</strong><small className="muted">{money(total)}</small></div>
        {byReason.slice(0, 3).map(([r, n]) => (
          <div key={r} className="stat-tile"><span>{r ? t.cancelReasons[r] ?? r : t.noReason}</span><strong>{n}</strong></div>
        ))}
      </div>
      <section className="panel">
        {!data ? (
          !error && <p className="muted">{t.loading}</p>
        ) : !rows.length ? (
          <p className="muted small">{t.noCancelled}</p>
        ) : (
          <div className="table-scroll">
            <table className="bo-table control-table">
              <thead>
                <tr>
                  <th>{t.cancelledAtCol}</th>
                  <th>{t.orderNoCol}</th>
                  <th>{t.placeCol}</th>
                  <th>{t.itemsCol}</th>
                  <th className="num">{t.colAmount}</th>
                  <th>{t.dayEmployee}</th>
                  <th>{t.cancelReasonLabel}</th>
                  <th>{t.cancelledByCol}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <CancelledRow key={o.id} o={o} place={place(o)} loc={loc} open={open === o.id} onToggle={() => setOpen(open === o.id ? null : o.id)} />
                ))}
              </tbody>
              <tfoot>
                <tr className="total"><td colSpan={4}>{t.total}</td><td className="num">{money(total)}</td><td colSpan={3} /></tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>
    </main>
  )
}

function CancelledRow({ o, place, loc, open, onToggle, kind }: {
  o: CancelledOrder; place: string; loc: string; open: boolean; onToggle(): void
  /** Factures Annulées: what was cancelled (tag) and the cash given back column. */
  kind?: string
}) {
  const { t } = useI18n()
  const no = orderNo(o)
  const qty = o.lines.reduce((s, l) => s + l.quantity, 0)
  return (
    <>
      <tr>
        <td>{when(o.cancelled_at, loc)}</td>
        <td>{no ?? '—'}</td>
        <td>
          {place}
          {kind && <span className={`tag cost-tag ${o.voided ? 'warn' : ''}`}>{kind}</span>}
        </td>
        <td>
          <button type="button" className="link" aria-expanded={open} onClick={onToggle}>{t.itemCount(qty)}</button>
          {o.sent > 0 && <span className="muted small"> · {t.sentKitchen(o.sent, o.lines.length)}</span>}
        </td>
        <td className="num">{money(o.cancelled_total ?? 0)}</td>
        {kind !== undefined && <td className="num">{o.voided ? money(o.void_cash ?? 0) : '—'}</td>}
        <td>{o.created_by_name || '—'}</td>
        <td>{reasonText(t, o.cancel_reason, o.cancel_note) || '—'}</td>
        <td className="muted">{o.cancelled_by_name || '—'}</td>
      </tr>
      {open && (
        <tr className="control-lines">
          <td colSpan={kind !== undefined ? 9 : 8}>
            {o.lines.map((l) => (
              <div key={l.id}>
                {l.quantity} × {l.name}
                {(l.options ?? []).length > 0 && <span className="muted"> ({l.options.map((x) => x.name).join(', ')})</span>}
                {l.sent_at && <span className="muted small"> · {t.sentShort}</span>}
              </div>
            ))}
            <div className="muted small">{t.openedBy(when(o.created_at, loc), o.created_by_name || '—')}</div>
          </td>
        </tr>
      )}
    </>
  )
}

type InvoiceTab = 'list' | 'void'

/** Factures Annulées: tickets cancelled after payment, bills and invoices cancelled after printing; and cancelling a paid ticket. */
export function CancelledInvoicesPage() {
  const { t } = useI18n()
  const { can } = usePermissions()
  const [tab, setTab] = useState<InvoiceTab>('list')
  return (
    <main className="content bo-content">
      {can('cancel_invoice') && (
        <div className="segmented bo-tabs inline-tabs" role="tablist" aria-label={t.cancelledInvoicesTitle}>
          {(['list', 'void'] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {k === 'list' ? t.cancelledInvoicesTitle : t.voidTab}
            </button>
          ))}
        </div>
      )}
      {tab === 'list' ? <CancelledInvoices /> : <VoidTickets onDone={() => setTab('list')} />}
    </main>
  )
}

function CancelledInvoices() {
  const { t, lang } = useI18n()
  const loc = locale(lang)
  const { period, setPeriod, range } = usePeriod()
  const { data, error, setError } = useCancelled(range)
  const tables = useTables()
  const [open, setOpen] = useState<string | null>(null)
  const rows = (data ?? []).filter(billed)
  const sum = (f: (o: CancelledOrder) => number) => Math.round(rows.reduce((s, o) => s + f(o), 0) * 100) / 100
  const place = (o: Order) => placeText(t, o, o.table_id ? tables.get(o.table_id) ?? null : null)
  const kind = (o: CancelledOrder) => (o.voided ? t.kindVoided : o.invoice_no != null ? t.kindInvoice(o.invoice_no) : t.kindPrinted)

  const exportCsv = () => download(`factures-annulees-${stamp()}.csv`, toCsv(rows.map((o) => ({
    [t.cancelledAtCol]: o.cancelled_at, [t.cancelKindCol]: kind(o), [t.orderNoCol]: orderNo(o) ?? '',
    [t.placeCol]: place(o), [t.dayEmployee]: o.created_by_name ?? '', [t.colAmount]: csvDa(o.cancelled_total), [t.cashBackCol]: o.voided ? csvDa(o.void_cash ?? 0) : '',
    [t.cancelReasonLabel]: o.cancel_reason ? t.cancelReasons[o.cancel_reason] ?? o.cancel_reason : '', [t.cancelNoteCol]: o.cancel_note ?? '',
    [t.cancelledByCol]: o.cancelled_by_name ?? '', [t.itemsCol]: o.lines.map((l) => `${l.quantity} × ${l.name}`).join(' | '),
  }))), csvType)

  return (
    <>
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <div className="bo-toolbar">
        <PeriodFilter value={period} onChange={setPeriod} presets={PRESETS} />
        <span className="muted small">{rangeLabel(range, loc)}</span>
        <div className="spacer" />
        <button type="button" onClick={exportCsv} disabled={!rows.length}>{t.exportCsv}</button>
      </div>
      <div className="stat-tiles">
        <div className="stat-tile main"><span>{t.cancelledInvoicesTitle}</span><strong>{rows.length}</strong><small className="muted">{money(sum((o) => o.cancelled_total ?? 0))}</small></div>
        <div className="stat-tile"><span>{t.cashBackCol}</span><strong>{money(sum((o) => (o.voided ? o.void_cash ?? 0 : 0)))}</strong></div>
      </div>
      <section className="panel">
        {!data ? (
          !error && <p className="muted">{t.loading}</p>
        ) : !rows.length ? (
          <p className="muted small">{t.noCancelledInvoices}</p>
        ) : (
          <div className="table-scroll">
            <table className="bo-table control-table">
              <thead>
                <tr>
                  <th>{t.cancelledAtCol}</th>
                  <th>{t.orderNoCol}</th>
                  <th>{t.placeCol}</th>
                  <th>{t.itemsCol}</th>
                  <th className="num">{t.colAmount}</th>
                  <th className="num">{t.cashBackCol}</th>
                  <th>{t.dayEmployee}</th>
                  <th>{t.cancelReasonLabel}</th>
                  <th>{t.cancelledByCol}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <CancelledRow key={o.id} o={o} place={place(o)} loc={loc} kind={kind(o)} open={open === o.id} onToggle={() => setOpen(open === o.id ? null : o.id)} />
                ))}
              </tbody>
              <tfoot>
                <tr className="total">
                  <td colSpan={4}>{t.total}</td>
                  <td className="num">{money(sum((o) => o.cancelled_total ?? 0))}</td>
                  <td className="num">{money(sum((o) => (o.voided ? o.void_cash ?? 0 : 0)))}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="muted small">{t.cancelledInvoicesHint}</p>
      </section>
    </>
  )
}

export type PaidTicket = Order & { total: number | null; closed_at: string | null; ticket_no?: number | null; created_by_name?: string | null }

/** Paid tickets of the period and the cash part of each (the cash given back if one is cancelled). */
export function paidTickets(sales: SalesData) {
  const cashOf = new Map<string, number>()
  for (const p of sales.payments) if (p.method === 'cash') cashOf.set(p.order_id, (cashOf.get(p.order_id) ?? 0) + p.amount)
  return { orders: (sales.orders as PaidTicket[]).slice().sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? '')), cashOf }
}

/**
 * Paid tickets with an « Annuler la facture » button for accounts with cancel_invoice: reason required, the cash part
 * is given back from the open day's drawer (void_paid_order). Used in Factures Annulées and in Statistique Journalier.
 */
export function PaidTicketsTable({ orders, cashOf, onDone }: { orders: PaidTicket[]; cashOf: Map<string, number>; onDone(): void }) {
  const { t, lang } = useI18n()
  const loc = locale(lang)
  const { can } = usePermissions()
  const canVoid = can('cancel_invoice')
  const tables = useTables()
  const [voiding, setVoiding] = useState<PaidTicket | null>(null)
  const place = (o: Order) => placeText(t, o, o.table_id ? tables.get(o.table_id) ?? null : null)
  if (!orders.length) return <p className="muted small">{t.noPaidTickets}</p>
  return (
    <>
      <div className="table-scroll">
        <table className="bo-table control-table">
          <thead>
            <tr>
              <th>{t.ticketCol}</th>
              <th>{t.paidAtCol}</th>
              <th>{t.placeCol}</th>
              <th className="num">{t.colAmount}</th>
              <th className="num">{t.weekCash}</th>
              <th>{t.dayEmployee}</th>
              {canVoid && <th />}
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>{o.ticket_no != null ? t.ticketNo(String(o.ticket_no)) : '—'}</td>
                <td>{when(o.closed_at, loc)}</td>
                <td>{place(o)}</td>
                <td className="num">{money(o.total ?? 0)}</td>
                <td className="num">{money(cashOf.get(o.id) ?? 0)}</td>
                <td>{o.created_by_name || '—'}</td>
                {canVoid && <td className="row-actions"><button type="button" className="danger" onClick={() => setVoiding(o)}>{t.voidBtn}</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {voiding && (
        <CancelDialog
          title={t.voidTitle(voiding.ticket_no != null ? t.ticketNo(String(voiding.ticket_no)) : place(voiding))}
          detail={t.voidDetail(money(voiding.total ?? 0), money(cashOf.get(voiding.id) ?? 0))}
          confirmLabel={t.voidBtn}
          onCancel={() => setVoiding(null)}
          onConfirm={async (why) => {
            await repo.voidTicket(voiding.id, why)
            setVoiding(null)
            onDone()
          }} />
      )}
    </>
  )
}

/** Annuler un ticket encaissé: the paid tickets of a period; cancelling one gives its cash back from the open day's drawer. */
function VoidTickets({ onDone }: { onDone(): void }) {
  const { t, lang } = useI18n()
  const loc = locale(lang)
  const { period, setPeriod, range } = usePeriod('today')
  const load = useCallback(async () => paidTickets(await cash.sales(range[0], range[1])), [range])
  const { data, error, setError, reload } = useLoad(load)
  useEffect(() => repo.subscribeOrders(reload), [reload])
  const tables = useTables()
  const [search, setSearch] = useState('')
  const place = (o: Order) => placeText(t, o, o.table_id ? tables.get(o.table_id) ?? null : null)
  const rows = (data?.orders ?? []).filter((o) => !search.trim() || String(o.ticket_no ?? '').includes(search.trim()) || place(o).toLowerCase().includes(search.trim().toLowerCase()))

  return (
    <>
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <div className="bo-toolbar">
        <PeriodFilter value={period} onChange={setPeriod} presets={PRESETS} />
        <span className="muted small">{rangeLabel(range, loc)}</span>
        <input className="auto-width search-input" type="search" value={search} placeholder={t.voidSearchPh} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="banner">{t.voidHint}</div>
      <section className="panel">
        {!data ? (!error && <p className="muted">{t.loading}</p>) : <PaidTicketsTable orders={rows} cashOf={data.cashOf} onDone={() => { reload(); onDone() }} />}
      </section>
    </>
  )
}

const KINDS = ['item', 'size', 'supplement'] as const

/** Liste des modifications des prix: written automatically on every price change, read only. */
export function PriceLogPage() {
  const { t, lang } = useI18n()
  const loc = locale(lang)
  const { period, setPeriod, range } = usePeriod()
  const load = useCallback(() => priceLog.list(range[0], range[1]), [range])
  const { data, error, setError, reload } = useLoad(load)
  useEffect(() => {
    const offs = [priceLog.subscribe(reload), repo.subscribeOrders(reload)]
    return () => offs.forEach((off) => off())
  }, [reload])
  const [kind, setKind] = useState('')
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const rows = (data ?? []).filter((c) => (!kind || c.kind === kind) && (!q || `${c.item_name} ${c.group_name} ${c.option_name}`.toLowerCase().includes(q)))
  const what = (c: PriceChange) => (c.kind === 'item' ? t.priceKinds.item : `${c.group_name} : ${c.option_name}`)
  const diff = (c: PriceChange) => Math.round((c.new_price - c.old_price) * 100) / 100
  const pct = (c: PriceChange) => (c.old_price > 0 ? Math.round((diff(c) / c.old_price) * 1000) / 10 : null)

  const exportCsv = () => download(`modifications-prix-${stamp()}.csv`, toCsv(rows.map((c) => ({
    [t.colDate]: c.created_at, [t.priceKindCol]: t.priceKinds[c.kind], [t.profitItemCol]: c.item_name, [t.priceWhatCol]: c.kind === 'item' ? '' : `${c.group_name} : ${c.option_name}`,
    [t.priceOldCol]: csvDa(c.old_price), [t.priceNewCol]: csvDa(c.new_price), [t.priceDiffCol]: csvDa(diff(c)), '%': pct(c) ?? '', [t.dayEmployee]: c.user_name,
  }))), csvType)

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <div className="bo-toolbar">
        <PeriodFilter value={period} onChange={setPeriod} presets={PRESETS} />
        <span className="muted small">{rangeLabel(range, loc)}</span>
        <select className="auto-width" value={kind} aria-label={t.priceKindCol} onChange={(e) => setKind(e.target.value)}>
          <option value="">{t.priceAllKinds}</option>
          {KINDS.map((k) => <option key={k} value={k}>{t.priceKinds[k]}</option>)}
        </select>
        <input className="auto-width search-input" type="search" value={search} placeholder={t.priceSearchPh} onChange={(e) => setSearch(e.target.value)} />
        <div className="spacer" />
        <button type="button" onClick={exportCsv} disabled={!rows.length}>{t.exportCsv}</button>
      </div>
      <section className="panel">
        {!data ? (
          !error && <p className="muted">{t.loading}</p>
        ) : !rows.length ? (
          <p className="muted small">{t.noPriceChanges}</p>
        ) : (
          <div className="table-scroll">
            <table className="bo-table control-table">
              <thead>
                <tr>
                  <th>{t.colDate}</th>
                  <th>{t.profitItemCol}</th>
                  <th>{t.priceWhatCol}</th>
                  <th className="num">{t.priceOldCol}</th>
                  <th className="num">{t.priceNewCol}</th>
                  <th className="num">{t.priceDiffCol}</th>
                  <th>{t.dayEmployee}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const d = diff(c)
                  const p = pct(c)
                  return (
                    <tr key={c.id}>
                      <td>{when(c.created_at, loc)}</td>
                      <td>{c.item_name || '—'}</td>
                      <td><span className="tag">{t.priceKinds[c.kind]}</span> {c.kind === 'item' ? '' : what(c)}</td>
                      <td className="num">{money(c.old_price)}</td>
                      <td className="num">{money(c.new_price)}</td>
                      <td className={`num ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}`}>
                        <bdi dir="ltr">{d > 0 ? '+' : d < 0 ? '−' : ''}{money(Math.abs(d))}</bdi>
                        {p !== null && <span className="muted small"> ({p > 0 ? '+' : ''}{p.toLocaleString(loc)} %)</span>}
                      </td>
                      <td className="muted">{c.user_name || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">{t.priceLogHint}</p>
      </section>
    </main>
  )
}


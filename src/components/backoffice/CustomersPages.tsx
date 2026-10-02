import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { customers, searchCustomers } from '../../lib/customers'
import { deliveryZones } from '../../lib/deliveryZones'
import { repo } from '../../lib/repo'
import { download, stamp, toCsv } from '../../lib/admin'
import { csvDa, money } from '../../lib/format'
import { useI18n } from '../../lib/i18n'
import { usePermissions } from '../../lib/permissions'
import { placeText } from '../../lib/place'
import { isCredit, paymentLabel, usePaymentModes } from '../../lib/settings'
import type { Customer, CustomerInvoice, DeliveryZone, DiningTable, InvoiceRow, InvoiceStatus, NewCustomer, OrderLine, PaidOrder, Payment } from '../../lib/types'
import ReceiptDialog from '../ReceiptDialog'
import PeriodFilter, { initialPeriod, periodRange, rangeLabel, type Period } from './PeriodFilter'
import { errorText, locale, useLoad } from './useLoad'
import { serverNow } from '../../lib/serverClock'

const csvType = 'text/csv;charset=utf-8'

function useTables() {
  const [tables, setTables] = useState<Map<string, DiningTable>>(new Map())
  useEffect(() => {
    repo.listAllTables().then((l) => setTables(new Map(l.map((x) => [x.id, x]))), () => setTables(new Map()))
  }, [])
  return tables
}

function useZones() {
  const [zones, setZones] = useState<DeliveryZone[]>([])
  useEffect(() => {
    const load = () => deliveryZones.list().then(setZones, () => setZones([]))
    load()
    return deliveryZones.subscribe(load)
  }, [])
  return zones
}

function useCustomers() {
  const load = useCallback(() => customers.list(), [])
  const res = useLoad(load)
  useEffect(() => customers.subscribe(res.reload), [res.reload])
  return res
}

const dateText = (iso: string | null | undefined, loc: string) =>
  iso ? new Date(iso).toLocaleDateString(loc, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'
const dateTime = (iso: string | null | undefined, loc: string) =>
  iso ? new Date(iso).toLocaleString(loc, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—'
/** Days since a date (ancienneté). */
const ageDays = (iso: string) => Math.max(0, Math.floor((serverNow() - new Date(iso).getTime()) / 86_400_000))

const emptyCustomer = (): NewCustomer => ({ name: '', phone: '', address: '', zone_id: null, note: '', credit_limit: null })

/** Fields of a customer card (Nouveau Client, Modifier). */
export function CustomerForm({ initial, submitLabel, onSubmit, onCancel }: {
  initial?: Customer
  submitLabel: string
  onSubmit(c: NewCustomer): Promise<void>
  onCancel?(): void
}) {
  const { t } = useI18n()
  const zones = useZones()
  const [c, setC] = useState<NewCustomer>(() => (initial ? { ...initial } : emptyCustomer()))
  const [limit, setLimit] = useState(initial?.credit_limit != null ? String(initial.credit_limit) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSubmit({ ...c, credit_limit: limit.trim() === '' ? null : Number(limit.replace(',', '.')) })
    } catch (err) {
      setError(errorText(err))
    }
    setBusy(false)
  }

  return (
    <form className="customer-form" onSubmit={submit}>
      {error && <p className="error small" role="alert">{error}</p>}
      <div className="row">
        <label>
          {t.customerName}
          <input autoFocus value={c.name} maxLength={80} required onChange={(e) => setC({ ...c, name: e.target.value })} />
        </label>
        <label>
          {t.customerPhone}
          <input type="tel" inputMode="tel" dir="ltr" value={c.phone} maxLength={30} onChange={(e) => setC({ ...c, phone: e.target.value })} />
        </label>
      </div>
      <label>
        {t.customerAddress}
        <textarea rows={2} value={c.address} maxLength={300} onChange={(e) => setC({ ...c, address: e.target.value })} />
      </label>
      <div className="row">
        <label>
          {t.deliveryZone}
          <select value={c.zone_id ?? ''} onChange={(e) => setC({ ...c, zone_id: e.target.value || null })}>
            <option value="">{t.deliveryNoZone}</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </label>
        <label>
          {t.creditLimit}
          <input type="number" inputMode="numeric" min={0} step={1} value={limit} placeholder={t.creditLimitNone} onChange={(e) => setLimit(e.target.value)} />
        </label>
      </div>
      <label>
        {t.customerNote}
        <input value={c.note} maxLength={300} placeholder={t.customerNotePh} onChange={(e) => setC({ ...c, note: e.target.value })} />
      </label>
      <div className="dialog-actions">
        {onCancel && <button type="button" onClick={onCancel} disabled={busy}>{t.cancel}</button>}
        <button type="submit" className="primary" disabled={busy}>{busy ? t.saving : submitLabel}</button>
      </div>
    </form>
  )
}

/** Clients > Nouveau Client. */
export function NewCustomerPage({ onSaved }: { onSaved(c: Customer): void }) {
  const { t } = useI18n()
  const [key, setKey] = useState(0)
  return (
    <main className="content bo-content settings-content">
      <section className="panel">
        <h2>{t.customerNewTitle}</h2>
        <p className="muted small">{t.customerNewHint}</p>
        <CustomerForm key={key} submitLabel={t.save} onSubmit={async (c) => {
          const created = await customers.create(c)
          setKey((k) => k + 1)
          onSaved(created)
        }} />
      </section>
    </main>
  )
}

/** Clients > Modifier Clients: search, the customer's card with its history, edit and deactivate. */
export function CustomersList({ highlight, onSettle }: { highlight?: string | null; onSettle?(customerId: string): void }) {
  const { t, lang } = useI18n()
  const loc = locale(lang)
  const { data, error, setError } = useCustomers()
  const zones = useZones()
  const [q, setQ] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [open, setOpen] = useState<string | null>(highlight ?? null)
  useEffect(() => {
    if (highlight) setOpen(highlight)
  }, [highlight])
  const loadDue = useCallback(() => customers.balances(), [])
  const { data: balances, reload: reloadDue } = useLoad(loadDue)
  useEffect(() => customers.subscribe(reloadDue), [reloadDue])
  const due = useMemo(() => new Map((balances ?? []).map((b) => [b.customer.id, b.due])), [balances])
  const rows = searchCustomers((data ?? []).filter((c) => showInactive || c.active), q)
  const selected = data?.find((c) => c.id === open) ?? null

  return (
    <main className="content bo-content customers-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <div className="bo-toolbar">
        <input className="auto-width search-input" type="search" value={q} placeholder={t.customerSearchPh} aria-label={t.customerSearchPh} onChange={(e) => setQ(e.target.value)} />
        <label className="check inline-label">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          {t.customerShowInactive}
        </label>
        <div className="spacer" />
        <span className="muted small">{t.customerCount(rows.length)}</span>
      </div>
      <div className={selected ? 'customers-split' : ''}>
        <section className="panel">
          {!data ? (!error && <p className="muted">{t.loading}</p>) : !rows.length ? <p className="muted">{t.noCustomers}</p> : (
            <div className="table-scroll">
              <table className="bo-table control-table">
                <thead>
                  <tr><th>{t.customerName}</th><th>{t.customerPhone}</th><th>{t.deliveryZone}</th><th className="num">{t.creditDue}</th></tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} className={`${c.id === open ? 'selected' : ''}${c.active ? '' : ' muted'}`}>
                      <td><button className="link" onClick={() => setOpen(c.id === open ? null : c.id)}><bdi>{c.name}</bdi></button>{!c.active && <> <span className="tag">{t.userInactive}</span></>}</td>
                      <td dir="ltr">{c.phone || '—'}</td>
                      <td><bdi>{zones.find((z) => z.id === c.zone_id)?.name ?? '—'}</bdi></td>
                      <td className="num">{due.get(c.id) ? <strong className="neg">{money(due.get(c.id)!)}</strong> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {selected && <CustomerCard key={selected.id} customer={selected} loc={loc} zones={zones} onClose={() => setOpen(null)} onSettle={onSettle} />}
      </div>
    </main>
  )
}

/** Fiche client: details, history, favourite items, credit. */
function CustomerCard({ customer, loc, zones, onClose, onSettle }: { customer: Customer; loc: string; zones: DeliveryZone[]; onClose(): void; onSettle?(id: string): void }) {
  const { t } = useI18n()
  const { can } = usePermissions()
  const tables = useTables()
  const load = useCallback(() => customers.history(customer.id), [customer.id])
  const { data: h, error, setError, reload } = useLoad(load)
  useEffect(() => customers.subscribe(reload), [reload])
  const [editing, setEditing] = useState(false)
  const modes = usePaymentModes()

  async function toggleActive() {
    try {
      setError(null)
      await customers.update(customer.id, { active: !customer.active })
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <section className="panel customer-card" aria-label={customer.name}>
      <div className="panel-head">
        <h2><bdi>{customer.name}</bdi></h2>
        <button className="ghost" onClick={onClose} aria-label={t.close}>✕</button>
      </div>
      {error && <p className="error small">{error}</p>}
      {editing ? (
        <CustomerForm initial={customer} submitLabel={t.save} onCancel={() => setEditing(false)}
          onSubmit={async (c) => { await customers.update(customer.id, c); setEditing(false) }} />
      ) : (
        <>
          <dl className="customer-facts">
            <dt>{t.customerPhone}</dt><dd dir="ltr">{customer.phone || '—'}</dd>
            <dt>{t.customerAddress}</dt><dd><bdi>{customer.address || '—'}</bdi></dd>
            <dt>{t.deliveryZone}</dt><dd><bdi>{zones.find((z) => z.id === customer.zone_id)?.name ?? '—'}</bdi></dd>
            {customer.note && <><dt>{t.customerNote}</dt><dd><bdi>{customer.note}</bdi></dd></>}
            <dt>{t.creditLimit}</dt><dd>{customer.credit_limit == null ? t.creditLimitNone : money(customer.credit_limit)}</dd>
          </dl>
          {can('customers') && (
            <div className="row-actions">
              <button onClick={() => setEditing(true)}>{t.edit}</button>
              <button className={customer.active ? 'danger' : ''} onClick={toggleActive}>{customer.active ? t.customerDeactivate : t.customerActivate}</button>
            </div>
          )}
        </>
      )}
      {!h ? <p className="muted">{t.loading}</p> : (
        <>
          <div className="stat-tiles">
            <div className="stat-tile"><span>{t.customerSpent}</span><strong>{money(h.spent)}</strong></div>
            <div className="stat-tile"><span>{t.customerVisits}</span><strong>{h.visits}</strong></div>
            <div className="stat-tile"><span>{t.customerLast}</span><strong className="small">{dateText(h.last, loc)}</strong></div>
            <div className="stat-tile main"><span>{t.creditBalance}</span><strong className={h.due ? 'neg' : ''}>{money(h.due)}</strong>
              {h.due > 0 && onSettle && can('credit_settle') && <button className="link" onClick={() => onSettle(customer.id)}>{t.settleAction}</button>}
            </div>
          </div>
          {h.topItems.length > 0 && (
            <p className="small"><strong>{t.customerTopItems}</strong> {h.topItems.map((i) => `${i.name} (${i.quantity})`).join(t.listSep)}</p>
          )}
          <h3 className="day-sub">{t.customerOrders}</h3>
          {!h.orders.length ? <p className="muted small">{t.customerNoOrders}</p> : (
            <div className="table-scroll">
              <table className="bo-table control-table">
                <thead><tr><th>{t.colDate}</th><th>{t.orderNoCol}</th><th>{t.placeCol}</th><th className="num">{t.colAmount}</th></tr></thead>
                <tbody>
                  {h.orders.slice(0, 100).map((o) => (
                    <tr key={o.id}>
                      <td>{dateTime(o.closed_at, loc)}</td>
                      <td>{o.ticket_no ?? '—'}</td>
                      <td>{placeText(t, o, o.table_id ? tables.get(o.table_id) ?? null : null)}</td>
                      <td className="num">{money(o.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {h.settlements.length > 0 && (
            <>
              <h3 className="day-sub">{t.customerSettlements}</h3>
              <ul className="plain-list small">
                {h.settlements.slice(0, 20).map((s) => (
                  <li key={s.id}>{dateTime(s.created_at, loc)} · {paymentLabel(t, s.method, modes)} · <strong>{money(s.amount)}</strong>{s.user_name && <span className="muted"> · <bdi>{s.user_name}</bdi></span>}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}

/** A customer chosen in a search list (Régler une Facture Client, credit at checkout). */
export function CustomerPicker({ value, onChange, onlyDebtors, list }: {
  value: string | null
  onChange(id: string | null): void
  onlyDebtors?: Set<string>
  list: Customer[]
}) {
  const { t } = useI18n()
  const [q, setQ] = useState('')
  const pool = list.filter((c) => c.active && (!onlyDebtors || onlyDebtors.has(c.id)))
  const rows = searchCustomers(pool, q).slice(0, 30)
  const chosen = list.find((c) => c.id === value)
  if (chosen) {
    return (
      <div className="customer-chosen">
        <strong><bdi>{chosen.name}</bdi></strong> <span className="muted small" dir="ltr">{chosen.phone}</span>
        <button type="button" className="link" onClick={() => onChange(null)}>{t.customerChange}</button>
      </div>
    )
  }
  return (
    <div className="customer-picker">
      <input type="search" value={q} autoFocus placeholder={t.customerSearchPh} aria-label={t.customerSearchPh} onChange={(e) => setQ(e.target.value)} />
      <ul className="pick-list" role="listbox" aria-label={t.customersTitle}>
        {rows.map((c) => (
          <li key={c.id}>
            <button type="button" role="option" aria-selected={false} onClick={() => onChange(c.id)}>
              <bdi>{c.name}</bdi> <span className="muted small" dir="ltr">{c.phone}</span>
            </button>
          </li>
        ))}
        {!rows.length && <li className="muted small">{onlyDebtors ? t.noDebtors : t.noCustomers}</li>}
      </ul>
    </div>
  )
}

/** Clients > Régler une Facture Client: one customer, their unpaid invoices, all / some / a partial amount. */
export function SettlePage({ initialCustomer, onDone }: { initialCustomer?: string | null; onDone?(): void }) {
  const { t, lang } = useI18n()
  const loc = locale(lang)
  const tables = useTables()
  const { data: list, error, setError } = useCustomers()
  const loadBal = useCallback(() => customers.balances(), [])
  const { data: balances, reload: reloadBal } = useLoad(loadBal)
  useEffect(() => customers.subscribe(reloadBal), [reloadBal])
  const [customerId, setCustomerId] = useState<string | null>(initialCustomer ?? null)
  useEffect(() => {
    if (initialCustomer) setCustomerId(initialCustomer)
  }, [initialCustomer])
  const loadUnpaid = useCallback(() => (customerId ? customers.unpaid(customerId) : Promise.resolve([] as CustomerInvoice[])), [customerId])
  const { data: unpaid, reload } = useLoad(loadUnpaid)
  useEffect(() => customers.subscribe(reload), [reload])
  const modes = usePaymentModes().filter((m) => m.active && !isCredit(m.code))
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('cash')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  useEffect(() => {
    setPicked(new Set())
    setAmount('')
  }, [customerId])

  const invoices = unpaid ?? []
  const base = picked.size ? invoices.filter((i) => picked.has(i.order_id)) : invoices
  const baseDue = base.reduce((s, i) => s + i.due, 0)
  const value = amount.trim() === '' ? baseDue : Math.round(Number(amount.replace(',', '.')))
  const valid = !!customerId && Number.isFinite(value) && value > 0 && value <= baseDue
  const debtors = useMemo(() => new Set((balances ?? []).map((b) => b.customer.id)), [balances])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!customerId || !valid) return
    setBusy(true)
    setDone(null)
    try {
      setError(null)
      const s = await customers.settle(customerId, value, method, picked.size ? [...picked] : undefined, note)
      setDone(t.settleDone(money(s.amount), paymentLabel(t, s.method, modes)))
      setAmount('')
      setNote('')
      setPicked(new Set())
      await reload()
      onDone?.()
    } catch (err) {
      setError(errorText(err))
    }
    setBusy(false)
  }

  const toggle = (id: string) => setPicked((p) => {
    const next = new Set(p)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <main className="content bo-content settings-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {done && <div className="banner ok" onClick={() => setDone(null)}>{done}</div>}
      <section className="panel">
        <h2>{t.settleCustomer}</h2>
        {list ? <CustomerPicker list={list} value={customerId} onChange={setCustomerId} onlyDebtors={customerId ? undefined : debtors} /> : <p className="muted">{t.loading}</p>}
      </section>
      {customerId && (
        <section className="panel">
          <h2>{t.settleInvoices}</h2>
          {!invoices.length ? <p className="muted">{t.errNothingDue}</p> : (
            <form onSubmit={submit}>
              <p className="muted small">{t.settleHint}</p>
              <div className="table-scroll">
                <table className="bo-table control-table">
                  <thead>
                    <tr><th aria-label={t.settlePick} /><th>{t.colDate}</th><th>{t.orderNoCol}</th><th>{t.placeCol}</th><th className="num">{t.creditCol}</th><th className="num">{t.settledCol}</th><th className="num">{t.creditDue}</th></tr>
                  </thead>
                  <tbody>
                    {invoices.map((i) => (
                      <tr key={i.order_id} className={picked.has(i.order_id) ? 'selected' : ''}>
                        <td><input type="checkbox" checked={picked.has(i.order_id)} aria-label={t.settlePickInvoice(String(i.ticket_no ?? ''))} onChange={() => toggle(i.order_id)} /></td>
                        <td>{dateTime(i.closed_at, loc)} <span className="muted small">({t.daysAgo(ageDays(i.closed_at))})</span></td>
                        <td>{i.ticket_no ?? '—'}</td>
                        <td>{placeText(t, i, i.table_id ? tables.get(i.table_id) ?? null : null)}</td>
                        <td className="num">{money(i.credit)}</td>
                        <td className="num">{i.settled ? money(i.settled) : '—'}</td>
                        <td className="num"><strong>{money(i.due)}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="total"><td colSpan={6}>{picked.size ? t.settleSelectedTotal(picked.size) : t.settleAllTotal}</td><td className="num">{money(baseDue)}</td></tr>
                  </tfoot>
                </table>
              </div>
              <div className="config-row">
                <label>
                  {t.settleAmount}
                  <input type="number" inputMode="numeric" min={1} max={baseDue} step={1} value={amount} placeholder={String(baseDue)} onChange={(e) => setAmount(e.target.value)} />
                </label>
                <label>
                  {t.payMethodLabel}
                  <select value={method} onChange={(e) => setMethod(e.target.value)}>
                    {modes.map((m) => <option key={m.code} value={m.code}>{paymentLabel(t, m.code, modes)}</option>)}
                  </select>
                </label>
                <label className="grow">
                  {t.settleNote}
                  <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
                </label>
              </div>
              {method === 'cash' && <p className="muted small">{t.settleCashHint}</p>}
              {amount.trim() !== '' && value < baseDue && value > 0 && <p className="muted small">{t.settlePartialHint}</p>}
              <button className="primary" disabled={!valid || busy}>{busy ? t.saving : t.settleConfirm(money(Number.isFinite(value) ? value : 0))}</button>
            </form>
          )}
        </section>
      )}
    </main>
  )
}

/** Clients > Factures Clients (Non Réglées): customers who owe money. */
export function DebtsPage({ onOpenCustomer, onSettle }: { onOpenCustomer?(id: string): void; onSettle?(id: string): void }) {
  const { t, lang } = useI18n()
  const loc = locale(lang)
  const { can } = usePermissions()
  const load = useCallback(() => customers.balances(), [])
  const { data, error, setError, reload } = useLoad(load)
  useEffect(() => customers.subscribe(reload), [reload])
  const [q, setQ] = useState('')
  const [minAge, setMinAge] = useState('')
  const rows = (data ?? []).filter((b) => searchCustomers([b.customer], q).length && (!minAge || ageDays(b.oldest) >= Number(minAge)))
  const total = rows.reduce((s, b) => s + b.due, 0)

  const exportCsv = () => download(`factures-clients-non-reglees-${stamp()}.csv`, toCsv(rows.map((b) => ({
    [t.customerName]: b.customer.name, [t.customerPhone]: b.customer.phone, [t.debtInvoices]: b.invoices, [t.creditDue]: csvDa(b.due),
    [t.debtOldest]: b.oldest.slice(0, 10), [t.debtAge]: ageDays(b.oldest),
  }))), csvType)

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <div className="bo-toolbar">
        <input className="auto-width search-input" type="search" value={q} placeholder={t.customerSearchPh} aria-label={t.customerSearchPh} onChange={(e) => setQ(e.target.value)} />
        <label className="inline-label">
          {t.debtMinAge}
          <input className="auto-width" type="number" min={0} inputMode="numeric" value={minAge} onChange={(e) => setMinAge(e.target.value)} />
        </label>
        <div className="spacer" />
        <button type="button" onClick={exportCsv} disabled={!rows.length}>{t.exportCsv}</button>
      </div>
      <div className="stat-tiles">
        <div className="stat-tile main"><span>{t.debtTotal}</span><strong className={total ? 'neg' : ''}>{money(total)}</strong></div>
        <div className="stat-tile"><span>{t.debtCustomers}</span><strong>{rows.length}</strong></div>
        <div className="stat-tile"><span>{t.debtInvoices}</span><strong>{rows.reduce((s, b) => s + b.invoices, 0)}</strong></div>
      </div>
      <section className="panel">
        {!data ? (!error && <p className="muted">{t.loading}</p>) : !rows.length ? <p className="muted">{t.noDebtors}</p> : (
          <div className="table-scroll">
            <table className="bo-table control-table">
              <thead>
                <tr><th>{t.customerName}</th><th>{t.customerPhone}</th><th className="num">{t.debtInvoices}</th><th className="num">{t.creditDue}</th><th>{t.debtOldest}</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.customer.id}>
                    <td>{onOpenCustomer ? <button className="link" onClick={() => onOpenCustomer(b.customer.id)}><bdi>{b.customer.name}</bdi></button> : <bdi>{b.customer.name}</bdi>}</td>
                    <td dir="ltr">{b.customer.phone || '—'}</td>
                    <td className="num">{b.invoices}</td>
                    <td className="num"><strong className="neg">{money(b.due)}</strong></td>
                    <td>{dateText(b.oldest, loc)} <span className={ageDays(b.oldest) > 30 ? 'tag warn' : 'muted small'}>{t.daysAgo(ageDays(b.oldest))}</span></td>
                    <td className="row-actions">{onSettle && can('credit_settle') && <button onClick={() => onSettle(b.customer.id)}>{t.settleAction}</button>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="total"><td colSpan={3}>{t.debtTotal}</td><td className="num">{money(total)}</td><td colSpan={2} /></tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>
    </main>
  )
}

const STATUSES: InvoiceStatus[] = ['paid', 'credit', 'cancelled']
const PRESETS = ['today', '7d', 'month', 'lastMonth', 'custom'] as const

/** Clients > Toutes les Factures: search by number, date, customer, table, type, amount and status; ticket preview. */
export function AllInvoicesPage() {
  const { t, lang } = useI18n()
  const loc = locale(lang)
  const tables = useTables()
  const modes = usePaymentModes()
  const [period, setPeriod] = useState<Period>(() => initialPeriod('today'))
  const range = useMemo(() => periodRange(period), [period])
  const load = useCallback(() => customers.invoices(range[0], range[1]), [range])
  const { data, error, setError, reload } = useLoad(load)
  useEffect(() => customers.subscribe(reload), [reload])
  const [no, setNo] = useState('')
  const [who, setWho] = useState('')
  const [table, setTable] = useState('')
  const [type, setType] = useState('')
  const [status, setStatus] = useState('')
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const [preview, setPreview] = useState<{ order: PaidOrder; lines: OrderLine[]; payments: Payment[]; place: string } | null>(null)

  const place = (r: InvoiceRow) => placeText(t, r.order, r.order.table_id ? tables.get(r.order.table_id) ?? null : null)
  const rows = (data ?? []).filter((r) => {
    const o = r.order
    if (no && ![o.ticket_no, o.invoice_no, o.takeaway_no, o.delivery_no].some((n) => n != null && String(n) === no.trim())) return false
    if (who && !r.customer.toLowerCase().includes(who.trim().toLowerCase())) return false
    if (table && o.table_id !== table) return false
    if (type && o.order_type !== type) return false
    if (status && r.status !== status) return false
    if (min && r.amount < Number(min)) return false
    if (max && r.amount > Number(max)) return false
    return true
  })
  const total = rows.filter((r) => r.status !== 'cancelled').reduce((s, r) => s + r.amount, 0)

  async function show(r: InvoiceRow) {
    try {
      setError(null)
      const d = await customers.invoiceDetail(r.order.id)
      setPreview({ ...d, place: place(r) })
    } catch (e) {
      setError(errorText(e))
    }
  }

  const exportCsv = () => download(`factures-${stamp()}.csv`, toCsv(rows.map((r) => ({
    [t.colDate]: r.at, [t.orderNoCol]: r.order.ticket_no ?? '', [t.placeCol]: place(r), [t.customerName]: r.customer,
    [t.invoiceStatusCol]: t.invoiceStatus[r.status], [t.payMethodLabel]: r.methods.map((m) => paymentLabel(t, m, modes)).join(' + '),
    [t.colAmount]: csvDa(r.amount), [t.creditDue]: r.due ? csvDa(r.due) : '',
  }))), csvType)

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <div className="bo-toolbar">
        <PeriodFilter value={period} onChange={setPeriod} presets={PRESETS} />
        <span className="muted small">{rangeLabel(range, loc)}</span>
        <div className="spacer" />
        <button type="button" onClick={exportCsv} disabled={!rows.length}>{t.exportCsv}</button>
      </div>
      <div className="bo-toolbar invoice-filters">
        <input className="auto-width" inputMode="numeric" value={no} placeholder={t.invoiceNoPh} aria-label={t.orderNoCol} onChange={(e) => setNo(e.target.value)} />
        <input className="auto-width" value={who} placeholder={t.customerName} aria-label={t.customerName} onChange={(e) => setWho(e.target.value)} />
        <select className="auto-width" value={table} aria-label={t.placeCol} onChange={(e) => setTable(e.target.value)}>
          <option value="">{t.allTables}</option>
          {[...tables.values()].map((x) => <option key={x.id} value={x.id}>{t.table(x.label)}</option>)}
        </select>
        <select className="auto-width" value={type} aria-label={t.dayByType} onChange={(e) => setType(e.target.value)}>
          <option value="">{t.allTypes}</option>
          {(['dine_in', 'takeaway', 'delivery'] as const).map((k) => <option key={k} value={k}>{t.dayTypes[k]}</option>)}
        </select>
        <select className="auto-width" value={status} aria-label={t.invoiceStatusCol} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t.allStatuses}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{t.invoiceStatus[s]}</option>)}
        </select>
        <input className="auto-width amount-filter" type="number" min={0} inputMode="numeric" value={min} placeholder={t.amountMin} aria-label={t.amountMin} onChange={(e) => setMin(e.target.value)} />
        <input className="auto-width amount-filter" type="number" min={0} inputMode="numeric" value={max} placeholder={t.amountMax} aria-label={t.amountMax} onChange={(e) => setMax(e.target.value)} />
      </div>
      <div className="stat-tiles">
        <div className="stat-tile main"><span>{t.invoicesCount}</span><strong>{rows.length}</strong><small className="muted">{money(total)}</small></div>
        {STATUSES.map((s) => (
          <div key={s} className="stat-tile"><span>{t.invoiceStatus[s]}</span><strong>{rows.filter((r) => r.status === s).length}</strong></div>
        ))}
      </div>
      <section className="panel">
        {!data ? (!error && <p className="muted">{t.loading}</p>) : !rows.length ? <p className="muted">{t.noInvoices}</p> : (
          <div className="table-scroll">
            <table className="bo-table control-table">
              <thead>
                <tr><th>{t.colDate}</th><th>{t.orderNoCol}</th><th>{t.placeCol}</th><th>{t.customerName}</th><th>{t.payMethodLabel}</th><th>{t.invoiceStatusCol}</th><th className="num">{t.colAmount}</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.order.id} className={r.status === 'cancelled' ? 'muted' : ''}>
                    <td>{dateTime(r.at, loc)}</td>
                    <td>{r.order.ticket_no ?? '—'}{r.order.invoice_no != null && <span className="muted small"> · F{r.order.invoice_no}</span>}</td>
                    <td>{place(r)}</td>
                    <td><bdi>{r.customer || '—'}</bdi></td>
                    <td>{r.methods.map((m) => paymentLabel(t, m, modes)).join(' + ') || '—'}</td>
                    <td><span className={`tag invoice-${r.status}`}>{t.invoiceStatus[r.status]}</span>{r.due > 0 && <span className="muted small"> {money(r.due)}</span>}</td>
                    <td className="num">{r.status === 'cancelled' ? <s>{money(r.amount)}</s> : money(r.amount)}</td>
                    <td className="row-actions"><button onClick={() => show(r)}>{t.invoicePreview}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {preview && (
        <ReceiptDialog order={preview.order} lines={preview.lines} payments={preview.payments} place={preview.place} hallName={null}
          onDone={() => setPreview(null)} />
      )}
    </main>
  )
}

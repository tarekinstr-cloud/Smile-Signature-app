import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { repo } from '../../lib/repo'
import { reservations } from '../../lib/reservations'
import type { DiningTable, Hall, NewReservation, Reservation, ReservationStatus } from '../../lib/types'
import { useI18n, type Lang } from '../../lib/i18n'
import FloorPlan from '../FloorPlan'
import { useDialog } from '../Dialog'
import { errorText, locale, useLoad } from './useLoad'

/** Halls with their tables, for the form's floor plan, the list's places and the Honorée dialog. */
function useFloor() {
  const load = useCallback(async () => {
    const halls = await repo.listHalls()
    const tables = (await Promise.all(halls.map((h) => repo.listTables(h.id)))).flat()
    return { halls, tables }
  }, [])
  return useLoad(load)
}

const pad = (n: number) => String(n).padStart(2, '0')
/** yyyy-mm-dd and hh:mm of a date in local time, for the date and time inputs. */
const dateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const timeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

export const timeText = (iso: string, lang: Lang) => new Date(iso).toLocaleTimeString(locale(lang), { hour: '2-digit', minute: '2-digit' })
/** Short date, with the year only when it is not the current one. */
const dateText = (iso: string, lang: Lang) => {
  const d = new Date(iso)
  return d.toLocaleDateString(locale(lang), {
    weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }),
  })
}

/** Two bookings of the same table closer than this are flagged in the form (not refused). */
const CONFLICT_HOURS = 2

interface FormProps {
  /** The booking being edited, or null for a new one. */
  initial: Reservation | null
  onSaved(r: Reservation | null): void
  onCancel?(): void
}

/**
 * Nouvelle réservation (and editing one): customer, number of people, date and time, hall, and the table chosen on the
 * hall's plan or no preference. Conflicts, past dates and too-small tables are warnings, the booking is still saved.
 */
export function ReservationForm({ initial, onSaved, onCancel }: FormProps) {
  const { t, lang } = useI18n()
  const floor = useFloor()
  const [others, setOthers] = useState<Reservation[]>([])
  const start = useMemo(() => {
    if (initial) return new Date(initial.reserved_at)
    // Next half hour, a sensible default for a phone booking.
    const d = new Date(Date.now() + 30 * 60_000)
    d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0)
    return d
  }, [initial])
  const [name, setName] = useState(initial?.client_name ?? '')
  const [phone, setPhone] = useState(initial?.phone ?? '')
  const [party, setParty] = useState(String(initial?.party_size ?? 2))
  const [date, setDate] = useState(dateInput(start))
  const [time, setTime] = useState(timeInput(start))
  const [hallId, setHallId] = useState<string | null>(initial?.hall_id ?? null)
  const [tableId, setTableId] = useState<string | null>(initial?.table_id ?? null)
  const [status, setStatus] = useState<ReservationStatus>(initial?.status ?? 'confirmed')
  const [note, setNote] = useState(initial?.note ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    reservations.list().then(setOthers, () => setOthers([]))
  }, [])
  // First hall by default.
  useEffect(() => {
    if (!hallId && floor.data?.halls[0]) setHallId(floor.data.halls[0].id)
  }, [floor.data, hallId])

  const hall: Hall | null = floor.data?.halls.find((h) => h.id === hallId) ?? null
  const hallTables = floor.data?.tables.filter((x) => x.hall_id === hallId) ?? []
  const table = hallTables.find((x) => x.id === tableId) ?? null
  const when = new Date(`${date}T${time}`)
  const valid = !Number.isNaN(when.getTime())

  const conflict = valid && table
    ? others.find((o) => o.id !== initial?.id && o.status === 'confirmed' && o.table_id === table.id
      && Math.abs(new Date(o.reserved_at).getTime() - when.getTime()) < CONFLICT_HOURS * 3_600_000)
    : undefined
  const warnings = [
    conflict && t.resConflict(table!.label, timeText(conflict.reserved_at, lang), conflict.client_name),
    valid && !initial && when.getTime() < Date.now() && t.resInPast,
    table && Number(party) > table.seats && t.resTooBig(table.seats),
  ].filter(Boolean) as string[]

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError(t.errResName)
    if (!valid) return setError(t.errResDate)
    if (!hallId) return setError(t.errResHall)
    const fields: NewReservation = {
      client_name: name, phone, party_size: Number(party), hall_id: hallId, table_id: table?.id ?? null,
      reserved_at: when.toISOString(), note,
    }
    setBusy(true)
    try {
      setError(null)
      if (initial) {
        await reservations.update(initial.id, { ...fields, status })
        onSaved(null)
      } else {
        onSaved(await reservations.create(fields))
      }
    } catch (err) {
      setError(errorText(err))
    }
    setBusy(false)
  }

  return (
    <form className="res-form" onSubmit={save}>
      {(error || floor.error) && <p className="error small" role="alert">{error ?? floor.error}</p>}
      <div className="res-grid">
        <label>
          {t.resClient}
          <input autoFocus={!initial} value={name} placeholder={t.resClientPh} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {t.resPhone}
          <input dir="ltr" type="tel" inputMode="tel" value={phone} placeholder="0550 00 00 00" onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label>
          {t.resParty}
          <input type="number" inputMode="numeric" min={1} max={200} value={party} onChange={(e) => setParty(e.target.value)} />
        </label>
        <label>
          {t.resDate}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          {t.resTime}
          <input type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
        <label>
          {t.resHall}
          <select value={hallId ?? ''} onChange={(e) => { setHallId(e.target.value || null); setTableId(null) }}>
            {!floor.data?.halls.length && <option value="">—</option>}
            {floor.data?.halls.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        </label>
        <label>
          {t.resTable}
          <select value={table?.id ?? ''} onChange={(e) => setTableId(e.target.value || null)}>
            <option value="">{t.resNoTable}</option>
            {hallTables.map((x) => <option key={x.id} value={x.id}>{t.table(x.label)} · {x.seats} 👤</option>)}
          </select>
        </label>
        {initial && (
          <label>
            {t.colStatus}
            <select value={status} onChange={(e) => setStatus(e.target.value as ReservationStatus)}>
              {(['confirmed', 'honored', 'cancelled', 'no_show'] as const).map((s) => <option key={s} value={s}>{t.resStatuses[s]}</option>)}
            </select>
          </label>
        )}
      </div>
      {hall && hallTables.length > 0 && (
        <div className="res-plan">
          <p className="muted small">{t.resTableHint}</p>
          <FloorPlan hall={hall} tables={hallTables} editable={false} selectedId={table?.id ?? null}
            onSelect={() => setTableId(null)} onTap={(x) => setTableId(x.id === tableId ? null : x.id)} onMove={() => {}} />
        </div>
      )}
      <label>
        {t.resNote}
        <textarea rows={2} value={note} placeholder={t.resNotePh} onChange={(e) => setNote(e.target.value)} />
      </label>
      {warnings.map((w) => <p key={w} className="res-warning small">{w}</p>)}
      <div className="dialog-actions">
        {onCancel && <button type="button" onClick={onCancel}>{t.cancel}</button>}
        <button type="submit" className="primary" disabled={busy}>{initial ? t.save : t.resSave}</button>
      </div>
    </form>
  )
}

/** Where a booking is: hall, and table or « salle uniquement ». */
function placeOf(r: Reservation, halls: Hall[], tables: DiningTable[], t: ReturnType<typeof useI18n>['t']) {
  const hall = halls.find((h) => h.id === r.hall_id)
  const table = tables.find((x) => x.id === r.table_id)
  return <><bdi>{hall?.name ?? t.resDeletedHall}</bdi> · {table ? t.table(table.label) : t.resHallOnly}</>
}

interface ListProps {
  /** Honorée: opens the order of the table where the customer sits. */
  onOpenOrder(hallId: string, tableId: string): void
  /** The booking just created, to highlight in the list. */
  highlight?: string | null
}

/**
 * Liste des réservations: upcoming (from today on, earliest first) or past (latest first), with their status. A
 * confirmed booking gets Honorée (seats the customer and opens the table's order), Annulée and No-show.
 */
export function ReservationsList({ onOpenOrder, highlight }: ListProps) {
  const { t, lang } = useI18n()
  const load = useCallback(() => reservations.list(), [])
  const { data, error, setError, reload } = useLoad(load)
  const floor = useFloor()
  const [view, setView] = useState<'upcoming' | 'past'>('upcoming')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Reservation | null>(null)
  const [honoring, setHonoring] = useState<Reservation | null>(null)
  const dialog = useDialog()

  useEffect(() => reservations.subscribe(() => reload()), [reload])

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const q = query.trim().toLowerCase()
  const rows = (data ?? [])
    .filter((r) => (new Date(r.reserved_at) >= today) === (view === 'upcoming'))
    .filter((r) => !q || `${r.client_name} ${r.phone} ${r.note}`.toLowerCase().includes(q))
  if (view === 'past') rows.reverse()
  const halls = floor.data?.halls ?? []
  const tables = floor.data?.tables ?? []

  async function setStatus(r: Reservation, status: ReservationStatus) {
    const ask = status === 'cancelled' ? t.resConfirmCancel(r.client_name) : status === 'no_show' ? t.resConfirmNoShow(r.client_name) : null
    if (ask && !(await dialog.confirm(ask))) return
    try {
      setError(null)
      await reservations.update(r.id, { status })
      await reload()
    } catch (err) {
      setError(errorText(err))
    }
  }

  /** Honorée: straight to the order when the booked table is free, otherwise choose where to seat the customer. */
  async function honor(r: Reservation) {
    const table = tables.find((x) => x.id === r.table_id)
    if (table && table.status === 'free') return seat(r, table)
    setHonoring(r)
  }

  async function seat(r: Reservation, table: DiningTable) {
    try {
      setError(null)
      await reservations.update(r.id, { status: 'honored', hall_id: table.hall_id, table_id: table.id })
      setHonoring(null)
      onOpenOrder(table.hall_id, table.id)
    } catch (err) {
      setError(errorText(err))
      setHonoring(null)
    }
  }

  return (
    <main className="content bo-content">
      {(error || floor.error) && <div className="banner error" onClick={() => setError(null)}>{error ?? floor.error}</div>}
      <section className="panel">
        <div className="panel-head bo-head res-head">
          <div className="segmented" role="tablist" aria-label={t.reservationsTitle}>
            {(['upcoming', 'past'] as const).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
                {v === 'upcoming' ? t.resUpcoming : t.resPast}
              </button>
            ))}
          </div>
          <input type="search" className="bo-search" placeholder={t.search} aria-label={t.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {!data ? (
          !error && <p className="muted">{t.loading}</p>
        ) : rows.length === 0 ? (
          <p className="muted small">{q ? t.noMatch : view === 'upcoming' ? t.resNoneUpcoming : t.resNonePast}</p>
        ) : (
          <table className="bo-table res-table">
            <thead>
              <tr>
                <th>{t.colWhen}</th>
                <th>{t.colClient}</th>
                <th className="hide-phone">{t.colParty}</th>
                <th className="hide-phone">{t.colPlace}</th>
                <th className="hide-phone">{t.colStatus}</th>
                <th className="end">{t.colActions}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const late = r.status === 'confirmed' && new Date(r.reserved_at).getTime() < Date.now()
                const statusTags = (
                  <>
                    <span className={`tag res-status ${r.status}`}>{t.resStatuses[r.status]}</span>
                    {late && <span className="tag warn res-late">{t.resLate}</span>}
                  </>
                )
                return (
                  <tr key={r.id} className={r.id === highlight ? 'highlight' : undefined}>
                    <td>
                      <strong>{timeText(r.reserved_at, lang)}</strong>
                      <div className="muted small">{dateText(r.reserved_at, lang)}</div>
                    </td>
                    <td>
                      <button className="ghost link" onClick={() => setEditing(r)}><bdi>{r.client_name}</bdi></button>
                      {r.phone && <div className="small"><a href={`tel:${r.phone.replace(/[^\d+]/g, '')}`} dir="ltr" title={t.call}>{r.phone}</a></div>}
                      <div className="muted small show-phone">{t.resPartySize(r.party_size)} · {placeOf(r, halls, tables, t)}</div>
                      {r.note && <div className="muted small"><bdi>{r.note}</bdi></div>}
                      <div className="show-phone">{statusTags}</div>
                    </td>
                    <td className="hide-phone">{r.party_size}</td>
                    <td className="hide-phone">{placeOf(r, halls, tables, t)}</td>
                    <td className="hide-phone">{statusTags}</td>
                    <td className="end">
                      {r.status === 'confirmed' && (
                        <div className="res-actions">
                          <button className="primary" onClick={() => honor(r)}>{t.resHonor}</button>
                          <button onClick={() => setStatus(r, 'cancelled')}>{t.resCancel}</button>
                          <button onClick={() => setStatus(r, 'no_show')}>{t.resNoShow}</button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      {editing && (
        <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="dialog res-dialog" role="dialog" aria-modal="true" aria-labelledby="res-edit-title"
            onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}>
            <div className="panel-head">
              <h2 id="res-edit-title">{t.resEdit(editing.client_name)}</h2>
              <button className="ghost" onClick={() => setEditing(null)} aria-label={t.close}>✕</button>
            </div>
            <ReservationForm initial={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); reload() }} />
          </div>
        </div>
      )}
      {honoring && (
        <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setHonoring(null)}>
          <div className="dialog table-actions" role="dialog" aria-modal="true" aria-labelledby="res-honor-title"
            onKeyDown={(e) => e.key === 'Escape' && setHonoring(null)}>
            <div className="panel-head">
              <h2 id="res-honor-title">{t.resHonorTitle(honoring.client_name)}</h2>
              <button className="ghost" onClick={() => setHonoring(null)} aria-label={t.close}>✕</button>
            </div>
            <p className="muted small">{t.resPickTable}</p>
            {/* The booked hall first, then the others. */}
            {[...halls].sort((a, b) => Number(b.id === honoring.hall_id) - Number(a.id === honoring.hall_id)).map((h) => {
              const hs = tables.filter((x) => x.hall_id === h.id)
              if (!hs.length) return null
              return (
                <div key={h.id} className="res-honor-hall">
                  <div className="admin-panel-title">{h.name}</div>
                  <div className="res-honor-tables">
                    {hs.map((x) => (
                      <button key={x.id} className={`res-pick ${x.status}${x.id === honoring.table_id ? ' booked' : ''}`}
                        disabled={x.status !== 'free'} onClick={() => seat(honoring, x)}>
                        <strong>{x.label}</strong>
                        <span className="small">{x.status === 'free' ? `${x.seats} 👤` : t.resTableBusy}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
            {!tables.some((x) => x.status === 'free') && <p className="error small">{t.errResNoTable}</p>}
          </div>
        </div>
      )}
      {dialog.element}
    </main>
  )
}

/** Nouvelle réservation as a page: the form, then the list with the new booking highlighted. */
export function NewReservationPage({ onSaved }: { onSaved(r: Reservation): void }) {
  const { t } = useI18n()
  const [key, setKey] = useState(0)
  return (
    <main className="content bo-content">
      <section className="panel">
        <h2>{t.resNewItem}</h2>
        <ReservationForm key={key} initial={null} onSaved={(r) => { setKey(key + 1); if (r) onSaved(r) }} />
      </section>
    </main>
  )
}

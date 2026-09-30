import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { deliveryZones } from '../../lib/deliveryZones'
import type { DeliveryZone, NewDeliveryZone } from '../../lib/types'
import { useI18n } from '../../lib/i18n'
import { money } from '../../lib/format'
import { useDialog } from '../Dialog'
import { errorText, useLoad } from './useLoad'

interface FormProps {
  /** The zone being edited, or null for a new one. */
  initial: DeliveryZone | null
  onSaved(zone: DeliveryZone | null): void
  onCancel?(): void
}

/** Parses a DA amount typed with a comma or a dot; null when it is not a number. */
const amount = (text: string) => {
  const n = Number(text.replace(/\s/g, '').replace(',', '.'))
  return text.trim() && Number.isFinite(n) ? n : null
}

/** Ajouter une zone de livraison (and editing one): name, fee in DA, estimated time in minutes (optional). */
export function ZoneForm({ initial, onSaved, onCancel }: FormProps) {
  const { t } = useI18n()
  const [name, setName] = useState(initial?.name ?? '')
  const [fee, setFee] = useState(initial ? String(initial.fee) : '')
  const [time, setTime] = useState(initial?.estimated_time ? String(initial.estimated_time) : '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    const feeValue = amount(fee)
    if (!name.trim()) return setError(t.errZoneName)
    if (feeValue === null || feeValue < 0) return setError(t.errZoneFee)
    const minutes = time.trim() ? Number(time) : null
    const zone: NewDeliveryZone = { name, fee: feeValue, estimated_time: minutes }
    setBusy(true)
    try {
      setError(null)
      if (initial) {
        await deliveryZones.update(initial.id, zone)
        onSaved(null)
      } else {
        const created = await deliveryZones.create(zone)
        setName('')
        setFee('')
        setTime('')
        onSaved(created)
      }
    } catch (err) {
      setError(errorText(err))
    }
    setBusy(false)
  }

  return (
    <form className="res-form zone-form" onSubmit={save}>
      {error && <p className="error small" role="alert">{error}</p>}
      <div className="res-grid">
        <label>
          {t.zoneName}
          <input autoFocus value={name} placeholder={t.zoneNamePh} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {t.zoneFee}
          <input dir="ltr" inputMode="decimal" value={fee} placeholder="200" onChange={(e) => setFee(e.target.value)} />
        </label>
        <label>
          {t.zoneTime}
          <input type="number" inputMode="numeric" min={1} max={1440} value={time} placeholder={t.zoneTimePh} onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
      <div className="dialog-actions">
        {onCancel && <button type="button" onClick={onCancel}>{t.cancel}</button>}
        <button type="submit" className="primary" disabled={busy}>{busy ? t.saving : initial ? t.save : t.zoneAddBtn}</button>
      </div>
    </form>
  )
}

/** Ajouter une zone de livraison: the form, and the zones already there under it. */
export function NewZonePage({ onSaved }: { onSaved(zone: DeliveryZone): void }) {
  return (
    <main className="content bo-content">
      <section className="panel">
        <ZoneForm initial={null} onSaved={(z) => z && onSaved(z)} />
      </section>
    </main>
  )
}

/** Modifier une zone de livraison: every zone with its fee and time; tap one to change or delete it. */
export function ZonesList({ highlight }: { highlight?: string | null }) {
  const { t } = useI18n()
  const load = useCallback(() => deliveryZones.list(), [])
  const { data, error, setError, reload } = useLoad(load)
  const [editing, setEditing] = useState<DeliveryZone | null>(null)
  const [query, setQuery] = useState('')
  const dialog = useDialog()

  useEffect(() => deliveryZones.subscribe(() => reload()), [reload])

  async function remove(z: DeliveryZone) {
    if (!(await dialog.confirm(t.zoneConfirmDelete(z.name)))) return
    try {
      setError(null)
      await deliveryZones.remove(z.id)
      setEditing(null)
      await reload()
    } catch (err) {
      setError(errorText(err))
    }
  }

  const q = query.trim().toLowerCase()
  const rows = (data ?? []).filter((z) => !q || z.name.toLowerCase().includes(q))

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <section className="panel">
        <div className="panel-head bo-head">
          <input type="search" className="bo-search" placeholder={t.search} aria-label={t.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {!data ? (
          !error && <p className="muted">{t.loading}</p>
        ) : data.length === 0 ? (
          <p className="muted small">{t.zonesNone}</p>
        ) : rows.length === 0 ? (
          <p className="muted small">{t.noMatch}</p>
        ) : (
          <table className="bo-table zones-table">
            <thead>
              <tr>
                <th>{t.zoneName}</th>
                <th className="num">{t.zoneFee}</th>
                <th className="num">{t.zoneTimeShort}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((z) => (
                <tr key={z.id} className={z.id === highlight ? 'highlight' : undefined}>
                  <td><button className="ghost link" onClick={() => setEditing(z)}><bdi>{z.name}</bdi></button></td>
                  <td className="num">{money(z.fee)}</td>
                  <td className="num">{z.estimated_time ? t.zoneMinutes(z.estimated_time) : '—'}</td>
                  <td className="row-actions">
                    <button onClick={() => setEditing(z)}>{t.edit}</button>
                    <button className="danger" onClick={() => remove(z)}>{t.delete}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {editing && (
        <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="zone-title" onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}>
            <h2 id="zone-title">{t.zoneEditTitle(editing.name)}</h2>
            <ZoneForm initial={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); reload() }} />
          </div>
        </div>
      )}
      {dialog.element}
    </main>
  )
}

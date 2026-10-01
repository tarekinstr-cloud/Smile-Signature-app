import { useEffect, useState, type FormEvent } from 'react'
import type { DeliveryCustomer, DeliveryZone } from '../lib/types'
import { useI18n } from '../lib/i18n'
import { money } from '../lib/format'
import { deliveryZones, zoneLabel } from '../lib/deliveryZones'
import NumberPicker from './NumberPicker'

/** Zone already on the order: its id (null once the zone was deleted), the name and fee copied when it was chosen. */
export interface CurrentZone {
  id: string | null
  name: string | null
  fee: number
}

/** Value of the zone picker for a zone the order keeps although it was deleted from the list. */
const KEPT = 'kept'

interface Props {
  /** Shown in the title: "Livraison n° 3" when editing, nothing for a new delivery. */
  place?: string
  initial?: DeliveryCustomer
  /** Zone of the order being edited, if it has one. */
  zone?: CurrentZone | null
  /** Label of the save button. */
  submitLabel: string
  /** New delivery: the Numéro de livraison is chosen too, in this range; the numbers in use are greyed out. */
  numbers?: { min: number; max: number; used: Set<number> }
  onCancel(): void
  /** Saves the customer; a thrown error is shown in the dialog. */
  onSubmit(customer: DeliveryCustomer): Promise<void>
}

/**
 * Customer of a delivery: name (optional), phone and address (needed to deliver), and the delivery zone (optional) whose
 * fee is added to the order.
 */
export default function DeliveryDialog({ place, initial, zone, submitLabel, numbers, onCancel, onSubmit }: Props) {
  const { t } = useI18n()
  const [name, setName] = useState(initial?.name ?? '')
  const [phone, setPhone] = useState(initial?.phone ?? '')
  const [address, setAddress] = useState(initial?.address ?? '')
  const initialZone = zone?.id ?? (zone && (zone.name || zone.fee > 0) ? KEPT : '')
  const [zoneId, setZoneId] = useState(initialZone)
  const [number, setNumber] = useState<number | null>(null)
  const [zones, setZones] = useState<DeliveryZone[]>([])
  const [zonesError, setZonesError] = useState<string | null>(null)

  useEffect(() => {
    const load = () => deliveryZones.list().then(setZones, (e) => setZonesError(e instanceof Error ? e.message : String(e)))
    load()
    return deliveryZones.subscribe(load)
  }, [])

  const minutes = (n: number) => t.zoneMinutes(n)
  const picked = zones.find((z) => z.id === zoneId) ?? null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    // Only the phone is needed: the address may be given on the phone, or the customer comes to the door.
    if (!phone.trim()) return setError(t.deliveryNeedPhone)
    if (numbers && number === null) return setError(t.numberPick)
    setBusy(true)
    setError(null)
    try {
      // The zone is only written when it changed, so a database without the zones migration still takes deliveries.
      const changed = zoneId !== initialZone
      if (changed && zoneId && !picked) throw new Error(t.errZoneGone)
      await onSubmit({ name, phone, address, ...(changed && { zone: picked }), ...(numbers && number !== null && { number }) })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <form className={`dialog${numbers ? " number-dialog" : ""}`} role="dialog" aria-modal="true" aria-labelledby="delivery-title" onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && !busy && onCancel()}>
        <h2 id="delivery-title">{place ? `${t.deliveryCustomer} · ${place}` : t.deliveryCustomer}</h2>
        <label>
          {t.customerName}
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {t.customerPhone}
          <input type="tel" inputMode="tel" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        </label>
        <label>
          {t.customerAddress}
          <textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t.addressOptionalPh} />
        </label>
        <label>
          {t.deliveryZone}
          <select value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
            <option value="">{t.deliveryNoZone}</option>
            {zoneId === KEPT && zone && (
              <option value={KEPT}>{`${zone.name ?? '—'} · ${money(zone.fee)} (${t.zoneDeleted})`}</option>
            )}
            {zone?.id && !zones.some((z) => z.id === zone.id) && (
              <option value={zone.id}>{`${zone.name ?? '—'} · ${money(zone.fee)}`}</option>
            )}
            {zones.map((z) => <option key={z.id} value={z.id}>{zoneLabel(z, money, minutes)}</option>)}
          </select>
        </label>
        {picked && <p className="muted small">{t.deliveryFeeAdded(money(picked.fee))}</p>}
        {numbers && (
          <div className="field">
            <span>{t.deliveryNumberTitle}</span>
            <NumberPicker min={numbers.min} max={numbers.max} used={numbers.used} value={number} onChange={(n) => { setNumber(n); setError(null) }} />
          </div>
        )}
        {zonesError && <p className="muted small">{zonesError}</p>}
        {error && <p className="error small">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>{t.cancel}</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? t.saving : submitLabel}</button>
        </div>
      </form>
    </div>
  )
}

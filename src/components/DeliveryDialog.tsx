import { useState, type FormEvent } from 'react'
import type { DeliveryCustomer } from '../lib/types'
import { useI18n } from '../lib/i18n'

interface Props {
  /** Shown in the title: "Livraison n° 3" when editing, nothing for a new delivery. */
  place?: string
  initial?: DeliveryCustomer
  /** Label of the save button. */
  submitLabel: string
  onCancel(): void
  /** Saves the customer; a thrown error is shown in the dialog. */
  onSubmit(customer: DeliveryCustomer): Promise<void>
}

/** Customer of a delivery: name (optional), phone and address (needed to deliver). */
export default function DeliveryDialog({ place, initial, submitLabel, onCancel, onSubmit }: Props) {
  const { t } = useI18n()
  const [name, setName] = useState(initial?.name ?? '')
  const [phone, setPhone] = useState(initial?.phone ?? '')
  const [address, setAddress] = useState(initial?.address ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!phone.trim() || !address.trim()) return setError(t.deliveryNeedContact)
    setBusy(true)
    setError(null)
    try {
      await onSubmit({ name, phone, address })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="delivery-title" onSubmit={submit}
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
          <textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} required />
        </label>
        {error && <p className="error small">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>{t.cancel}</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? t.saving : submitLabel}</button>
        </div>
      </form>
    </div>
  )
}

import { useEffect, useState, type FormEvent } from 'react'
import { useI18n } from '../lib/i18n'
import NumberPicker from './NumberPicker'

interface Props {
  min: number
  max: number
  /** Numbers of the takeaway orders in progress. */
  used: Set<number>
  /** Creates the order with this number; a thrown error (e.g. « Numéro déjà utilisé ») is shown here. */
  onStart(number: number): Promise<void>
  onCancel(): void
}

/** Nouvelle commande à emporter: the customer's number, which identifies the order (« N° 30 »). */
export default function TakeawayStartDialog({ min, max, used, onStart, onCancel }: Props) {
  const { t } = useI18n()
  const [number, setNumber] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Escape closes the window wherever the focus is (after an error the focused button may be disabled).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (number === null) return setError(t.numberPick)
    setBusy(true)
    setError(null)
    try {
      await onStart(number)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setNumber(null)
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <form className="dialog number-dialog" role="dialog" aria-modal="true" aria-labelledby="takeaway-start-title" onSubmit={submit}>
        <h2 id="takeaway-start-title">{t.newTakeawayTitle} · {t.numberTitle}</h2>
        <NumberPicker min={min} max={max} used={used} value={number} onChange={(n) => { setNumber(n); setError(null) }} />
        {error && <p className="error small">{error}</p>}
        <div className="row">
          <div className="spacer" />
          <button type="button" onClick={onCancel} disabled={busy}>{t.cancel}</button>
          <button className="primary" disabled={busy || number === null}>{number === null ? t.numberPick : t.numberStart(number)}</button>
        </div>
      </form>
    </div>
  )
}

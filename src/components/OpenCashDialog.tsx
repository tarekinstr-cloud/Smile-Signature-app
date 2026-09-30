import { useState, type FormEvent } from 'react'
import { cash } from '../lib/cash'
import { useI18n } from '../lib/i18n'
import { usePermissions } from '../lib/permissions'
import Keypad, { parseAmount } from './Keypad'

interface Props {
  onCancel(): void
  /** The day is open (by this dialog or by another device meanwhile): the payment goes on. */
  onOpened(): void
}

/**
 * Caisse fermée, from the payment screen: someone allowed types the Fond de caisse and the payment continues;
 * anyone else is told to ask a manager, and the payment is not made.
 */
export default function OpenCashDialog({ onCancel, onOpened }: Props) {
  const { t } = useI18n()
  const { can } = usePermissions()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const allowed = can('cash_open')
  const n = parseAmount(value)
  const valid = value.trim() !== '' && Number.isFinite(n) && n >= 0

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      await cash.openDay(n)
      onOpened()
    } catch (err) {
      // Opened on another device in the meantime: carry on with the payment.
      if (await cash.isOpen().catch(() => false)) return onOpened()
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <form className="dialog open-cash-dialog" role="alertdialog" aria-modal="true" aria-labelledby="open-cash-title" onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && !busy && onCancel()}>
        <h2 id="open-cash-title">{allowed ? t.openCashTitle : t.cashClosedTitle}</h2>
        {!allowed ? (
          <>
            <p>{t.cashClosedAsk}</p>
            <div className="dialog-actions">
              <button type="button" className="primary" onClick={onCancel}>{t.close}</button>
            </div>
          </>
        ) : (
          <>
            <p className="muted small">{t.openCashHint}</p>
            {error && <p className="error small" role="alert">{error}</p>}
            <label>
              {t.cashOpening}
              <input autoFocus dir="ltr" inputMode="decimal" value={value} placeholder="0" onChange={(e) => setValue(e.target.value)} />
            </label>
            <Keypad value={value} onChange={setValue} />
            <div className="dialog-actions">
              <button type="button" onClick={onCancel} disabled={busy}>{t.cancel}</button>
              <button type="submit" className="primary" disabled={busy || !valid}>{busy ? t.saving : t.openCashPay}</button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}

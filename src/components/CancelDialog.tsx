import { useState, type FormEvent } from 'react'
import { useI18n } from '../lib/i18n'
import { CANCEL_REASONS, type Cancellation } from '../lib/types'
import { useReasons } from '../lib/settings'

interface Props {
  title: string
  /** What is cancelled, and what it means (amount, cash given back…). */
  detail?: string
  confirmLabel: string
  onCancel(): void
  /** Resolves when done; a rejection is shown in the dialog. */
  onConfirm(why: Cancellation): Promise<void>
}

/**
 * Annulation with a mandatory reason: one of the list (Paramètres > Configurations > Motifs, or the default one), plus a
 * free text (required for « Autre »).
 */
export default function CancelDialog({ title, detail, confirmLabel, onCancel, onConfirm }: Props) {
  const { t } = useI18n()
  const reasons = useReasons(t)
  // Default list: the codes (translated in each language); an edited list: the reasons as written.
  const choices: [string, string][] = [
    ...(reasons.cancelCodes ? CANCEL_REASONS.filter((r) => r !== 'other').map((r): [string, string] => [r, t.cancelReasons[r]]) : reasons.cancel.map((r): [string, string] => [r.slice(0, 40), r])),
    ['other', t.cancelReasons.other],
  ]
  const [reason, setReason] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = !!reason && (reason !== 'other' || note.trim() !== '')

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!reason) return setError(t.errCancelReason)
    if (reason === 'other' && !note.trim()) return setError(t.errCancelNote)
    setBusy(true)
    setError(null)
    try {
      await onConfirm({ reason, note })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <form className="dialog cancel-dialog" role="alertdialog" aria-modal="true" aria-labelledby="cancel-title" onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && !busy && onCancel()}>
        <h2 id="cancel-title">{title}</h2>
        {detail && <p className="muted small">{detail}</p>}
        {error && <p className="error small" role="alert">{error}</p>}
        <fieldset className="cancel-reasons">
          <legend>{t.cancelReasonLabel}</legend>
          <div className="chip-row" role="radiogroup" aria-label={t.cancelReasonLabel}>
            {choices.map(([r, label]) => (
              <button key={r} type="button" role="radio" aria-checked={reason === r} className={`chip${reason === r ? ' on' : ''}`}
                onClick={() => setReason(r)}>
                <bdi>{label}</bdi>
              </button>
            ))}
          </div>
        </fieldset>
        <label>
          {reason === 'other' ? t.cancelNoteRequired : t.cancelNoteOptional}
          <textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>{t.back}</button>
          <button type="submit" className="danger solid" disabled={busy || !valid}>{busy ? t.saving : confirmLabel}</button>
        </div>
      </form>
    </div>
  )
}

/** « Client parti — il a attendu » : reason text of a code, then the note. */
export function reasonText(t: { cancelReasons: Record<string, string> }, reason?: string | null, note?: string | null) {
  const label = reason ? t.cancelReasons[reason] ?? reason : ''
  return [label, note?.trim()].filter(Boolean).join(' — ')
}

/** Chips to choose one reason (Offrir, Remise). */
export function ReasonChips({ label, reasons, value, onChange }: { label: string; reasons: string[]; value: string | null; onChange(r: string): void }) {
  return (
    <fieldset className="cancel-reasons">
      <legend>{label}</legend>
      <div className="chip-row" role="radiogroup" aria-label={label}>
        {reasons.map((r) => (
          <button key={r} type="button" role="radio" aria-checked={value === r} className={`chip${value === r ? ' on' : ''}`} onClick={() => onChange(r)}>
            <bdi>{r}</bdi>
          </button>
        ))}
      </div>
    </fieldset>
  )
}

/** Offrir with a reason: shown when Paramètres > Motifs has offer reasons. */
export function OfferReasonDialog({ title, reasons, onCancel, onConfirm }: { title: string; reasons: string[]; onCancel(): void; onConfirm(reason: string): void }) {
  const { t } = useI18n()
  const [reason, setReason] = useState<string | null>(null)
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="dialog cancel-dialog" role="dialog" aria-modal="true" aria-labelledby="offer-title"
        onSubmit={(e) => { e.preventDefault(); if (reason) onConfirm(reason) }} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
        <h2 id="offer-title">{title}</h2>
        <ReasonChips label={t.reasonLabel} reasons={reasons} value={reason} onChange={setReason} />
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>{t.back}</button>
          <button type="submit" className="primary" disabled={!reason}>{t.actOffer}</button>
        </div>
      </form>
    </div>
  )
}

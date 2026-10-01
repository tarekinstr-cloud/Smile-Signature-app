import { useState, type FormEvent } from 'react'
import { useI18n } from '../lib/i18n'
import GuestsPicker from './GuestsPicker'

/**
 * Nouvelle commande à emporter: only the number of people (for cutlery, napkins, bread, sauces). The order is called
 * out by its number (« E 7 »). The proposed value comes from Paramètres > Configurations.
 */
export default function TakeawayStartDialog({ defaultGuests, onStart, onCancel }: { defaultGuests: number; onStart(guests: number): void; onCancel(): void }) {
  const { t } = useI18n()
  const [guests, setGuests] = useState(defaultGuests)

  function submit(e: FormEvent) {
    e.preventDefault()
    onStart(guests)
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="takeaway-start-title" onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
        <h2 id="takeaway-start-title">{t.newTakeawayTitle}</h2>
        <span className="muted small">{t.guestsAskTakeaway}</span>
        <GuestsPicker value={guests} onChange={setGuests} />
        <div className="row">
          <div className="spacer" />
          <button type="button" onClick={onCancel}>{t.cancel}</button>
          <button className="primary" autoFocus>{t.takeawayStartGuests(guests)}</button>
        </div>
      </form>
    </div>
  )
}

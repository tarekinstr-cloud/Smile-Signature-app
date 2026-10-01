import { useRef, useState, type FormEvent } from 'react'
import { useI18n } from '../lib/i18n'
import TouchKeyboard from './TouchKeyboard'

/**
 * Nouvelle commande à emporter: the customer's name, optional, typed on the touch keyboard (or the device's own). It is
 * shown on the order's card and printed on the kitchen tickets, to call the customer.
 */
export default function TakeawayStartDialog({ onStart, onCancel }: { onStart(name: string): void; onCancel(): void }) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const [keyboard, setKeyboard] = useState<HTMLInputElement | null>(null)

  function submit(e: FormEvent) {
    e.preventDefault()
    onStart(name.trim())
  }

  return (
    <div className={`dialog-backdrop takeaway-start${keyboard ? ' kb-open' : ''}`} onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="takeaway-start-title" onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
        <h2 id="takeaway-start-title">{t.newTakeawayTitle}</h2>
        <label>
          {t.customerNameOptional}
          <input ref={input} autoFocus value={name} maxLength={60} autoComplete="off" placeholder={t.customerNamePh}
            onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="row">
          <button type="button" className="ghost" onClick={() => { setKeyboard(input.current); input.current?.focus() }} disabled={!!keyboard}>⌨ {t.kbShow}</button>
          <div className="spacer" />
          <button type="button" onClick={onCancel}>{t.cancel}</button>
          <button className="primary">{name.trim() ? t.takeawayStart : t.takeawayStartNoName}</button>
        </div>
      </form>
      {keyboard && <TouchKeyboard target={keyboard} onHide={() => setKeyboard(null)} />}
    </div>
  )
}

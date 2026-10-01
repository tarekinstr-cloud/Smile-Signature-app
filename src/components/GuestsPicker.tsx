import { useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import TouchKeyboard from './TouchKeyboard'

const QUICK = [1, 2, 3, 4, 5]

/**
 * Nombre de personnes: quick buttons 1 to 5, and « + » for more, typed in a field (touch keyboard available).
 * `value` is always a whole number from 1 to 99.
 */
export default function GuestsPicker({ value, onChange }: { value: number; onChange(n: number): void }) {
  const { t } = useI18n()
  const [more, setMore] = useState(value > QUICK.length)
  const [text, setText] = useState(value > QUICK.length ? String(value) : '')
  const input = useRef<HTMLInputElement>(null)
  const [keyboard, setKeyboard] = useState<HTMLInputElement | null>(null)

  function type(v: string) {
    const digits = v.replace(/\D/g, '').slice(0, 2)
    setText(digits)
    const n = Number(digits)
    if (n >= 1 && n <= 99) onChange(n)
  }

  return (
    <div className="guests-picker" role="group" aria-label={t.peopleTitle}>
      <div className="guests-quick">
        {QUICK.map((n) => (
          <button key={n} type="button" className={!more && value === n ? 'on' : ''} aria-pressed={!more && value === n}
            onClick={() => { setMore(false); onChange(n) }}>{n}</button>
        ))}
        <button type="button" className={more ? 'on' : ''} aria-pressed={more} aria-label={t.guestsMore}
          onClick={() => { setMore(true); setTimeout(() => input.current?.focus()) }}>+</button>
      </div>
      {more && (
        <div className="row guests-more">
          <input ref={input} inputMode="numeric" pattern="[0-9]*" maxLength={2} value={text} placeholder="6" aria-label={t.peopleTitle}
            onChange={(e) => type(e.target.value)} />
          {!keyboard && <button type="button" className="ghost" onClick={() => { setKeyboard(input.current); input.current?.focus() }}>⌨ {t.kbShow}</button>}
        </div>
      )}
      {keyboard && <TouchKeyboard target={keyboard} onHide={() => setKeyboard(null)} />}
    </div>
  )
}

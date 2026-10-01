import { useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import TouchKeyboard from './TouchKeyboard'

interface Props {
  /** Range shown in the grid (Paramètres > Configurations). */
  min: number
  max: number
  /** Numbers of the orders in progress in this mode: greyed, cannot be chosen. */
  used: Set<number>
  /** Number chosen (grid or keyboard), or null. */
  value: number | null
  onChange(n: number | null): void
}

/**
 * Numéro du client / de la livraison: a grid of the numbers of the range, those in use greyed out, and « Clavier » to
 * type another one (touch keyboard available). The server refuses a number taken meanwhile on another device.
 */
export default function NumberPicker({ min, max, used, value, onChange }: Props) {
  const { t } = useI18n()
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const [keyboard, setKeyboard] = useState<HTMLInputElement | null>(null)
  const count = Math.max(0, Math.min(500, max - min + 1))
  const typed = Number(text)
  const typedUsed = text !== '' && used.has(typed)

  function type(v: string) {
    const digits = v.replace(/\D/g, '').slice(0, 4)
    setText(digits)
    const n = Number(digits)
    onChange(n >= 1 && !used.has(n) ? n : null)
  }

  return (
    <div className="number-picker">
      <div className="number-grid" role="group" aria-label={t.numberTitle}>
        {Array.from({ length: count }, (_, i) => min + i).map((n) => {
          const taken = used.has(n)
          return (
            <button key={n} type="button" disabled={taken} className={!typing && value === n ? 'on' : ''} aria-pressed={!typing && value === n}
              title={taken ? t.numberInUseShort : undefined} onClick={() => { setTyping(false); onChange(n) }}>{n}</button>
          )
        })}
      </div>
      <div className="row number-typed">
        <button type="button" className={typing ? 'on' : ''} onClick={() => { setTyping(true); setText(''); onChange(null); setTimeout(() => input.current?.focus()) }}>
          ⌨ {t.numberKeyboard}
        </button>
        {typing && (
          <>
            <input ref={input} inputMode="numeric" pattern="[0-9]*" maxLength={4} value={text} aria-label={t.numberTitle}
              aria-invalid={typedUsed} onChange={(e) => type(e.target.value)} />
            {!keyboard && <button type="button" className="ghost" onClick={() => { setKeyboard(input.current); input.current?.focus() }}>{t.numberTouchKb}</button>}
          </>
        )}
      </div>
      {typing && typedUsed && <p className="error small">{t.errNumberInUse}</p>}
      {typing && text !== '' && !typedUsed && (typed < min || typed > max) && <p className="muted small">{t.numberOutOfRange(min, max)}</p>}
      {keyboard && <TouchKeyboard target={keyboard} onHide={() => setKeyboard(null)} />}
    </div>
  )
}

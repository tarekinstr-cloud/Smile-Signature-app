import { useI18n } from '../lib/i18n'

interface Props {
  /** Typed amount, e.g. "1500" or "12,5". Empty = nothing typed yet. */
  value: string
  onChange(value: string): void
  disabled?: boolean
}


/** Amount typed with a decimal comma → number (NaN when empty). */
export const parseAmount = (s: string) => (s.trim() === '' ? NaN : Number(s.replace(',', '.')))

/** Number → keypad text: "1500", "12,5". */
export const amountText = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100).replace('.', ',') : '')

/** On-screen number pad for touch tablets: digits, 00, decimal comma, backspace and clear. Always laid out left to right. */
export default function Keypad({ value, onChange, disabled }: Props) {
  const { t } = useI18n()

  function press(key: string) {
    if (key === ',') {
      if (!value.includes(',')) onChange((value || '0') + ',')
      return
    }
    // Two decimals at most, and no leading zeros ("007" → "7").
    const [int, dec] = value.split(',')
    if (dec !== undefined && dec.length + key.length > 2) return
    if (dec === undefined && int.length >= 7) return
    const next = value + key
    onChange(next.includes(',') ? next : String(Number(next)))
  }

  const key = (k: string) => <button key={k} type="button" disabled={disabled} onClick={() => press(k)}>{k}</button>

  return (
    <div className="keypad" dir="ltr">
      {/* 7 8 9 ⌫ / 4 5 6 C / 1 2 3 00 / 0 , */}
      {['7', '8', '9'].map(key)}
      <button type="button" className="key-fn" disabled={disabled || !value} onClick={() => onChange(value.slice(0, -1))} aria-label={t.backspace}>⌫</button>
      {['4', '5', '6'].map(key)}
      <button type="button" className="key-fn" disabled={disabled || !value} onClick={() => onChange('')} aria-label={t.clearAllLabel}>{t.clearAll}</button>
      {['1', '2', '3', '00'].map(key)}
      <button type="button" className="key-zero" disabled={disabled} onClick={() => press('0')}>0</button>
      {key(',')}
    </div>
  )
}

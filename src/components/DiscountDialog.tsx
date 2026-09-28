import { useState, type FormEvent } from 'react'
import type { Discount, DiscountType } from '../lib/types'
import { money } from '../lib/format'
import { discountAmount } from '../lib/billing'
import { useI18n } from '../lib/i18n'
import Keypad, { amountText, parseAmount } from './Keypad'

interface Props {
  /** What the discount applies to: "Toute la commande" or the article's name. */
  target: string
  /** Amount the discount is taken from, for the preview. */
  base: number
  current: Discount | null
  busy: boolean
  onCancel(): void
  onApply(discount: Discount | null): void
}

const PERCENTS = [5, 10, 15, 20, 50]

/** Discount as a percentage or a fixed DA amount, typed on the keypad. */
export default function DiscountDialog({ target, base, current, busy, onCancel, onApply }: Props) {
  const { t } = useI18n()
  const [type, setType] = useState<DiscountType>(current?.type ?? 'percent')
  const [value, setValue] = useState(current ? amountText(current.value) : '')

  const v = parseAmount(value)
  const valid = Number.isFinite(v) && v > 0 && (type === 'amount' ? v <= base : v <= 100)
  const off = valid ? discountAmount(base, { discount_type: type, discount_value: v }) : 0

  function submit(e: FormEvent) {
    e.preventDefault()
    if (valid && !busy) onApply({ type, value: v })
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <form className="dialog discount-dialog" role="dialog" aria-modal="true" aria-labelledby="discount-title" onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && !busy && onCancel()}>
        <h2 id="discount-title">{t.discountTitle(target)}</h2>
        <div className="segmented wide" role="group">
          <button type="button" className={type === 'percent' ? 'on' : ''} aria-pressed={type === 'percent'} onClick={() => setType('percent')}>%</button>
          <button type="button" className={type === 'amount' ? 'on' : ''} aria-pressed={type === 'amount'} onClick={() => setType('amount')}>{t.currency}</button>
        </div>
        <div className={valid || !value ? 'amount-display' : 'amount-display bad'} dir="ltr">
          {value || '0'} <span>{type === 'percent' ? '%' : t.currency}</span>
        </div>
        {type === 'percent' && (
          <div className="quick-amounts">
            {PERCENTS.map((p) => <button type="button" key={p} onClick={() => setValue(String(p))}>{p} %</button>)}
          </div>
        )}
        <Keypad value={value} onChange={setValue} disabled={busy} />
        <div className="change">
          <span>{t.discount}</span>
          <strong><bdi dir="ltr">−{money(off)}</bdi></strong>
        </div>
        <div className="dialog-actions">
          {current && <button type="button" className="danger" onClick={() => onApply(null)} disabled={busy}>{t.removeDiscount}</button>}
          <div className="spacer" />
          <button type="button" onClick={onCancel} disabled={busy}>{t.cancel}</button>
          <button type="submit" className="primary" disabled={busy || !valid}>{t.apply}</button>
        </div>
      </form>
    </div>
  )
}

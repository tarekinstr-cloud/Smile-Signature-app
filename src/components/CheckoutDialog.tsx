import { useState, type FormEvent } from 'react'
import type { PaymentMethod } from '../lib/types'
import { money } from '../lib/format'
import { useI18n } from '../lib/i18n'

interface Props {
  tableLabel: string
  total: number
  busy: boolean
  onCancel(): void
  onPay(method: PaymentMethod, received: number | null): void
}

/** Common Algerian notes, for one-tap cash amounts. */
const NOTES = [200, 500, 1000, 2000]

/** Picks the payment method; for cash, takes the amount received and shows the change to give back. */
export default function CheckoutDialog({ tableLabel, total, busy, onCancel, onPay }: Props) {
  const { t } = useI18n()
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [received, setReceived] = useState('')

  const amount = received.trim() === '' ? total : Number(received.replace(',', '.'))
  const valid = Number.isFinite(amount) && amount >= total
  const change = valid ? amount - total : 0
  // Round totals up to the next notes the customer is likely to hand over.
  const quick = [...new Set(NOTES.map((n) => Math.ceil(total / n) * n).filter((v) => v > total))].sort((a, b) => a - b).slice(0, 3)

  function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (method === 'card') onPay('card', null)
    else if (valid) onPay('cash', amount)
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <form className="dialog checkout-dialog" role="dialog" aria-modal="true" aria-labelledby="checkout-title" onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && !busy && onCancel()}>
        <h2 id="checkout-title">{t.checkoutTitle(tableLabel)}</h2>
        <div className="due">
          <span className="muted">{t.amountDue}</span>
          <strong>{money(total)}</strong>
        </div>
        <div className="field">
          <span>{t.paymentMethod}</span>
          <div className="pay-methods">
            <button type="button" className={method === 'cash' ? 'pay-method on' : 'pay-method'} aria-pressed={method === 'cash'} onClick={() => setMethod('cash')}>
              <span aria-hidden>💵</span>{t.cash}
            </button>
            <button type="button" className={method === 'card' ? 'pay-method on' : 'pay-method'} aria-pressed={method === 'card'} onClick={() => setMethod('card')}>
              <span aria-hidden>💳</span>{t.card}
            </button>
          </div>
        </div>
        {method === 'cash' && (
          <>
            <label>
              {t.received}
              <input inputMode="decimal" value={received} placeholder={total.toFixed(2)} onChange={(e) => setReceived(e.target.value)} />
            </label>
            <div className="quick-amounts">
              <button type="button" onClick={() => setReceived('')}>{t.exact}</button>
              {quick.map((v) => (
                <button type="button" key={v} onClick={() => setReceived(String(v))}>{money(v)}</button>
              ))}
            </div>
            <div className={valid ? 'change' : 'change short'}>
              {valid ? <><span>{t.change}</span><strong>{money(change)}</strong></> : <span>{t.missingAmount(money(Number.isFinite(amount) ? total - amount : total))}</span>}
            </div>
          </>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>{t.cancel}</button>
          <button type="submit" className="primary" disabled={busy || (method === 'cash' && !valid)}>
            {busy ? t.saving : t.confirmPayment}
          </button>
        </div>
      </form>
    </div>
  )
}

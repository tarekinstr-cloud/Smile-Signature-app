import { useEffect, useState, type FormEvent } from 'react'
import { customers } from '../lib/customers'
import { money } from '../lib/format'
import { useI18n } from '../lib/i18n'
import type { Customer } from '../lib/types'
import { CustomerPicker } from './backoffice/CustomersPages'

interface Props {
  /** Amount put on the account (the whole remaining amount, or the partial amount typed). */
  amount: number
  /** Customer already on the order (a delivery's customer), chosen at first. */
  initialCustomer?: string | null
  onCancel(): void
  /** Puts the amount on the chosen customer's account; a thrown error is shown in the dialog. */
  onConfirm(customer: Customer): Promise<void>
}

/**
 * Paiement > Compte client (crédit): choose the customer (or create one with a name and a phone), see what they already
 * owe and their limit, then put the amount on their account. The order is closed like any paid order but stays due.
 */
export default function CreditDialog({ amount, initialCustomer, onCancel, onConfirm }: Props) {
  const { t } = useI18n()
  const [list, setList] = useState<Customer[] | null>(null)
  const [id, setId] = useState<string | null>(initialCustomer ?? null)
  const [due, setDue] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    customers.list().then(setList, (e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(() => {
    setDue(null)
    if (id) customers.unpaid(id).then((l) => setDue(l.reduce((s, i) => s + i.due, 0)), () => setDue(null))
  }, [id])

  const chosen = list?.find((c) => c.id === id && c.active) ?? null
  const over = !!chosen && chosen.credit_limit != null && due != null && due + amount > chosen.credit_limit

  async function create() {
    setBusy(true)
    setError(null)
    try {
      const c = await customers.create({ name, phone, address: '', zone_id: null, note: '', credit_limit: null })
      setList((l) => [...(l ?? []), c])
      setId(c.id)
      setCreating(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setBusy(false)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!chosen) return setError(t.creditPickCustomer)
    setBusy(true)
    setError(null)
    try {
      await onConfirm(chosen)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <form className="dialog credit-dialog" role="dialog" aria-modal="true" aria-labelledby="credit-title" onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && !busy && onCancel()}>
        <h2 id="credit-title">{t.creditTitle(money(amount))}</h2>
        <p className="muted small">{t.creditHint}</p>
        {!list ? <p className="muted">{t.loading}</p> : creating ? (
          <div className="credit-new">
            <label>
              {t.customerName}
              <input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              {t.customerPhone}
              <input type="tel" inputMode="tel" dir="ltr" value={phone} maxLength={30} onChange={(e) => setPhone(e.target.value)} />
            </label>
            <div className="row-actions">
              <button type="button" onClick={() => setCreating(false)} disabled={busy}>{t.back}</button>
              <button type="button" className="primary" onClick={create} disabled={busy || !name.trim()}>{t.customerCreate}</button>
            </div>
          </div>
        ) : (
          <>
            <CustomerPicker list={list} value={chosen ? chosen.id : null} onChange={setId} />
            {!chosen && <button type="button" className="link" onClick={() => setCreating(true)}>+ {t.customerNewTitle}</button>}
          </>
        )}
        {chosen && (
          <p className="small credit-state">
            {t.creditBalance} : <strong>{due == null ? '…' : money(due)}</strong>
            {chosen.credit_limit != null && <> · {t.creditLimit} : <strong>{money(chosen.credit_limit)}</strong></>}
          </p>
        )}
        {over && <p className="banner small" role="alert">⚠ {t.creditOverLimit}</p>}
        {error && <p className="error small" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>{t.cancel}</button>
          <button type="submit" className="primary" disabled={busy || !chosen || creating}>{busy ? t.saving : t.creditConfirm(money(amount))}</button>
        </div>
      </form>
    </div>
  )
}

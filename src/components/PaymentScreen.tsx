import { useCallback, useEffect, useMemo, useState } from 'react'
import { repo, type OpenOrder } from '../lib/repo'
import type { AdjustmentsPatch, Discount, OrderLine, PaidOrder, Payment, PaymentMethod } from '../lib/types'
import { money } from '../lib/format'
import { PAYMENT_METHODS, computeBill, discountOf } from '../lib/billing'
import { useI18n } from '../lib/i18n'
import Keypad, { amountText, parseAmount } from './Keypad'
import DiscountDialog from './DiscountDialog'
import LangToggle from './LangToggle'

interface Props {
  orderId: string
  /** "Table 4" or "À emporter n° 12". */
  place: string
  hallName: string | null
  /** Opens with "Paiement partiel" already on (Paiement Partiel button). */
  startPartial?: boolean
  /** Payer sans ticket: shown in the title; the order screen skips the receipt afterwards. */
  noTicket?: boolean
  /** Back to the order screen; the order stays open. */
  onBack(): void
  /** Last payment done: the order is closed and its table freed. */
  onPaid(result: { order: PaidOrder; lines: OrderLine[]; payments: Payment[] }): void
}

/** Common Algerian notes, for one-tap amounts. */
const NOTES = [500, 1000, 2000]

type Field = 'amount' | 'received'

/** "−150 DA", kept left to right inside Arabic text. */
export const minus = (n: number) => <bdi dir="ltr">−{money(n)}</bdi>

/**
 * Paiement: the order with its discounts and offers on one side, the cashier's keypad on the other.
 * Takes the whole remaining amount or a part of it (partial payment) and closes the order when nothing is left.
 */
export default function PaymentScreen({ orderId, place, hallName, startPartial, noTicket, onBack, onPaid }: Props) {
  const { t } = useI18n()
  const [data, setData] = useState<OpenOrder | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [partial, setPartial] = useState(!!startPartial)
  /** Part to pay now (partial payment only; otherwise everything left). */
  const [amountStr, setAmountStr] = useState('')
  const [receivedStr, setReceivedStr] = useState('')
  const [field, setField] = useState<Field>(startPartial ? 'amount' : 'received')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** Discount dialog: on a line (its id) or on the whole order (null). */
  const [discountFor, setDiscountFor] = useState<{ lineId: string | null } | null>(null)

  const reload = useCallback(async () => {
    try {
      const current = await repo.getOrder(orderId)
      setData(current)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }, [orderId])

  useEffect(() => {
    reload()
  }, [reload])
  useEffect(() => repo.subscribeOrders(() => reload()), [reload])

  const bill = useMemo(() => computeBill(data?.order ?? null, data?.lines ?? [], data?.payments ?? []), [data])
  const cashLike = PAYMENT_METHODS.find((m) => m.id === method)?.cash ?? false
  const selected = bill.lines.find((b) => b.line.id === selectedId) ?? null
  const orderOffered = !!data?.order.offered

  // What this payment settles, and what the customer hands over.
  const typedAmount = parseAmount(amountStr)
  const amount = partial ? (Number.isFinite(typedAmount) ? typedAmount : 0) : bill.remaining
  const amountOk = bill.remaining === 0 ? amount === 0 : amount > 0 && amount <= bill.remaining
  const typedReceived = parseAmount(receivedStr)
  const received = cashLike ? (Number.isFinite(typedReceived) ? typedReceived : amount) : amount
  const receivedOk = received >= amount
  const change = amountOk && receivedOk ? Math.round((received - amount) * 100) / 100 : 0
  const canPay = !!data && !busy && amountOk && receivedOk

  // Keypad writes into the focused field; card payments only ever type the partial amount.
  const activeField: Field = !cashLike || (partial && field === 'amount') ? 'amount' : 'received'
  const keypadValue = activeField === 'amount' ? amountStr : receivedStr
  const setKeypad = activeField === 'amount' ? setAmountStr : setReceivedStr
  const keypadOn = activeField === 'received' || partial

  const quick = useMemo(() => {
    if (activeField === 'amount') {
      // Split helpers for partial payments: half, a third… and round notes under what is left.
      const parts = [2, 3, 4].map((n) => Math.ceil(bill.remaining / n))
      return [...new Set([...parts, ...NOTES])].filter((v) => v > 0 && v < bill.remaining).sort((a, b) => a - b).slice(0, 3)
    }
    const ups = [200, 500, 1000, 2000].map((n) => Math.ceil(amount / n) * n)
    return [...new Set([...NOTES, ...ups])].filter((v) => v > amount).sort((a, b) => a - b).slice(0, 3)
  }, [activeField, amount, bill.remaining])

  function resetEntry() {
    setAmountStr('')
    setReceivedStr('')
    setPartial(false)
    setField('received')
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  async function pay() {
    if (!data || !canPay) return
    const snapshot = data
    await run(async () => {
      const done = await repo.addPayment(snapshot.order.id, method, amount, cashLike ? received : null)
      if (done) {
        const payments = await repo.listPayments(done.id)
        onPaid({ order: done, lines: snapshot.lines, payments })
        return
      }
      const rest = Math.max(0, Math.round((bill.remaining - amount) * 100) / 100)
      setNotice(t.partialDone(money(amount), money(rest)) + (change > 0 ? ` · ${t.changeDue} : ${money(change)}` : ''))
      resetEntry()
      await reload()
    })
  }

  async function adjust(lineId: string | null, patch: AdjustmentsPatch) {
    if (!data) return
    await run(async () => {
      await repo.adjust(data.order.id, lineId, patch)
      setDiscountFor(null)
      await reload()
    })
  }

  const applyDiscount = (lineId: string | null, d: Discount | null) =>
    adjust(lineId, d ? { discount_type: d.type, discount_value: d.value } : { discount_type: null, discount_value: 0 })

  function togglePartial() {
    const on = !partial
    setPartial(on)
    setAmountStr('')
    setReceivedStr('')
    setField(on ? 'amount' : 'received')
  }

  const clock = (iso: string) => new Date(iso).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const discountLine = discountFor && (discountFor.lineId ? bill.lines.find((b) => b.line.id === discountFor.lineId) : null)

  return (
    <div className="app order-screen pay-screen">
      <header className="topbar">
        <button className="ghost back" onClick={onBack} disabled={busy} aria-label={t.back}>{t.back}</button>
        <div className="order-title">
          <strong>{t.payTitle(place)}{noTicket && <> · {t.noTicket}</>}</strong>
          <span>{hallName && <><bdi>{hallName}</bdi> · </>}{t.itemCount(data?.lines.reduce((s, l) => s + l.quantity, 0) ?? 0)}</span>
        </div>
        <div className="spacer" />
        <LangToggle />
      </header>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {notice && <div className="banner ok" onClick={() => setNotice(null)}>{notice}</div>}

      {loading ? (
        <div className="center muted">{t.loading}</div>
      ) : !data ? (
        <div className="center">
          <div className="card empty">
            <p>{t.errOrderClosed}</p>
            <button className="primary" onClick={onBack}>{t.back}</button>
          </div>
        </div>
      ) : (
        <main className="content pay-content">
          <section className="panel pay-bill">
            <div className="panel-head">
              <h2>{t.order}</h2>
              {orderOffered && <span className="tag offered-tag">{t.orderOffered}</span>}
            </div>
            <ul className="lines pay-lines">
              {bill.lines.map((b) => {
                const d = discountOf(b.line)
                return (
                  <li key={b.line.id} className={b.line.id === selectedId ? 'line on' : 'line'} aria-selected={b.line.id === selectedId}
                    onClick={() => setSelectedId(b.line.id === selectedId ? null : b.line.id)}>
                    <div className="line-main">
                      <span className="line-name">{b.line.quantity} × <bdi>{b.line.name}</bdi></span>
                      <span className="line-total">
                        {b.offered ? <><s className="muted">{money(b.gross)}</s> {t.offered}</> : money(b.net)}
                      </span>
                    </div>
                    {b.line.options.length > 0 && <div className="line-details">{b.line.options.map((o) => o.name).join(t.listSep)}</div>}
                    {b.line.offered && <span className="tag offered-tag">{t.offered}</span>}
                    {d && !b.offered && (
                      <div className="line-discount">
                        {d.type === 'percent' ? t.discountPct(String(d.value)) : t.discount} · {minus(b.discount)} <s className="muted">{money(b.gross)}</s>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>

            <div className="adjust-bar">
              {selected ? (
                <>
                  <span className="adjust-target"><bdi>{selected.line.name}</bdi></span>
                  <button onClick={() => setDiscountFor({ lineId: selected.line.id })} disabled={busy || selected.offered}>% {t.discount}</button>
                  <button className={selected.line.offered ? 'on' : ''} aria-pressed={selected.line.offered} disabled={busy || orderOffered}
                    onClick={() => adjust(selected.line.id, { offered: !selected.line.offered })}>
                    🎁 {selected.line.offered ? t.unoffer : t.offer}
                  </button>
                </>
              ) : (
                <>
                  <span className="adjust-target muted small">{t.lineActionsHint}</span>
                  <button onClick={() => setDiscountFor({ lineId: null })} disabled={busy || orderOffered}>% {t.discountOrder}</button>
                  <button className={orderOffered ? 'on' : ''} aria-pressed={orderOffered} disabled={busy}
                    onClick={() => adjust(null, { offered: !orderOffered })}>
                    🎁 {orderOffered ? t.unofferOrder : t.offerOrder}
                  </button>
                </>
              )}
            </div>

            <dl className="bill-sum">
              {(bill.offered > 0 || bill.lineDiscounts > 0 || bill.orderDiscount > 0) && (
                <div><dt>{t.subtotal}</dt><dd>{money(bill.gross)}</dd></div>
              )}
              {bill.offered > 0 && <div><dt>{t.offered}</dt><dd>{minus(bill.offered)}</dd></div>}
              {bill.lineDiscounts > 0 && <div><dt>{t.discount}</dt><dd>{minus(bill.lineDiscounts)}</dd></div>}
              {bill.orderDiscount > 0 && data.order.discount_type && (
                <div>
                  <dt>{data.order.discount_type === 'percent' ? `${t.discountOrder} (${data.order.discount_value} %)` : t.discountOrder}</dt>
                  <dd>{minus(bill.orderDiscount)}</dd>
                </div>
              )}
              <div className="sum-total"><dt>{t.total}</dt><dd>{money(bill.total)}</dd></div>
              {bill.paid > 0 && <div><dt>{t.alreadyPaid}</dt><dd>{minus(bill.paid)}</dd></div>}
            </dl>

            <div className="pay-history">
              <strong>{t.payHistory}</strong>
              {data.payments.length === 0 ? (
                <p className="muted small">{t.noPayments}</p>
              ) : (
                <ul>
                  {data.payments.map((p) => (
                    <li key={p.id}>
                      <span className="muted">{clock(p.created_at)}</span>
                      <span>{t.payMethod[p.method] ?? p.method}</span>
                      {p.change_amount > 0 && <span className="muted small">{t.received} {money(p.received)} · {t.change} {money(p.change_amount)}</span>}
                      <strong>{money(p.amount)}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="panel pay-desk">
            <div className="due remaining">
              <span>{t.remaining}</span>
              <strong>{money(bill.remaining)}</strong>
            </div>

            {bill.remaining > 0 && (
              <>
                <div className="pay-methods">
                  {PAYMENT_METHODS.map((m) => (
                    <button key={m.id} type="button" className={method === m.id ? 'pay-method on' : 'pay-method'} aria-pressed={method === m.id}
                      onClick={() => { setMethod(m.id); setReceivedStr('') }}>
                      <span aria-hidden>{m.icon}</span>{t.payMethod[m.id]}
                    </button>
                  ))}
                </div>

                <button type="button" className={partial ? 'partial-toggle on' : 'partial-toggle'} aria-pressed={partial} title={t.partialHint} onClick={togglePartial}>
                  {partial ? '☑' : '☐'} {t.partial}
                </button>
                
                <div className="pay-fields">
                  {partial && (
                    <button type="button" className={activeField === 'amount' ? 'pay-field on' : 'pay-field'} onClick={() => setField('amount')}>
                      <span>{t.toPay}</span>
                      <strong className={amountStr && !amountOk ? 'bad' : ''}>{amountStr ? money(typedAmount) : '—'}</strong>
                    </button>
                  )}
                  {cashLike && (
                    <button type="button" className={activeField === 'received' ? 'pay-field on' : 'pay-field'} onClick={() => setField('received')}>
                      <span>{t.received}</span>
                      <strong className={!receivedOk ? 'bad' : ''}>{receivedStr ? money(typedReceived) : money(amount)}</strong>
                    </button>
                  )}
                </div>

                {keypadOn && (
                  <>
                    <div className="quick-amounts">
                      <button type="button" onClick={() => setKeypad(activeField === 'amount' ? amountText(bill.remaining) : '')}>{t.exactBtn}</button>
                      {quick.map((v) => (
                        <button type="button" key={v} onClick={() => setKeypad(amountText(v))}>{money(v)}</button>
                      ))}
                    </div>
                    <Keypad value={keypadValue} onChange={setKeypad} disabled={busy} />
                  </>
                )}

                {cashLike && (
                  <div className={receivedOk ? 'change' : 'change short'}>
                    {receivedOk ? <><span>{t.changeDue}</span><strong>{money(change)}</strong></> : <span>{t.missingAmount(money(amount - received))}</span>}
                  </div>
                )}
              </>
            )}

            <button className="primary checkout-btn pay-go" onClick={pay} disabled={!canPay}>
              {busy ? t.saving : bill.remaining === 0 ? (bill.total === 0 ? t.closeOffered : t.confirmPayment) : partial && amount < bill.remaining ? t.payPartNow(money(amount)) : t.payNow(money(amount))}
            </button>
          </section>
        </main>
      )}

      {discountFor && data && (
        <DiscountDialog
          target={discountLine ? discountLine.line.name : t.wholeOrder}
          base={discountLine ? discountLine.gross : bill.subtotal}
          current={discountLine ? discountOf(discountLine.line) : discountOf(data.order)}
          busy={busy}
          onCancel={() => setDiscountFor(null)}
          onApply={(d) => applyDiscount(discountFor.lineId, d)}
        />
      )}
    </div>
  )
}

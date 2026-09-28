import type { OrderLine, PaidOrder, Payment, ReceiptSettings } from '../lib/types'
import { money } from '../lib/format'
import { computeBill, discountOf } from '../lib/billing'
import { useI18n } from '../lib/i18n'

interface Props {
  settings: ReceiptSettings
  order: PaidOrder
  lines: OrderLine[]
  /** Payments of the order, oldest first (several for a partial payment). */
  payments: Payment[]
  tableLabel: string | null
  hallName: string | null
}

const textLines = (text: string) => text.split('\n').map((line, i) => <div key={i} dir="auto">{line || '\u00a0'}</div>)

const minus = (n: number) => <bdi dir="ltr">−{money(n)}</bdi>

/**
 * The printed ticket: logo and name, items with their discounts and offers, total, payments (with change given back)
 * and closing message. Sized for 80 mm receipt paper.
 */
export default function Receipt({ settings, order, lines, payments, tableLabel, hallName }: Props) {
  const { t } = useI18n()
  const date = new Date(order.closed_at)
  const bill = computeBill(order, lines, payments)
  const adjusted = bill.offered > 0 || bill.lineDiscounts > 0 || bill.orderDiscount > 0
  const clock = (iso: string) => new Date(iso).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const changeTotal = payments.reduce((s, p) => s + p.change_amount, 0)
  const single = payments.length === 1 ? payments[0] : null

  return (
    <div className="receipt">
      <img className="receipt-logo" src="/icon.svg" alt="" width={64} height={64} />
      <div className="receipt-name" dir="auto">{settings.name}</div>
      {/* Each line picks its own direction, so French text stays readable on an Arabic ticket and vice versa. */}
      {settings.header && <div className="receipt-header">{textLines(settings.header)}</div>}
      <div className="receipt-sep" />
      <div className="receipt-meta">
        <span>{t.ticketNo(String(order.ticket_no).padStart(6, '0'))}</span>
        <span>{date.toLocaleDateString(t.locale)} {date.toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span>
      </div>
      {tableLabel && (
        <div className="receipt-meta">
          <span>{t.table(tableLabel)}</span>
          {hallName && <bdi>{hallName}</bdi>}
        </div>
      )}
      <div className="receipt-sep" />
      <ul className="receipt-lines">
        {bill.lines.map(({ line: l, gross, discount, offered }) => {
          const d = discountOf(l)
          return (
            <li key={l.id}>
              <div className="receipt-row">
                <span>{l.quantity} × <bdi>{l.name}</bdi></span>
                <span>{offered ? t.offered.toUpperCase() : money(gross)}</span>
              </div>
              {l.options.length > 0 && <div className="receipt-sub">{l.options.map((o) => o.name).join(t.listSep)}</div>}
              {(l.quantity > 1 || offered) && <div className="receipt-sub">{l.quantity} × {money(l.unit_price)}{offered && <> · {t.offered} ({money(gross)})</>}</div>}
              {d && discount > 0 && (
                <div className="receipt-row receipt-sub">
                  <span>{d.type === 'percent' ? t.discountPct(String(d.value)) : t.discount}</span>
                  <span>{minus(discount)}</span>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <div className="receipt-sep" />
      {adjusted && (
        <>
          <div className="receipt-row"><span>{t.subtotal}</span><span>{money(bill.gross)}</span></div>
          {bill.offered > 0 && <div className="receipt-row"><span>{order.offered ? t.orderOffered : t.offered}</span><span>{minus(bill.offered)}</span></div>}
          {bill.lineDiscounts > 0 && <div className="receipt-row"><span>{t.discount}</span><span>{minus(bill.lineDiscounts)}</span></div>}
          {bill.orderDiscount > 0 && (
            <div className="receipt-row">
              <span>{order.discount_type === 'percent' ? `${t.discountOrder} (${order.discount_value} %)` : t.discountOrder}</span>
              <span>{minus(bill.orderDiscount)}</span>
            </div>
          )}
        </>
      )}
      <div className="receipt-row receipt-total">
        <span>{t.total}</span>
        <span>{money(bill.total)}</span>
      </div>
      {single ? (
        <>
          <div className="receipt-row">
            <span>{t.paidBy}</span>
            <span>{t.payMethod[single.method] ?? single.method}</span>
          </div>
          {single.method === 'cash' && (
            <>
              <div className="receipt-row"><span>{t.received}</span><span>{money(single.received)}</span></div>
              <div className="receipt-row"><span>{t.change}</span><span>{money(single.change_amount)}</span></div>
            </>
          )}
        </>
      ) : payments.length > 1 ? (
        <>
          <div className="receipt-subtitle">{t.payHistory} ({t.partial})</div>
          {payments.map((p) => (
            <div key={p.id}>
              <div className="receipt-row">
                <span>{clock(p.created_at)} · {t.payMethod[p.method] ?? p.method}</span>
                <span>{money(p.amount)}</span>
              </div>
              {p.change_amount > 0 && <div className="receipt-sub">{t.received} {money(p.received)} · {t.change} {money(p.change_amount)}</div>}
            </div>
          ))}
          {changeTotal > 0 && <div className="receipt-row"><span>{t.change}</span><span>{money(changeTotal)}</span></div>}
        </>
      ) : null}
      <div className="receipt-sep" />
      {settings.footer && <div className="receipt-footer">{textLines(settings.footer)}</div>}
    </div>
  )
}

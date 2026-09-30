import type { Order, OrderLine, PaidOrder, Payment, ReceiptSettings } from '../lib/types'
import { money } from '../lib/format'
import { computeBill, discountOf } from '../lib/billing'
import { useI18n } from '../lib/i18n'
import { deliveryContact } from '../lib/place'

/** receipt: after the last payment. bill: the running bill of an open order (Addition). invoice: Facture. */
export type ReceiptKind = 'receipt' | 'bill' | 'invoice'

interface Props {
  settings: ReceiptSettings
  /** A paid order for a receipt; any order (open or paid) for a bill or an invoice. */
  order: Order & Partial<Pick<PaidOrder, 'ticket_no' | 'closed_at'>>
  lines: OrderLine[]
  /** Payments of the order, oldest first (several for a partial payment). */
  payments: Payment[]
  /** "Table 4", "À emporter n° 12" or "Livraison n° 3". */
  place: string | null
  hallName: string | null
  kind?: ReceiptKind
}

const textLines = (text: string) => text.split('\n').map((line, i) => <div key={i} dir="auto">{line || '\u00a0'}</div>)

const minus = (n: number) => <bdi dir="ltr">−{money(n)}</bdi>

/**
 * The printed ticket: logo and name, items with their discounts and offers, total, payments (with change given back)
 * and closing message. Sized for 80 mm receipt paper.
 */
export default function Receipt({ settings, order, lines, payments, place, hallName, kind = 'receipt' }: Props) {
  const { t } = useI18n()
  const date = order.closed_at ? new Date(order.closed_at) : new Date()
  const bill = computeBill(order, lines, payments)
  const adjusted = bill.offered > 0 || bill.lineDiscounts > 0 || bill.orderDiscount > 0
  const clock = (iso: string) => new Date(iso).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const changeTotal = payments.reduce((s, p) => s + p.change_amount, 0)
  const single = payments.length === 1 && bill.remaining === 0 ? payments[0] : null
  const number = (n: number | null | undefined) => String(n ?? '').padStart(6, '0')
  const title = kind === 'invoice' ? t.invoiceNo(number(order.invoice_no)) : kind === 'bill' ? t.bill : t.ticketNo(number(order.ticket_no))

  return (
    <div className="receipt">
      <img className="receipt-logo" src={settings.logo || '/icon.svg'} alt="" width={64} height={64} />
      <div className="receipt-name" dir="auto">{settings.name}</div>
      {/* Each line picks its own direction, so French text stays readable on an Arabic ticket and vice versa. */}
      {settings.header && <div className="receipt-header">{textLines(settings.header)}</div>}
      <div className="receipt-sep" />
      <div className="receipt-meta">
        <span>{title}</span>
        <span>{date.toLocaleDateString(t.locale)} {date.toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span>
      </div>
      {place && (
        <div className="receipt-meta">
          <span>{place}</span>
          {hallName && <bdi>{hallName}</bdi>}
        </div>
      )}
      {kind === 'bill' && <div className="receipt-sub receipt-note">{t.billNote}</div>}
      {order.order_type === 'delivery' ? (
        <div className="receipt-customer receipt-delivery">
          <div><strong>[{t.delivery}]</strong></div>
          {deliveryContact(order) && <div dir="auto">{deliveryContact(order)}</div>}
          {order.customer_address && textLines(order.customer_address)}
          {order.delivery_zone_name && <div>{t.deliveryZone} : <bdi>{order.delivery_zone_name}</bdi></div>}
        </div>
      ) : kind === 'invoice' && (order.customer_name || order.customer_address) && (
        <div className="receipt-customer">
          <div><strong>{t.customer}</strong> : <bdi>{order.customer_name ?? ''}</bdi></div>
          {order.customer_address && textLines(order.customer_address)}
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
              {l.is_takeaway && <div className="receipt-sub receipt-emp">[{t.lineTakeaway}]</div>}
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
      {bill.delivery > 0 && (
        <>
          {!adjusted && <div className="receipt-row"><span>{t.subtotal}</span><span>{money(bill.gross)}</span></div>}
          <div className="receipt-row"><span>{t.deliveryFee}</span><span>{money(bill.delivery)}</span></div>
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
      ) : payments.length > 0 ? (
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
      {kind !== 'receipt' && bill.remaining > 0 && bill.paid > 0 && (
        <div className="receipt-row receipt-total"><span>{t.remaining}</span><span>{money(bill.remaining)}</span></div>
      )}
      <div className="receipt-sep" />
      {settings.footer && <div className="receipt-footer">{textLines(settings.footer)}</div>}
    </div>
  )
}

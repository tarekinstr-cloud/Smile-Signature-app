import type { OrderLine, PaidOrder, ReceiptSettings } from '../lib/types'
import { money } from '../lib/format'
import { useI18n } from '../lib/i18n'

interface Props {
  settings: ReceiptSettings
  order: PaidOrder
  lines: OrderLine[]
  tableLabel: string | null
  hallName: string | null
}

/** The printed ticket: logo and name, items, total, payment method and closing message. Sized for 80 mm receipt paper. */
const textLines = (text: string) => text.split('\n').map((line, i) => <div key={i} dir="auto">{line || '\u00a0'}</div>)

export default function Receipt({ settings, order, lines, tableLabel, hallName }: Props) {
  const { t } = useI18n()
  const date = new Date(order.closed_at)
  const change = order.payment_method === 'cash' ? order.amount_received - order.total : 0

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
        {lines.map((l) => (
          <li key={l.id}>
            <div className="receipt-row">
              <span>{l.quantity} × {l.name}</span>
              <span>{money(l.unit_price * l.quantity)}</span>
            </div>
            {l.options.length > 0 && <div className="receipt-sub">{l.options.map((o) => o.name).join(t.listSep)}</div>}
            {l.quantity > 1 && <div className="receipt-sub">{l.quantity} × {money(l.unit_price)}</div>}
          </li>
        ))}
      </ul>
      <div className="receipt-sep" />
      <div className="receipt-row receipt-total">
        <span>{t.total}</span>
        <span>{money(order.total)}</span>
      </div>
      <div className="receipt-row">
        <span>{t.paidBy}</span>
        <span>{order.payment_method === 'cash' ? t.cash : t.card}</span>
      </div>
      {order.payment_method === 'cash' && (
        <>
          <div className="receipt-row">
            <span>{t.received}</span>
            <span>{money(order.amount_received)}</span>
          </div>
          <div className="receipt-row">
            <span>{t.change}</span>
            <span>{money(change)}</span>
          </div>
        </>
      )}
      <div className="receipt-sep" />
      {settings.footer && <div className="receipt-footer">{textLines(settings.footer)}</div>}
    </div>
  )
}

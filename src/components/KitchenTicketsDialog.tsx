import { createPortal } from 'react-dom'
import type { KitchenTicket as Ticket, KitchenTicketLine } from '../lib/types'
import { useI18n } from '../lib/i18n'

interface Props {
  /** Tickets no printing driver took, shown here instead. */
  tickets: Ticket[]
  /** How many tickets were built in all (some may have gone straight to a printer). */
  sentCount: number
  unrouted: KitchenTicketLine[]
  onClose(): void
}

function Lines({ lines }: { lines: KitchenTicketLine[] }) {
  return (
    <ul className="receipt-lines kt-lines">
      {lines.map((l, i) => (
        <li key={i}>
          <div className="kt-line"><strong>{l.quantity} ×</strong> <bdi>{l.name}</bdi></div>
          {l.options.map((o, j) => <div key={j} className="receipt-sub">+ <bdi>{o}</bdi></div>)}
          {l.note && <div className="receipt-sub kt-note">» <bdi>{l.note}</bdi></div>}
        </li>
      ))}
    </ul>
  )
}

/** A kitchen ticket as printed: printer, table, time, waiter and the new items only, without prices. 80 mm paper. */
export function KitchenTicketView({ ticket }: { ticket: Ticket }) {
  const { t } = useI18n()
  const at = new Date(ticket.created_at)
  return (
    <div className="receipt kitchen-ticket">
      <div className="kt-printer" dir="auto">{ticket.printer_name}</div>
      {ticket.table_label && <div className="kt-table">{t.table(ticket.table_label)}</div>}
      <div className="receipt-sep" />
      <div className="receipt-meta">
        <span>{t.ticketTime}</span>
        <span>{at.toLocaleDateString(t.locale)} {at.toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span>
      </div>
      <div className="receipt-meta">
        <span>{t.waiter}</span>
        <bdi>{ticket.waiter}</bdi>
      </div>
      <div className="receipt-sep" />
      <Lines lines={ticket.lines} />
      <div className="receipt-sep" />
    </div>
  )
}

/** Shown after Valider: a preview of each printer's ticket, printable from the browser. */
export default function KitchenTicketsDialog({ tickets, sentCount, unrouted, onClose }: Props) {
  const { t } = useI18n()
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog receipt-dialog kitchen-dialog" role="dialog" aria-modal="true" aria-labelledby="kitchen-title"
        onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="panel-head">
          <h2 id="kitchen-title">{t.kitchenTickets}</h2>
          <span className="pill free">{sentCount}</span>
        </div>
        {tickets.length > 0 ? (
          <p className="muted small">{t.kitchenPreviewHint}</p>
        ) : (
          sentCount > 0 && <p className="small">{t.kitchenAllPrinted}</p>
        )}
        {tickets.map((ticket) => (
          <div key={ticket.id} className="receipt-paper">
            <KitchenTicketView ticket={ticket} />
          </div>
        ))}
        {unrouted.length > 0 && (
          <div className="unrouted">
            <strong>{t.unroutedTitle}</strong>
            <span className="muted small">{t.unroutedHint}</span>
            <Lines lines={unrouted} />
          </div>
        )}
        <div className="dialog-actions">
          <div className="spacer" />
          {tickets.length > 0 && <button type="button" onClick={() => window.print()}>{t.print}</button>}
          <button type="button" className="primary" autoFocus onClick={onClose}>{t.close}</button>
        </div>
      </div>
      {/* Printing shows only these tickets, one per page; see the print styles. */}
      {createPortal(
        <div className="print-area">
          {tickets.map((ticket) => <KitchenTicketView key={ticket.id} ticket={ticket} />)}
        </div>,
        document.body,
      )}
    </div>
  )
}

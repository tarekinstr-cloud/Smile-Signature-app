import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { defaultReceiptSettings, repo } from '../lib/repo'
import type { Order, OrderLine, Payment, ReceiptSettings } from '../lib/types'
import Receipt, { type ReceiptKind } from './Receipt'
import { useI18n } from '../lib/i18n'

interface DocProps {
  order: Order
  lines: OrderLine[]
  payments: Payment[]
  place: string
  hallName: string | null
}

function useReceiptSettings() {
  const [settings, setSettings] = useState<ReceiptSettings | null>(null)
  useEffect(() => {
    repo.getReceiptSettings().then(setSettings, () => setSettings(defaultReceiptSettings()))
  }, [])
  return settings
}

/** A printable paper (bill or invoice) inside a dialog, with a browser print button. */
function Paper({ title, kind, doc, settings, extra, actions, onPrinted, onClose }: {
  title: string
  kind: ReceiptKind
  doc: DocProps
  settings: ReceiptSettings | null
  extra?: ReactNode
  actions?: ReactNode
  /** Called when the paper is sent to the printer. */
  onPrinted?(): void
  onClose(): void
}) {
  const { t } = useI18n()
  const paper = settings && <Receipt settings={settings} kind={kind} {...doc} />
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog receipt-dialog" role="dialog" aria-modal="true" aria-labelledby="doc-title" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="panel-head">
          <h2 id="doc-title">{title}</h2>
        </div>
        {extra}
        <div className="receipt-paper">{paper ?? <p className="muted">{t.loading}</p>}</div>
        <div className="dialog-actions">
          {actions}
          <div className="spacer" />
          <button type="button" onClick={() => { onPrinted?.(); window.print() }} disabled={!settings}>{t.print}</button>
          <button type="button" className="primary" autoFocus onClick={onClose}>{t.close}</button>
        </div>
      </div>
      {/* Printing shows only this paper; see the print styles. */}
      {paper && createPortal(<div className="print-area">{paper}</div>, document.body)}
    </div>
  )
}

/** Imprimer → Ticket caisse: the running bill (Addition) of the open order. */
export function BillDialog({ onClose, ...doc }: DocProps & { onClose(): void }) {
  const { t } = useI18n()
  const settings = useReceiptSettings()
  // A printed bill can only be cancelled with the cancel_invoice permission (Factures annulées).
  const printed = () => repo.markPrinted(doc.order.id).catch(() => {})
  return <Paper title={t.bill} kind="bill" doc={doc} settings={settings} onPrinted={printed} onClose={onClose} />
}

/**
 * Facture: optional customer name and address, then the numbered invoice, separate from the cash receipt.
 * The number is given the first time; making it again keeps it and only updates the customer.
 */
export function InvoiceDialog({ onClose, ...doc }: DocProps & { onClose(): void }) {
  const { t } = useI18n()
  const settings = useReceiptSettings()
  const [order, setOrder] = useState<Order>(doc.order)
  const [editing, setEditing] = useState(doc.order.invoice_no == null)
  const [name, setName] = useState(doc.order.customer_name ?? '')
  const [address, setAddress] = useState(doc.order.customer_address ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setOrder(await repo.issueInvoice(order.id, { name, address }))
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setBusy(false)
  }

  if (editing) {
    return (
      <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
        <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="invoice-title" onSubmit={submit}
          onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
          <h2 id="invoice-title">{t.invoice} · {doc.place}</h2>
          <span className="muted small">{t.invoiceCustomer}</span>
          <label>
            {t.customerName}
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            {t.customerAddress}
            <textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} />
          </label>
          {error && <p className="error small">{error}</p>}
          <div className="dialog-actions">
            <button type="button" onClick={onClose} disabled={busy}>{t.cancel}</button>
            <button type="submit" className="primary" disabled={busy}>{busy ? t.saving : t.generateInvoice}</button>
          </div>
        </form>
      </div>
    )
  }

  return (
    <Paper title={t.invoice} kind="invoice" doc={{ ...doc, order }} settings={settings} onClose={onClose}
      actions={<button type="button" className="ghost" onClick={() => setEditing(true)}>{t.editCustomer}</button>} />
  )
}

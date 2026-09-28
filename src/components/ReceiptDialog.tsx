import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { defaultReceiptSettings, repo } from '../lib/repo'
import type { OrderLine, PaidOrder, Payment, ReceiptSettings } from '../lib/types'
import Receipt from './Receipt'
import { useI18n } from '../lib/i18n'

interface Props {
  order: PaidOrder
  lines: OrderLine[]
  payments: Payment[]
  tableLabel: string | null
  hallName: string | null
  onDone(): void
}

/** Shown after checkout: the ticket on screen, a print button and the ticket's editable texts. */
export default function ReceiptDialog({ order, lines, payments, tableLabel, hallName, onDone }: Props) {
  const { t } = useI18n()
  const [settings, setSettings] = useState<ReceiptSettings | null>(null)
  const [editing, setEditing] = useState<ReceiptSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    repo.getReceiptSettings().then(setSettings, () => setSettings(defaultReceiptSettings()))
  }, [])

  async function saveSettings() {
    if (!editing) return
    const next = { name: editing.name.trim() || defaultReceiptSettings().name, header: editing.header.trim(), footer: editing.footer.trim() }
    try {
      setError(null)
      await repo.updateReceiptSettings(next)
      setSettings(next)
      setEditing(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const shown = editing ?? settings
  const ticket = shown && <Receipt settings={shown} order={order} lines={lines} payments={payments} tableLabel={tableLabel} hallName={hallName} />

  return (
    <div className="dialog-backdrop">
      <div className="dialog receipt-dialog" role="dialog" aria-modal="true" aria-labelledby="receipt-title">
        <div className="panel-head">
          <h2 id="receipt-title">{editing ? t.receiptSettings : t.receipt}</h2>
          {!editing && <span className="pill free">{t.paid}</span>}
        </div>
        {error && <p className="error small">{error}</p>}
        {editing && (
          <div className="receipt-form">
            <label>
              {t.receiptName}
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <label>
              {t.receiptHeader}
              <textarea rows={3} value={editing.header} onChange={(e) => setEditing({ ...editing, header: e.target.value })} />
            </label>
            <label>
              {t.receiptFooter}
              <textarea rows={2} value={editing.footer} onChange={(e) => setEditing({ ...editing, footer: e.target.value })} />
            </label>
            <span className="muted small">{t.receiptPreview}</span>
          </div>
        )}
        <div className="receipt-paper">{ticket ?? <p className="muted">{t.loading}</p>}</div>
        <div className="dialog-actions">
          {editing ? (
            <>
              <button type="button" onClick={() => setEditing(null)}>{t.cancel}</button>
              <button type="button" className="primary" onClick={saveSettings}>{t.save}</button>
            </>
          ) : (
            <>
              <button type="button" className="ghost" onClick={() => settings && setEditing(settings)} disabled={!settings}>{t.customize}</button>
              <div className="spacer" />
              <button type="button" onClick={() => window.print()} disabled={!settings}>{t.print}</button>
              <button type="button" className="primary" onClick={onDone}>{t.doneBack}</button>
            </>
          )}
        </div>
      </div>
      {/* Printing shows only this copy of the ticket; see the print styles. */}
      {settings && createPortal(<div className="print-area">{ticket}</div>, document.body)}
    </div>
  )
}

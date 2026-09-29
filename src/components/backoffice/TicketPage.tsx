import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { defaultReceiptSettings, repo } from '../../lib/repo'
import type { Order, OrderLine, PaidOrder, Payment, ReceiptSettings } from '../../lib/types'
import { useI18n } from '../../lib/i18n'
import Receipt from '../Receipt'
import { errorText } from './useLoad'

/** Largest side of the stored logo, in pixels: sharp on 80 mm paper, small enough to keep in the database. */
const LOGO_PX = 240

/** Reads an image file and returns it scaled down as a PNG data URL (white background, for thermal printers). */
function shrinkImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, LOGO_PX / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.width * scale))
      canvas.height = Math.max(1, Math.round(img.height * scale))
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image'))
    }
    img.src = url
  })
}

/** Fichier → Modifier le Ticket: logo, name, lines under it and closing message, with a live preview. */
export default function TicketPage() {
  const { t } = useI18n()
  const [receipt, setReceipt] = useState<ReceiptSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  useEffect(() => {
    repo.getReceiptSettings().then(setReceipt, () => setReceipt(defaultReceiptSettings()))
  }, [])

  const edit = (patch: Partial<ReceiptSettings>) => {
    setSaved(false)
    setReceipt((r) => r && { ...r, ...patch })
  }

  async function pickLogo(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      setError(null)
      edit({ logo: await shrinkImage(f) })
    } catch {
      setError(t.errLogo)
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!receipt) return
    const next: ReceiptSettings = {
      name: receipt.name.trim() || defaultReceiptSettings().name, header: receipt.header.trim(), footer: receipt.footer.trim(),
      logo: receipt.logo || null,
    }
    setBusy(true)
    try {
      setError(null)
      await repo.updateReceiptSettings(next)
      setReceipt(next)
      setSaved(true)
    } catch (err) {
      const msg = errorText(err)
      setError(/logo/.test(msg) && /schema cache|Could not find|does not exist/i.test(msg) ? t.errMigrationUsers : msg)
    }
    setBusy(false)
  }

  // A small paid order, only for the preview.
  const sample = useMemo(() => {
    const now = new Date().toISOString()
    const base = { discount_type: null, discount_value: 0, offered: false }
    const order: Order & Pick<PaidOrder, 'ticket_no' | 'closed_at'> = {
      ...base, id: 'preview', table_id: null, status: 'paid', note: null, created_at: now, order_type: 'dine_in',
      takeaway_no: null, delivery_no: null, customer_name: null, customer_address: null, customer_phone: null,
      delivery_status: null, invoice_no: null, ticket_no: 42, closed_at: now,
    }
    const line = (id: string, name: string, unit_price: number, quantity: number, options: OrderLine['options']): OrderLine => ({
      ...base, id, order_id: 'preview', item_id: null, name, unit_price, quantity, options, note: null, created_at: now,
      sent_at: now, is_takeaway: false,
    })
    const lines = [
      line('l1', t.sampleItem1, 1200, 1, [{ group: '', name: t.sampleOption, price_delta: 0 }]),
      line('l2', t.sampleItem2, 150, 2, []),
    ]
    const payments: Payment[] = [{ id: 'p1', order_id: 'preview', method: 'cash', amount: 1500, received: 2000, change_amount: 500, created_at: now }]
    return { order, lines, payments }
  }, [t])

  return (
    <main className="content bo-content ticket-content">
      <form className="panel" onSubmit={save}>
        {error && <p className="error small">{error}</p>}
        {!receipt ? (
          <p className="muted">{t.loading}</p>
        ) : (
          <>
            <div className="field">
              {t.ticketLogo}
              <div className="logo-row">
                <img className="logo-thumb" src={receipt.logo || '/icon.svg'} alt="" />
                <div className="logo-actions">
                  <button type="button" onClick={() => file.current?.click()}>{t.logoChange}</button>
                  {receipt.logo && <button type="button" className="ghost" onClick={() => edit({ logo: null })}>{t.logoReset}</button>}
                </div>
                <input ref={file} type="file" accept="image/*" hidden onChange={pickLogo} />
              </div>
              <span className="small">{t.logoHint}</span>
            </div>
            <label>
              {t.receiptName}
              <input value={receipt.name} onChange={(e) => edit({ name: e.target.value })} />
            </label>
            <label>
              {t.receiptHeader}
              <textarea rows={3} value={receipt.header} onChange={(e) => edit({ header: e.target.value })} />
            </label>
            <label>
              {t.receiptFooter}
              <textarea rows={2} value={receipt.footer} onChange={(e) => edit({ footer: e.target.value })} />
            </label>
            <div className="dialog-actions">
              {saved && <span className="muted small saved">{t.saved}</span>}
              <button type="submit" className="primary" disabled={busy}>{t.save}</button>
            </div>
          </>
        )}
      </form>

      <section className="panel ticket-preview">
        <h2>{t.ticketPreview}</h2>
        {receipt && (
          <Receipt settings={receipt} order={sample.order} lines={sample.lines} payments={sample.payments} place={t.table('4')} hallName={null} />
        )}
      </section>
    </main>
  )
}

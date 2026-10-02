import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { defaultReceiptSettings, normalizeReceipt, repo } from '../../lib/repo'
import type { Order, OrderLine, PaidOrder, Payment, ReceiptSettings } from '../../lib/types'
import { useI18n } from '../../lib/i18n'
import { usePermissions } from '../../lib/permissions'
import Receipt from '../Receipt'
import BackupPage from './BackupPage'
import { ConfigPage } from './FloorSettingsPages'
import { errorText } from './useLoad'
import { PaymentTab, ReasonsTab, SecurityTab } from './ConfigTabsMore'

export type ConfigTab = 'restaurant' | 'ticket' | 'payment' | 'reasons' | 'service' | 'security' | 'backup'

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

/** A small paid order, only for the ticket preview. */
function useSample() {
  const { t } = useI18n()
  return useMemo(() => {
    const now = new Date().toISOString()
    const base = { discount_type: null, discount_value: 0, offered: false }
    const order: Order & Pick<PaidOrder, 'ticket_no' | 'closed_at'> = {
      ...base, id: 'preview', table_id: null, status: 'paid', note: null, created_at: now, order_type: 'dine_in',
      takeaway_no: null, delivery_no: null, customer_name: null, customer_address: null, customer_phone: null,
      delivery_status: null, invoice_no: null, ticket_no: 42, closed_at: now, created_by_name: 'agent1',
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
}

/**
 * Paramètres > Configurations, in tabs: Restaurant (name, address, phone, logo, NIF, RC, NIS, AI), Ticket (header,
 * footer, paper width, language, waiter and table shown), Paiement (payment modes), Motifs (cancel, offer and discount
 * reasons), Service (timer, order numbers, pager), Sécurité (PIN login, automatic sign-out) and Sauvegarde.
 * Restaurant and Ticket save the same receipt settings, with a live preview of the ticket.
 */
export default function ConfigurationsPage({ initialTab = 'restaurant' }: { initialTab?: ConfigTab }) {
  const { t } = useI18n()
  const { can } = usePermissions()
  const [tab, setTab] = useState<ConfigTab>(initialTab)
  useEffect(() => setTab(initialTab), [initialTab])
  const tabs: [ConfigTab, string][] = [
    ['restaurant', t.cfgTabRestaurant], ['ticket', t.cfgTabTicket], ['payment', t.cfgTabPayment], ['reasons', t.cfgTabReasons],
    ['service', t.cfgTabService], ['security', t.cfgTabSecurity],
    ...(can('backup') ? [['backup', t.cfgTabBackup] as [ConfigTab, string]] : []),
  ]
  return (
    <>
      <div className="segmented bo-tabs cfg-tabs" role="tablist" aria-label={t.cfgTitle}>
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {(tab === 'restaurant' || tab === 'ticket') && <ReceiptForm tab={tab} />}
      {tab === 'payment' && <PaymentTab />}
      {tab === 'reasons' && <ReasonsTab />}
      {tab === 'service' && <ConfigPage />}
      {tab === 'security' && <SecurityTab />}
      {tab === 'backup' && can('backup') && <BackupPage />}
    </>
  )
}

function ReceiptForm({ tab }: { tab: 'restaurant' | 'ticket' }) {
  const { t } = useI18n()
  const sample = useSample()
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
    const trim = (v: string | undefined, max: number) => (v ?? '').trim().slice(0, max)
    const next = normalizeReceipt({
      ...receipt,
      name: receipt.name.trim() || defaultReceiptSettings().name, header: receipt.header.trim(), footer: receipt.footer.trim(),
      logo: receipt.logo || null, address: trim(receipt.address, 300), phone: trim(receipt.phone, 60),
      nif: trim(receipt.nif, 40), rc: trim(receipt.rc, 40), nis: trim(receipt.nis, 40), ai: trim(receipt.ai, 40),
    })
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

  const field = (label: string, key: 'nif' | 'rc' | 'nis' | 'ai' | 'phone', extra?: { dir?: string; type?: string }): ReactNode => (
    <label key={key}>
      {label}
      <input value={receipt?.[key] ?? ''} dir={extra?.dir} type={extra?.type} onChange={(e) => edit({ [key]: e.target.value })} />
    </label>
  )

  return (
    <main className="content bo-content ticket-content">
      <form className="panel" onSubmit={save}>
        {error && <p className="error small">{error}</p>}
        {!receipt ? (
          <p className="muted">{t.loading}</p>
        ) : tab === 'restaurant' ? (
          <>
            <label>
              {t.cfgRestaurantName}
              <input value={receipt.name} onChange={(e) => edit({ name: e.target.value })} />
            </label>
            <label>
              {t.cfgAddress}
              <textarea rows={2} value={receipt.address ?? ''} onChange={(e) => edit({ address: e.target.value })} />
            </label>
            {field(t.cfgPhone, 'phone', { dir: 'ltr', type: 'tel' })}
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
            <div className="cfg-ids">
              {field('NIF', 'nif', { dir: 'ltr' })}
              {field('RC', 'rc', { dir: 'ltr' })}
              {field('NIS', 'nis', { dir: 'ltr' })}
              {field('AI', 'ai', { dir: 'ltr' })}
            </div>
            <p className="muted small">{t.cfgIdsHint}</p>
          </>
        ) : (
          <>
            <label>
              {t.receiptHeader}
              <textarea rows={3} value={receipt.header} onChange={(e) => edit({ header: e.target.value })} />
            </label>
            <label>
              {t.receiptFooter}
              <textarea rows={2} value={receipt.footer} onChange={(e) => edit({ footer: e.target.value })} />
            </label>
            <div className="field">
              <span>{t.cfgPaperWidth}</span>
              <div className="segmented" role="group" aria-label={t.cfgPaperWidth}>
                {([80, 58] as const).map((w) => (
                  <button key={w} type="button" className={receipt.paper_width === w ? 'on' : ''} aria-pressed={receipt.paper_width === w}
                    onClick={() => edit({ paper_width: w })}>{w} mm</button>
                ))}
              </div>
            </div>
            <div className="field">
              <span>{t.cfgTicketLang}</span>
              <div className="segmented" role="group" aria-label={t.cfgTicketLang}>
                {([[null, t.cfgLangDevice], ['fr', 'Français'], ['ar', 'العربية']] as const).map(([l, label]) => (
                  <button key={l ?? 'device'} type="button" className={receipt.ticket_lang === l ? 'on' : ''} aria-pressed={receipt.ticket_lang === l}
                    onClick={() => edit({ ticket_lang: l })} lang={l ?? undefined}>{label}</button>
                ))}
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={receipt.show_waiter !== false} onChange={(e) => edit({ show_waiter: e.target.checked })} />
              {t.cfgShowWaiter}
            </label>
            <label className="check">
              <input type="checkbox" checked={receipt.show_table !== false} onChange={(e) => edit({ show_table: e.target.checked })} />
              {t.cfgShowTable}
            </label>
          </>
        )}
        {receipt && (
          <div className="dialog-actions">
            {saved && <span className="muted small saved">{t.saved}</span>}
            <button type="submit" className="primary" disabled={busy}>{t.save}</button>
          </div>
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

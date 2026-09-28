import { useEffect, useState, type FormEvent } from 'react'
import { defaultReceiptSettings, repo } from '../../lib/repo'
import type { ReceiptSettings } from '../../lib/types'
import { useI18n } from '../../lib/i18n'
import { errorText } from './useLoad'

/** Paramètres: what already exists in one place (restaurant on the ticket, language, currency) and links to the other settings. */
export default function SettingsPage({ onOpenMenu, onOpenPrinters }: { onOpenMenu(): void; onOpenPrinters(): void }) {
  const { t, lang, setLang } = useI18n()
  const [receipt, setReceipt] = useState<ReceiptSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    repo.getReceiptSettings().then(setReceipt, () => setReceipt(defaultReceiptSettings()))
  }, [])

  const edit = (patch: Partial<ReceiptSettings>) => {
    setSaved(false)
    setReceipt((r) => r && { ...r, ...patch })
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!receipt) return
    const next = { name: receipt.name.trim() || defaultReceiptSettings().name, header: receipt.header.trim(), footer: receipt.footer.trim() }
    setBusy(true)
    try {
      setError(null)
      await repo.updateReceiptSettings(next)
      setReceipt(next)
      setSaved(true)
    } catch (err) {
      setError(errorText(err))
    }
    setBusy(false)
  }

  return (
    <main className="content bo-content settings-content">
      <form className="panel" onSubmit={save}>
        <h2>{t.restaurantInfo}</h2>
        {error && <p className="error small">{error}</p>}
        {!receipt ? (
          <p className="muted">{t.loading}</p>
        ) : (
          <>
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

      <section className="panel">
        <h2>{t.language}</h2>
        <div className="segmented" role="group" aria-label={t.language}>
          <button type="button" className={lang === 'fr' ? 'on' : ''} aria-pressed={lang === 'fr'} onClick={() => setLang('fr')} lang="fr">Français</button>
          <button type="button" className={lang === 'ar' ? 'on' : ''} aria-pressed={lang === 'ar'} onClick={() => setLang('ar')} lang="ar">العربية</button>
        </div>
        <p className="muted small">{t.languageHint}</p>
        <h2>{t.currencyLabel}</h2>
        <p>{t.currencyValue}</p>
      </section>

      <section className="panel">
        <h2>{t.otherSettings}</h2>
        <button className="big" onClick={onOpenMenu}>🍽 {t.menu} <span className="muted small">{t.menuTitle}</span></button>
        <button className="big" onClick={onOpenPrinters}>🖨 {t.printers} <span className="muted small">{t.printersTitle}</span></button>
      </section>
    </main>
  )
}

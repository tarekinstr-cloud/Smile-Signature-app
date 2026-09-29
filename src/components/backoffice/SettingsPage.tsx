import { useI18n } from '../../lib/i18n'

/** Paramètres: language and currency in one place, and links to the other settings (ticket, menu, printers). */
export default function SettingsPage({ onOpenMenu, onOpenPrinters, onOpenTicket }: { onOpenMenu(): void; onOpenPrinters(): void; onOpenTicket(): void }) {
  const { t, lang, setLang } = useI18n()

  return (
    <main className="content bo-content settings-content">
      <section className="panel">
        <h2>{t.restaurantInfo}</h2>
        <button className="big" onClick={onOpenTicket}>🧾 {t.fileTicket} <span className="muted small">{t.ticketSub}</span></button>
      </section>

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

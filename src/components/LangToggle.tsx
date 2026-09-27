import { useI18n } from '../lib/i18n'

/** Top-bar button that switches between French and Arabic; shows the language it switches to. */
export default function LangToggle() {
  const { lang, t, setLang } = useI18n()
  return (
    <button type="button" className="ghost lang-toggle" onClick={() => setLang(lang === 'fr' ? 'ar' : 'fr')}
      aria-label={t.switchLabel} title={t.switchLabel} lang={lang === 'fr' ? 'ar' : 'fr'}>
      {t.switchTo}
    </button>
  )
}

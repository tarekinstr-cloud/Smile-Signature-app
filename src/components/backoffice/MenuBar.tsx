import { useI18n } from '../../lib/i18n'
import { BACK_OFFICE_PAGES, PAGE_ICONS, type BackOfficePage } from './pages'

/** Back-office menu bar (classic cash-register style): Statistiques, Stock, Fournisseurs, Employés, Paramètres. */
export default function MenuBar({ current, onOpen }: { current?: BackOfficePage; onOpen(page: BackOfficePage): void }) {
  const { t } = useI18n()
  const label: Record<BackOfficePage, string> = {
    stats: t.statistics, stock: t.stock, suppliers: t.suppliers, staff: t.staff, settings: t.settings,
  }
  return (
    <nav className="menubar" aria-label={t.backOfficeNav}>
      {BACK_OFFICE_PAGES.map((p) => (
        <button key={p} className={p === current ? 'on' : ''} aria-current={p === current ? 'page' : undefined} onClick={() => onOpen(p)}>
          <span aria-hidden>{PAGE_ICONS[p]}</span> {label[p]}
        </button>
      ))}
    </nav>
  )
}

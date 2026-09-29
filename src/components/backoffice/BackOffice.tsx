import type { ReactNode } from 'react'
import { useI18n } from '../../lib/i18n'
import type { BackOfficePage } from './pages'
import StatsPage from './StatsPage'
import StockPage from './StockPage'
import SuppliersPage from './SuppliersPage'
import StaffPage from './StaffPage'
import SettingsPage from './SettingsPage'

interface Props {
  page: BackOfficePage
  /** The administration menus (line 1), kept on top so pages can be switched without going back to the floor. */
  menu: ReactNode
  onBack(): void
  /** Opens the existing Menu and Imprimantes screens (shortcuts from Paramètres). */
  onOpenMenu(): void
  onOpenPrinters(): void
}

/** Back-office screen: Statistiques, Stock, Fournisseurs, Employés or Paramètres, under the administration menus. */
export default function BackOffice({ page, menu, onBack, onOpenMenu, onOpenPrinters }: Props) {
  const { t } = useI18n()
  const title: Record<BackOfficePage, [string, string]> = {
    stats: [t.statistics, t.statsSub],
    stock: [t.stock, t.stockSub],
    suppliers: [t.suppliers, t.suppliersSub],
    staff: [t.staff, t.staffSub],
    settings: [t.settings, t.settingsSub],
  }
  return (
    <div className="app back-office">
      {menu}
      <header className="topbar">
        <button className="ghost back" onClick={onBack} aria-label={t.backToFloor}>{t.back}</button>
        <div className="order-title">
          <strong>{title[page][0]}</strong>
          <span>{title[page][1]}</span>
        </div>
      </header>
      {page === 'stats' && <StatsPage />}
      {page === 'stock' && <StockPage />}
      {page === 'suppliers' && <SuppliersPage />}
      {page === 'staff' && <StaffPage />}
      {page === 'settings' && <SettingsPage onOpenMenu={onOpenMenu} onOpenPrinters={onOpenPrinters} />}
    </div>
  )
}

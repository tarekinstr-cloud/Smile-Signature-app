import { useState } from 'react'
import LangToggle from '../LangToggle'
import { useI18n } from '../../lib/i18n'
import MenuBar from './MenuBar'
import type { BackOfficePage } from './pages'
import StatsPage from './StatsPage'
import StockPage from './StockPage'
import SuppliersPage from './SuppliersPage'
import StaffPage from './StaffPage'
import SettingsPage from './SettingsPage'

interface Props {
  page: BackOfficePage
  onBack(): void
  /** Opens the existing Menu and Imprimantes screens (shortcuts from Paramètres). */
  onOpenMenu(): void
  onOpenPrinters(): void
}

/** Back-office screen: the menu bar stays on top so the pages can be switched without going back to the floor. */
export default function BackOffice({ page: first, onBack, onOpenMenu, onOpenPrinters }: Props) {
  const [page, setPage] = useState(first)
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
      <header className="topbar">
        <button className="ghost back" onClick={onBack} aria-label={t.backToFloor}>{t.back}</button>
        <div className="order-title">
          <strong>{title[page][0]}</strong>
          <span>{title[page][1]}</span>
        </div>
        <div className="spacer" />
        <LangToggle />
      </header>
      <MenuBar current={page} onOpen={setPage} />
      {page === 'stats' && <StatsPage />}
      {page === 'stock' && <StockPage />}
      {page === 'suppliers' && <SuppliersPage />}
      {page === 'staff' && <StaffPage />}
      {page === 'settings' && <SettingsPage onOpenMenu={onOpenMenu} onOpenPrinters={onOpenPrinters} />}
    </div>
  )
}

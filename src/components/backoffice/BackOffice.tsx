import type { ReactNode } from 'react'
import { useI18n } from '../../lib/i18n'
import type { BackOfficePage } from './pages'
import StatsPage from './StatsPage'
import StockPage from './StockPage'
import SuppliersPage from './SuppliersPage'
import StaffPage from './StaffPage'
import SettingsPage from './SettingsPage'
import UsersPage from './UsersPage'
import BackupPage from './BackupPage'
import TicketPage from './TicketPage'

interface Props {
  page: BackOfficePage
  /** The administration menus (line 1), kept on top so pages can be switched without going back to the floor. */
  menu: ReactNode
  onBack(): void
  /** Opens the existing Menu and Imprimantes screens (shortcuts from Paramètres). */
  onOpenMenu(): void
  onOpenPrinters(): void
  /** Opens Modifier le Ticket (shortcut from Paramètres). */
  onOpenTicket(): void
}

/**
 * Back-office screen under the administration menus: Statistiques, Stock, Fournisseurs, Employés, Paramètres, and the
 * Fichier pages (Utilisateurs, Sauvegarde, Modifier le Ticket).
 */
export default function BackOffice({ page, menu, onBack, onOpenMenu, onOpenPrinters, onOpenTicket }: Props) {
  const { t } = useI18n()
  const title: Record<BackOfficePage, [string, string]> = {
    stats: [t.statistics, t.statsSub],
    stock: [t.stock, t.stockSub],
    suppliers: [t.suppliers, t.suppliersSub],
    staff: [t.staff, t.staffSub],
    settings: [t.settings, t.settingsSub],
    users: [t.usersTitle, t.usersSub],
    backup: [t.backupTitle, t.backupSub],
    ticket: [t.ticketTitle, t.ticketSub],
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
      {page === 'settings' && <SettingsPage onOpenMenu={onOpenMenu} onOpenPrinters={onOpenPrinters} onOpenTicket={onOpenTicket} />}
      {page === 'users' && <UsersPage />}
      {page === 'backup' && <BackupPage />}
      {page === 'ticket' && <TicketPage />}
    </div>
  )
}

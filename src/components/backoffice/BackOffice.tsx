import { useState, type ReactNode } from 'react'
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
import PermissionsPage from './PermissionsPage'
import { NewReservationPage, ReservationsList } from './ReservationsPage'
import MenuCsvPage from './MenuCsvPage'
import { NewZonePage, ZonesList } from './DeliveryZonesPage'
import PayrollPage from './PayrollPage'

interface Props {
  page: BackOfficePage
  /** The administration menus (line 1), kept on top so pages can be switched without going back to the floor. */
  menu: ReactNode
  onBack(): void
  /** Opens the existing Menu and Imprimantes screens (shortcuts from Paramètres). Left out without the permission. */
  onOpenMenu?(): void
  onOpenPrinters(): void
  /** Opens Modifier le Ticket (shortcut from Paramètres). Left out without the permission. */
  onOpenTicket?(): void
  /** Switches page (tabs Utilisateurs / Permissions, Nouvelle réservation / Liste). */
  onPage(page: BackOfficePage): void
  /** Réservation honorée: leaves the back-office for the order of the table where the customer sits. */
  onOpenOrder(hallId: string, tableId: string): void
}

/**
 * Back-office screen under the administration menus: Statistiques, Stock, Fournisseurs, Employés, Paramètres, and the
 * Fichier pages (Utilisateurs, Sauvegarde, Modifier le Ticket), Clients (réservations), Édition > Zones de livraison and Gestion des employés > Salaires et acomptes.
 */
export default function BackOffice({ page, menu, onBack, onOpenMenu, onOpenPrinters, onOpenTicket, onPage, onOpenOrder }: Props) {
  const { t } = useI18n()
  /** Booking just created from Nouvelle réservation, highlighted in the list. */
  const [created, setCreated] = useState<string | null>(null)
  /** Zone just added, highlighted in the list. */
  const [createdZone, setCreatedZone] = useState<string | null>(null)
  const title: Record<BackOfficePage, [string, string]> = {
    stats: [t.statistics, t.statsSub],
    stock: [t.stock, t.stockSub],
    suppliers: [t.suppliers, t.suppliersSub],
    staff: [t.staff, t.staffSub],
    settings: [t.settings, t.settingsSub],
    users: [t.usersTitle, t.usersSub],
    permissions: [t.permissionsTitle, t.permissionsSub],
    backup: [t.backupTitle, t.backupSub],
    ticket: [t.ticketTitle, t.ticketSub],
    reservations: [t.reservationsTitle, t.reservationsSub],
    reservationNew: [t.resNewItem, t.resNewSub],
    menuCsv: [t.csvTitle, t.csvSub],
    zones: [t.zonesEditItem, t.zonesSub],
    zoneNew: [t.zoneNewItem, t.zonesSub],
    payroll: [t.payrollTitle, t.payrollSub],
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
      {(page === 'users' || page === 'permissions') && (
        <div className="segmented bo-tabs" role="tablist" aria-label={t.usersTitle}>
          {(['users', 'permissions'] as const).map((p) => (
            <button key={p} type="button" role="tab" aria-selected={page === p} className={page === p ? 'on' : ''} onClick={() => onPage(p)}>
              {p === 'users' ? t.fileUsers : t.filePermissions}
            </button>
          ))}
        </div>
      )}
      {(page === 'reservations' || page === 'reservationNew') && (
        <div className="segmented bo-tabs" role="tablist" aria-label={t.reservationsTitle}>
          {(['reservationNew', 'reservations'] as const).map((p) => (
            <button key={p} type="button" role="tab" aria-selected={page === p} className={page === p ? 'on' : ''} onClick={() => onPage(p)}>
              {p === 'reservationNew' ? t.resNewItem : t.resListItem}
            </button>
          ))}
        </div>
      )}
      {(page === 'zones' || page === 'zoneNew') && (
        <div className="segmented bo-tabs" role="tablist" aria-label={t.zonesTitle}>
          {(['zoneNew', 'zones'] as const).map((p) => (
            <button key={p} type="button" role="tab" aria-selected={page === p} className={page === p ? 'on' : ''} onClick={() => onPage(p)}>
              {p === 'zoneNew' ? t.zoneNewItem : t.zonesEditItem}
            </button>
          ))}
        </div>
      )}
      {page === 'stats' && <StatsPage />}
      {page === 'stock' && <StockPage />}
      {page === 'suppliers' && <SuppliersPage />}
      {page === 'staff' && <StaffPage />}
      {page === 'payroll' && <PayrollPage />}
      {page === 'settings' && <SettingsPage onOpenMenu={onOpenMenu} onOpenPrinters={onOpenPrinters} onOpenTicket={onOpenTicket} />}
      {page === 'users' && <UsersPage />}
      {page === 'permissions' && <PermissionsPage />}
      {page === 'backup' && <BackupPage />}
      {page === 'ticket' && <TicketPage />}
      {page === 'reservationNew' && <NewReservationPage onSaved={(r) => { setCreated(r.id); onPage('reservations') }} />}
      {page === 'reservations' && <ReservationsList onOpenOrder={onOpenOrder} highlight={created} />}
      {page === 'menuCsv' && <MenuCsvPage />}
      {page === 'zoneNew' && <NewZonePage onSaved={(z) => { setCreatedZone(z.id); onPage('zones') }} />}
      {page === 'zones' && <ZonesList highlight={createdZone} />}
    </div>
  )
}

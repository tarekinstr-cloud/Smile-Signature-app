import { useEffect, useState, type ReactNode } from 'react'
import { useI18n } from '../../lib/i18n'
import { usePermissions } from '../../lib/permissions'
import type { BackOfficePage } from './pages'
import StatsPage from './StatsPage'
import StockPage from './StockPage'
import SuppliersPage from './SuppliersPage'
import StaffPage from './StaffPage'
import SettingsPage from './SettingsPage'
import UsersPage from './UsersPage'
import BackupPage from './BackupPage'
import ConfigurationsPage from './ConfigurationsPage'
import PermissionsPage from './PermissionsPage'
import { NewReservationPage, ReservationsList } from './ReservationsPage'
import MenuCsvPage from './MenuCsvPage'
import { NewZonePage, ZonesList } from './DeliveryZonesPage'
import PayrollPage from './PayrollPage'
import DevicesPage from './DevicesPage'
import { InvoicesList, NewPurchasePage } from './PurchasesPage'
import { KitchenChargesPage, StockTransferPage } from './StockMovesPage'
import StockStatePage from './StockStatePage'
import RecipesPage from './RecipesPage'
import { CashFloatPage, CashMovesPage, ResetNumbersPage } from './CashPage'
import WeeklyPage from './WeeklyPage'
import ExpensesPage from './ExpensesPage'
import ProfitPage from './ProfitPage'
import { CancelledInvoicesPage, CancelledOrdersPage, PriceLogPage } from './ControlPages'
import type { SupplierInvoice } from '../../lib/types'
import { WallpaperPage } from './FloorSettingsPages'
import HallsPage from './HallsPage'
import ItemPrintersPage from './ItemPrintersPage'
import ItemPhotosPage from './ItemPhotosPage'
import DashboardPage, { type DashboardLink } from './DashboardPage'
import type { Period } from './PeriodFilter'
import { AllInvoicesPage, CustomersList, DebtsPage, NewCustomerPage, SettlePage } from './CustomersPages'

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
  /** Gestion des salles → Modifier le plan de salle of that hall. Left out without the Édition permission. */
  onOpenPlan?(hallId: string): void
}

/**
 * Back-office screen under the administration menus: Statistiques, Stock, Fournisseurs, Employés, Paramètres, and the
 * Fichier pages (Utilisateurs, Sauvegarde, Modifier le Ticket), Clients (réservations), Édition > Zones de livraison and Gestion des employés (Salaires et acomptes, Appareils connectés), Gestion du Stock (Effectuer un achat, Factures fournisseurs, Transfert dépôt / cuisine, Charges cuisine, État du stock), Édition > Fiches techniques, Statistiques (caisse, journalier, hebdomadaire, dépenses, bénéfice).
 */
export default function BackOffice({ page, menu, onBack, onOpenMenu, onOpenPrinters, onOpenTicket, onPage, onOpenOrder, onOpenPlan }: Props) {
  const { t } = useI18n()
  const canStats = usePermissions().can('stats')
  /** Booking just created from Nouvelle réservation, highlighted in the list. */
  const [created, setCreated] = useState<string | null>(null)
  /** Zone just added, highlighted in the list. */
  const [createdZone, setCreatedZone] = useState<string | null>(null)
  /** Purchase just validated in Effectuer un achat, announced and highlighted in Factures fournisseurs. */
  const [createdInvoice, setCreatedInvoice] = useState<SupplierInvoice | null>(null)
  /** Customer just created, or opened from Factures non réglées: its card is shown in Modifier Clients. */
  const [customerFocus, setCustomerFocus] = useState<string | null>(null)
  /** Régler une Facture Client opened for this customer (from the card or the debts list). */
  const [settleFor, setSettleFor] = useState<string | null>(null)
  /** Period handed from the Tableau de bord to the screen it opens (Dépenses, État Z, Rapport X, Commandes annulées). */
  const [hint, setHint] = useState<{ period: Period; statsTab: 'current' | 'closed' } | null>(null)
  useEffect(() => {
    if (page === 'dashboard') setHint(null)
  }, [page])
  const openFromDashboard = (link: DashboardLink, period: Period) => {
    setHint({ period, statsTab: link === 'zReport' ? 'closed' : 'current' })
    onPage(link === 'expenses' ? 'expenses' : link === 'cancelledOrders' ? 'cancelledOrders' : 'stats')
  }
  const settle = (id: string) => {
    setSettleFor(id)
    onPage('customerSettle')
  }
  useEffect(() => {
    if (page !== 'purchases') setCreatedInvoice(null)
  }, [page])
  const title: Record<BackOfficePage, [string, string]> = {
    stats: [t.dailyStatsTitle, t.dailyStatsSub],
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
    devices: [t.devicesTitle, t.devicesSub],
    purchaseNew: [t.purNewItem, t.purNewSub],
    purchases: [t.purInvoicesItem, t.purInvoicesSub],
    stockTransfer: [t.transferItem, t.transferSub],
    kitchenCharges: [t.chargesItem, t.chargesSub],
    stockState: [t.stateItem, t.stateSub],
    recipes: [t.recipesTitle, t.recipesSub],
    resetNumbers: [t.resetTitle, t.resetSub],
    cashFloat: [t.floatTitle, t.floatSub],
    cashIn: [t.cashInTitle, t.cashInSub],
    cashOut: [t.cashOutTitle, t.cashOutSub],
    weekly: [t.weeklyTitle, t.weeklySub],
    expenses: [t.expensesTitle, t.expensesSub],
    profit: [t.profitTitle, t.profitSub],
    cancelledOrders: [t.cancelledOrdersTitle, t.cancelledOrdersSub],
    cancelledInvoices: [t.cancelledInvoicesTitle, t.cancelledInvoicesSub],
    priceLog: [t.priceLogTitle, t.priceLogSub],
    wallpaper: [t.bgTitle, t.bgSub],
    config: [t.cfgTitle, t.cfgSub],
    halls: [t.hallsManage, t.hallsSub],
    itemPrinters: [t.itemPrintersTitle, t.itemPrintersSub],
    itemPhotos: [t.itemPhotosTitle, t.itemPhotosSub],
    customerNew: [t.customerNewTitle, t.customersSub],
    customers: [t.customersEditItem, t.customersSub],
    customerSettle: [t.settleTitle, t.settleSub],
    customerDebts: [t.debtsTitle, t.debtsSub],
    invoices: [t.allInvoicesTitle, t.allInvoicesSub],
    dashboard: [t.dashTitle, t.dashSub],
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
      {(page === 'customerNew' || page === 'customers') && (
        <div className="segmented bo-tabs" role="tablist" aria-label={t.customersTitle}>
          {(['customerNew', 'customers'] as const).map((p) => (
            <button key={p} type="button" role="tab" aria-selected={page === p} className={page === p ? 'on' : ''} onClick={() => onPage(p)}>
              {p === 'customerNew' ? t.customerNewTitle : t.customersEditItem}
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
      {(page === 'purchaseNew' || page === 'purchases') && (
        <div className="segmented bo-tabs" role="tablist" aria-label={t.stock}>
          {(['purchaseNew', 'purchases'] as const).map((p) => (
            <button key={p} type="button" role="tab" aria-selected={page === p} className={page === p ? 'on' : ''} onClick={() => onPage(p)}>
              {p === 'purchaseNew' ? t.purNewItem : t.purInvoicesItem}
            </button>
          ))}
        </div>
      )}
      {page === 'dashboard' && <DashboardPage onOpen={openFromDashboard} />}
      {page === 'stats' && <StatsPage key={hint ? `${hint.statsTab}-${hint.period.from}` : 'stats'} initialTab={hint?.statsTab} initialPeriod={hint?.period} />}
      {page === 'stock' && <StockPage />}
      {page === 'suppliers' && <SuppliersPage />}
      {page === 'staff' && <StaffPage />}
      {page === 'payroll' && <PayrollPage />}
      {page === 'devices' && <DevicesPage />}
      {page === 'settings' && <SettingsPage onOpenMenu={onOpenMenu} onOpenPrinters={onOpenPrinters} onOpenTicket={onOpenTicket} />}
      {page === 'users' && <UsersPage />}
      {page === 'permissions' && <PermissionsPage />}
      {page === 'backup' && <BackupPage />}
      {page === 'ticket' && <ConfigurationsPage initialTab="ticket" />}
      {page === 'reservationNew' && <NewReservationPage onSaved={(r) => { setCreated(r.id); onPage('reservations') }} />}
      {page === 'reservations' && <ReservationsList onOpenOrder={onOpenOrder} highlight={created} />}
      {page === 'menuCsv' && <MenuCsvPage />}
      {page === 'zoneNew' && <NewZonePage onSaved={(z) => { setCreatedZone(z.id); onPage('zones') }} />}
      {page === 'zones' && <ZonesList highlight={createdZone} />}
      {page === 'purchaseNew' && <NewPurchasePage onSaved={(i) => { setCreatedInvoice(i); onPage('purchases') }} />}
      {page === 'purchases' && <InvoicesList key={createdInvoice?.id} highlight={createdInvoice} />}
      {page === 'stockTransfer' && <StockTransferPage />}
      {page === 'kitchenCharges' && <KitchenChargesPage />}
      {page === 'stockState' && <StockStatePage />}
      {page === 'recipes' && <RecipesPage />}
      {page === 'resetNumbers' && <ResetNumbersPage />}
      {page === 'cashFloat' && <CashFloatPage onOpenStats={canStats ? () => onPage('stats') : undefined} />}
      {page === 'cashIn' && <CashMovesPage key="in" kind="in" onOpenFloat={() => onPage('cashFloat')} />}
      {page === 'cashOut' && <CashMovesPage key="out" kind="out" onOpenFloat={() => onPage('cashFloat')} />}
      {page === 'weekly' && <WeeklyPage />}
      {page === 'expenses' && <ExpensesPage key={hint?.period.from ?? 'expenses'} initialPeriod={hint?.period} />}
      {page === 'profit' && <ProfitPage />}
      {page === 'cancelledOrders' && <CancelledOrdersPage key={hint?.period.from ?? 'cancelled'} initialPeriod={hint?.period} />}
      {page === 'cancelledInvoices' && <CancelledInvoicesPage />}
      {page === 'priceLog' && <PriceLogPage />}
      {page === 'wallpaper' && <WallpaperPage />}
      {page === 'config' && <ConfigurationsPage />}
      {page === 'halls' && <HallsPage onOpenPlan={onOpenPlan} />}
      {page === 'itemPrinters' && <ItemPrintersPage />}
      {page === 'itemPhotos' && <ItemPhotosPage />}
      {page === 'customerNew' && <NewCustomerPage onSaved={(c) => { setCustomerFocus(c.id); onPage('customers') }} />}
      {page === 'customers' && <CustomersList highlight={customerFocus} onSettle={settle} />}
      {page === 'customerSettle' && <SettlePage initialCustomer={settleFor} />}
      {page === 'customerDebts' && <DebtsPage onOpenCustomer={(id) => { setCustomerFocus(id); onPage('customers') }} onSettle={settle} />}
      {page === 'invoices' && <AllInvoicesPage />}
    </div>
  )
}

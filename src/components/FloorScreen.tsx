import { useCallback, useEffect, useMemo, useState } from 'react'
import { defaultFloorConfig, repo, type OpenOrder } from '../lib/repo'
import type { DeliveryStatus, DiningTable, FloorConfig, Hall, Order, PickupStatus, TableOrderInfo, TablePatch } from '../lib/types'
import FloorPlan from './FloorPlan'
import TablePanel from './TablePanel'
import HallPanel from './HallPanel'
import OrderScreen from './OrderScreen'
import MenuAdmin from './MenuAdmin'
import PrinterSettings from './PrinterSettings'
import { useDialog } from './Dialog'
import { money } from '../lib/format'
import { computeBill } from '../lib/billing'
import LangToggle from './LangToggle'
import { useI18n } from '../lib/i18n'
import DeliveryDialog from './DeliveryDialog'
import AreaFloor from './AreaFloor'
import TakeawayStartDialog from './TakeawayStartDialog'
import BackOffice from './backoffice/BackOffice'
import AdminMenu, { type AdminMenuGroup, type AdminMenuItem } from './nav/AdminMenu'
import ServiceTabs from './nav/ServiceTabs'
import type { BackOfficePage } from './backoffice/pages'
import type { SessionUser } from '../lib/auth'
import { usePermissions, type Permission } from '../lib/permissions'
import { bookingsByTable, floorWindow, reservations as reservationsService } from '../lib/reservations'
import type { Reservation } from '../lib/types'
import { timeText } from './backoffice/ReservationsPage'

type Mode = 'service' | 'edit'
/** Orders without a table, each with its button and list in the top bar. */
type NoTable = 'takeaway' | 'delivery'

export default function FloorScreen({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  const [halls, setHalls] = useState<Hall[]>([])
  const [hallId, setHallId] = useState<string | null>(null)
  const [tables, setTables] = useState<DiningTable[]>([])
  const [modeState, setMode] = useState<Mode>('service')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [orderTableId, setOrderTableId] = useState<string | null>(null)
  const [checkoutFirst, setCheckoutFirst] = useState(false)
  /**
   * Takeaway or delivery order on screen: an open one (its id), or a new takeaway (null id, with a key so each is
   * a fresh screen). A delivery is created with its customer before the screen opens, so it always has an id.
   */
  const [takeaway, setTakeaway] = useState<{ orderId: string | null; key: number } | null>(null)
  /** Nouvelle commande à emporter: the number of people, before the order screen. */
  const [startingTakeaway, setStartingTakeaway] = useState(false)
  const [takeaways, setTakeaways] = useState<OpenOrder[]>([])
  const [deliveries, setDeliveries] = useState<OpenOrder[]>([])
  const [openList, setOpenList] = useState<NoTable | null>(null)
  /** Nouvelle livraison: the customer form, before the order screen. */
  const [newDelivery, setNewDelivery] = useState(false)
  /** Occupied table tapped in service mode: choose between its order and checkout. */
  const [actions, setActions] = useState<{ table: DiningTable; total: number; count: number } | null>(null)
  const [menuAdmin, setMenuAdmin] = useState(false)
  const [printerSettings, setPrinterSettings] = useState(false)
  const [backOffice, setBackOffice] = useState<BackOfficePage | null>(null)
  /** Small dialogs from the navigation: the account (Connexion tab) and Aide → À propos. */
  const [info, setInfo] = useState<'account' | 'about' | null>(null)
  /** Confirmed bookings of the next hours, shown as a small mark on their table. */
  const [upcoming, setUpcoming] = useState<Reservation[]>([])
  /** Bookings could not be read (e.g. migration not run): said on the floor plan instead of silently showing none. */
  const [resError, setResError] = useState<string | null>(null)
  /** Mark tapped on the floor plan: the booking's details. */
  const [resInfo, setResInfo] = useState<{ reservation: Reservation; table: DiningTable } | null>(null)
  const [restaurant, setRestaurant] = useState('Smile Signature')
  /** Open order of each occupied table of the hall shown: waiter, guests, timer. */
  const [tableOrders, setTableOrders] = useState<Map<string, TableOrderInfo>>(new Map())
  const [floorConfig, setFloorConfig] = useState<FloorConfig>(defaultFloorConfig)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const dialog = useDialog()
  const { t, lang, setLang } = useI18n()
  const { can } = usePermissions()
  /** Utilisateurs and Permissions stay with the Admin role, so no one can give themselves more rights. */
  const isAdmin = user.role === 'admin'
  /** Editing the floor plan needs the Édition permission. */
  const mode: Mode = can('edit') ? modeState : 'service'

  const hall = halls.find((h) => h.id === hallId) ?? null
  const selected = tables.find((t) => t.id === selectedId) ?? null

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      setError(null)
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const reload = useCallback(async () => {
    await run(async () => {
      const hs = await repo.listHalls()
      setHalls(hs)
      const current = hs.find((h) => h.id === hallId) ?? hs[0] ?? null
      if (current?.id !== hallId) setHallId(current?.id ?? null)
      setTables(current ? await repo.listTables(current.id) : [])
    })
    setLoading(false)
  }, [hallId, run])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => repo.subscribe(() => reload()), [reload])

  useEffect(() => {
    repo.getReceiptSettings().then((r) => r.name && setRestaurant(r.name), () => {})
  }, [backOffice])

  // The window moves with the clock, so bookings are read again every minute as well as on every change.
  const reloadUpcoming = useCallback(() => {
    const [from, to] = floorWindow()
    reservationsService.listBetween(from, to).then(
      (list) => {
        setUpcoming(list)
        setResError(null)
      },
      (e) => {
        setUpcoming([])
        setResError(e instanceof Error ? e.message : String(e))
      },
    )
  }, [])
  useEffect(() => {
    reloadUpcoming()
    const timer = window.setInterval(reloadUpcoming, 60_000)
    const unsubscribe = reservationsService.subscribe(reloadUpcoming)
    return () => {
      window.clearInterval(timer)
      unsubscribe()
    }
  }, [reloadUpcoming, backOffice, hallId])
  // Recomputed with the list, which is read again every minute, so a booking whose time passes moves on to the next.
  const reservedTables = useMemo(() => bookingsByTable(upcoming), [upcoming])

  // Waiter, guests and timer of each table: read again on every change of orders (shared realtime channel) or tables.
  const reloadTableOrders = useCallback(() => {
    if (!hallId) return setTableOrders(new Map())
    repo.listTableOrders(hallId).then((list) => setTableOrders(new Map(list.map((o) => [o.table_id, o]))), () => setTableOrders(new Map()))
  }, [hallId])
  useEffect(() => {
    reloadTableOrders()
    const offs = [repo.subscribeOrders(reloadTableOrders), repo.subscribe(reloadTableOrders)]
    return () => offs.forEach((off) => off())
  }, [reloadTableOrders, orderTableId, takeaway])
  useEffect(() => {
    const read = () => repo.getFloorConfig().then(setFloorConfig, () => {})
    read()
    return repo.subscribeConfig(read)
  }, [backOffice])

  const reloadTakeaways = useCallback(() => {
    // Open ones, and the paid ones not handed to the customer yet: both stay on the board.
    Promise.all([repo.listOpenOrders('takeaway'), repo.listPickupWaiting()]).then(([open, waiting]) => setTakeaways([...open, ...waiting]), () => setTakeaways([]))
    // Open ones, and the paid ones not delivered yet: both stay in the view (their numbers are in use).
    Promise.all([repo.listOpenOrders('delivery'), repo.listDeliveryWaiting()]).then(([open, waiting]) => setDeliveries([...open, ...waiting]), () => setDeliveries([]))
  }, [])
  useEffect(() => {
    reloadTakeaways()
    return repo.subscribeOrders(reloadTakeaways)
  }, [reloadTakeaways])

  function openTakeaway(orderId: string | null) {
    setNewDelivery(false)
    setStartingTakeaway(false)
    setOrderTableId(null)
    setTakeaway({ orderId, key: Date.now() })
  }

  /** À emporter already paid, tapped in the view: Prête / Remise (it leaves the view once handed). */
  const [pickupFor, setPickupFor] = useState<Order | null>(null)
  function setPickup(order: Order, status: PickupStatus | DeliveryStatus) {
    setPickupFor(null)
    run(async () => {
      if (order.order_type === 'delivery') await repo.updateDelivery(order.id, { status: status as DeliveryStatus })
      else await repo.setPickupStatus(order.id, status as PickupStatus)
      reloadTakeaways()
    })
  }
  /** Numbers of the orders in progress in each mode: greyed out when a new one is created. */
  const takeawayUsed = useMemo(() => new Set(takeaways.map((o) => o.order.takeaway_no).filter((n): n is number => n != null)), [takeaways])
  const deliveryUsed = useMemo(() => new Set(deliveries.map((o) => o.order.delivery_no).filter((n): n is number => n != null)), [deliveries])

  /** Nouvelle commande à emporter: asks the customer's number first. */
  function askTakeaway() {
    setTakeaway(null)
    setOrderTableId(null)
    setStartingTakeaway(true)
  }

  function startDelivery() {
    setTakeaway(null)
    setOrderTableId(null)
    setNewDelivery(true)
  }

  useEffect(() => {
    if (mode === 'service') setSelectedId(null)
  }, [mode])

  const counts = useMemo(() => {
    const occupied = tables.filter((t) => t.status === 'occupied').length
    return { free: tables.length - occupied, occupied }
  }, [tables])

  function patchLocal(id: string, patch: TablePatch) {
    setTables((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  async function updateTable(id: string, patch: TablePatch) {
    const before = tables
    patchLocal(id, patch)
    try {
      setError(null)
      await repo.updateTable(id, patch)
    } catch (e) {
      setTables(before)
      setError(e instanceof Error ? e.message : String(e))
    }
  }


  async function tapTable(table: DiningTable) {
    if (table.status !== 'occupied') return openOrder(table.id, false)
    await run(async () => {
      const current = await repo.getOpenOrder(table.id)
      const lines = current?.lines ?? []
      if (!lines.length) return openOrder(table.id, false)
      setActions({
        table,
        total: computeBill(current?.order ?? null, lines, current?.payments ?? []).remaining,
        count: lines.reduce((s, l) => s + l.quantity, 0),
      })
    })
  }

  function openOrder(id: string, checkout: boolean) {
    setActions(null)
    setCheckoutFirst(checkout)
    setOrderTableId(id)
  }

  async function addHall() {
    if (!can('edit')) return
    const name = await dialog.askText(t.newHallName)
    if (!name) return
    await run(async () => {
      const h = await repo.createHall(name)
      setHallId(h.id)
      setMode('edit')
    })
  }

  async function addTable() {
    if (!hall) return
    const used = new Set(tables.map((t) => t.label))
    let n = tables.length + 1
    while (used.has(String(n))) n++
    // Cascade new tables so they don't land exactly on top of each other.
    const offset = (tables.length % 8) * 20
    await run(async () => {
      const created = await repo.createTable({
        hall_id: hall.id, label: String(n), seats: 4, shape: 'square',
        x: 20 + offset, y: 20 + offset, width: 90, height: 90, status: 'free',
      })
      setTables((ts) => (ts.some((x) => x.id === created.id) ? ts : [...ts, created]))
      setSelectedId(created.id)
    })
  }

  async function deleteTable(table: DiningTable) {
    if (!(await dialog.confirm(t.confirmDeleteTable(table.label)))) return
    await run(async () => {
      await repo.deleteTable(table.id)
      setSelectedId(null)
      setTables((ts) => ts.filter((x) => x.id !== table.id))
    })
  }

  async function deleteHall(h: Hall) {
    if (!(await dialog.confirm(t.confirmDeleteHall(h.name)))) return
    await run(async () => {
      await repo.deleteHall(h.id)
      setHallId(null)
    })
  }

  /** Leaves the back-office and any open screen, back to the floor plan. */
  const toFloor = () => {
    setBackOffice(null)
    setMenuAdmin(false)
    setPrinterSettings(false)
  }
  const onBo = (page: BackOfficePage) => backOffice === page
  const openBo = (page: BackOfficePage) => {
    toFloor()
    setBackOffice(page)
  }
  const signOutItem: AdminMenuItem = {
    id: 'signout', label: t.signOutAs(user.display_name || user.username, t.roles[user.role]), separator: true, onSelect: onSignOut,
  }
  /** Permission each back-office page needs (Utilisateurs and Permissions: the Admin role). */
  const pageAllowed = (page: BackOfficePage) =>
    page === 'users' || page === 'permissions' ? isAdmin
      : page === 'reservations' || page === 'reservationNew' ? can('reservations')
      : page === 'menuCsv' ? can('edit')
      : page === 'zones' || page === 'zoneNew' ? can('delivery_zones')
      : page === 'purchases' || page === 'purchaseNew' ? can('purchases')
      : page === 'stockTransfer' ? can('stock_transfer')
      : page === 'kitchenCharges' ? can('kitchen_charges')
      : page === 'stockState' ? can('stock_state')
      : page === 'recipes' ? can('recipes')
      : page === 'resetNumbers' ? can('reset_numbers')
      : page === 'cashFloat' ? can('cash_open')
      : page === 'cashIn' ? can('cash_in')
      : page === 'cashOut' ? can('cash_out')
      : page === 'weekly' ? can('weekly_stats')
      : page === 'cancelledOrders' ? can('cancelled_orders')
      : page === 'cancelledInvoices' ? can('cancelled_invoices')
      : page === 'priceLog' ? can('price_log')
      : page === 'wallpaper' || page === 'config' ? can('settings')
      : can(page as Permission)
  const shown = (items: (AdminMenuItem | false)[]) => items.filter((i): i is AdminMenuItem => !!i)
  // Menus and entries the account has no permission for are left out, not just greyed.
  const editItems = shown([
    can('edit') && { id: 'plan', label: t.editPlanItem, checked: !backOffice && mode === 'edit', onSelect: () => { toFloor(); setMode('edit') } },
    can('edit') && { id: 'hall', label: t.addHall, onSelect: () => { toFloor(); addHall() } },
    can('edit') && { id: 'menu', label: t.menuTitle, onSelect: () => { toFloor(); setMenuAdmin(true) } },
    can('edit') && { id: 'menu-csv', label: t.csvTitle, checked: onBo('menuCsv'), onSelect: () => openBo('menuCsv') },
    can('recipes') && { id: 'recipes', label: t.recipesTitle, checked: onBo('recipes'), onSelect: () => openBo('recipes') },
    can('delivery_zones') && {
      id: 'zone-new', label: t.zoneNewItem, separator: can('edit') || can('recipes'), checked: onBo('zoneNew'), onSelect: () => openBo('zoneNew'),
    },
    can('delivery_zones') && { id: 'zones', label: t.zonesEditItem, checked: onBo('zones'), onSelect: () => openBo('zones') },
  ])
  const stockItems = shown([
    can('stock') && { id: 'stock', label: t.stockSub, checked: onBo('stock'), onSelect: () => setBackOffice('stock') },
    can('suppliers') && { id: 'suppliers', label: t.suppliers, checked: onBo('suppliers'), onSelect: () => setBackOffice('suppliers') },
    can('purchases') && {
      id: 'purchase-new', label: t.purNewItem, separator: can('stock') || can('suppliers'), checked: onBo('purchaseNew'), onSelect: () => openBo('purchaseNew'),
    },
    can('purchases') && { id: 'purchases', label: t.purInvoicesItem, checked: onBo('purchases'), onSelect: () => openBo('purchases') },
    can('stock_transfer') && {
      id: 'stock-transfer', label: t.transferItem, separator: can('stock') || can('suppliers') || can('purchases'),
      checked: onBo('stockTransfer'), onSelect: () => openBo('stockTransfer'),
    },
    can('kitchen_charges') && {
      id: 'kitchen-charges', label: t.chargesItem, separator: !can('stock_transfer') && (can('stock') || can('suppliers') || can('purchases')),
      checked: onBo('kitchenCharges'), onSelect: () => openBo('kitchenCharges'),
    },
    can('stock_state') && {
      id: 'stock-state', label: t.stateItem,
      separator: !can('stock_transfer') && !can('kitchen_charges') && (can('stock') || can('suppliers') || can('purchases')),
      checked: onBo('stockState'), onSelect: () => openBo('stockState'),
    },
  ])
  const staffItems = shown([
    can('staff') && { id: 'staff-list', label: t.staffListItem, checked: onBo('staff'), onSelect: () => openBo('staff') },
    can('payroll') && { id: 'payroll', label: t.payrollTitle, checked: onBo('payroll'), onSelect: () => openBo('payroll') },
    can('devices') && { id: 'devices', label: t.devicesTitle, checked: onBo('devices'), onSelect: () => openBo('devices') },
  ])
  // Statistiques / bénéfice, in four groups with a line between them: numbering, caisse, rapports, contrôle.
  const statsPages: BackOfficePage[] = ['resetNumbers', 'cashFloat', 'cashIn', 'cashOut', 'stats', 'weekly', 'expenses', 'profit', 'cancelledOrders', 'cancelledInvoices', 'priceLog']
  const statsGroups: AdminMenuItem[][] = [
    shown([can('reset_numbers') && { id: 'reset-numbers', label: t.resetTitle, checked: onBo('resetNumbers'), onSelect: () => openBo('resetNumbers') }]),
    shown([
      can('cash_open') && { id: 'cash-float', label: t.floatTitle, checked: onBo('cashFloat'), onSelect: () => openBo('cashFloat') },
      can('cash_in') && { id: 'cash-in', label: t.cashInTitle, checked: onBo('cashIn'), onSelect: () => openBo('cashIn') },
      can('cash_out') && { id: 'cash-out', label: t.cashOutTitle, checked: onBo('cashOut'), onSelect: () => openBo('cashOut') },
    ]),
    shown([
      can('stats') && { id: 'daily', label: t.dailyStatsTitle, checked: onBo('stats'), onSelect: () => openBo('stats') },
      can('weekly_stats') && { id: 'weekly', label: t.weeklyTitle, checked: onBo('weekly'), onSelect: () => openBo('weekly') },
      can('expenses') && { id: 'expenses', label: t.expensesTitle, checked: onBo('expenses'), onSelect: () => openBo('expenses') },
      can('profit') && { id: 'profit', label: t.profitTitle, checked: onBo('profit'), onSelect: () => openBo('profit') },
    ]),
    shown([
      can('cancelled_orders') && { id: 'cancelled-orders', label: t.cancelledOrdersTitle, checked: onBo('cancelledOrders'), onSelect: () => openBo('cancelledOrders') },
      can('cancelled_invoices') && { id: 'cancelled-invoices', label: t.cancelledInvoicesTitle, checked: onBo('cancelledInvoices'), onSelect: () => openBo('cancelledInvoices') },
      can('price_log') && { id: 'price-log', label: t.priceLogTitle, checked: onBo('priceLog'), onSelect: () => openBo('priceLog') },
    ]),
  ]
  const statsItems = statsGroups.filter((g) => g.length).flatMap((g, i) => g.map((it, j) => (i > 0 && j === 0 ? { ...it, separator: true } : it)))
  const adminGroups: AdminMenuGroup[] = [
    {
      id: 'file', label: t.navFile, current: onBo('users') || onBo('permissions') || onBo('backup') || onBo('ticket'), items: shown([
        isAdmin && { id: 'users', label: t.fileUsers, checked: onBo('users'), onSelect: () => openBo('users') },
        isAdmin && { id: 'permissions', label: t.filePermissions, checked: onBo('permissions'), onSelect: () => openBo('permissions') },
        can('backup') && { id: 'backup', label: t.fileBackup, checked: onBo('backup'), onSelect: () => openBo('backup') },
        can('ticket') && { id: 'ticket', label: t.fileTicket, checked: onBo('ticket'), onSelect: () => openBo('ticket') },
        {
          id: 'service', label: t.serviceMode, separator: isAdmin || can('backup') || can('ticket'),
          checked: !backOffice && mode === 'service', onSelect: () => { toFloor(); setMode('service') },
        },
        { id: 'lang', label: t.languageItem(t.switchTo), onSelect: () => setLang(lang === 'fr' ? 'ar' : 'fr') },
        signOutItem,
      ]),
    },
    ...(can('reservations') ? [{
      id: 'clients', label: t.navClients, current: onBo('reservations') || onBo('reservationNew'), items: [
        { id: 'res-new', label: t.resNewItem, checked: onBo('reservationNew'), onSelect: () => openBo('reservationNew') },
        { id: 'res-list', label: t.resListItem, checked: onBo('reservations'), onSelect: () => openBo('reservations') },
      ],
    }] : []),
    ...(editItems.length ? [{ id: 'edit', label: t.navEdit, current: onBo('zones') || onBo('zoneNew') || onBo('menuCsv') || onBo('recipes'), items: editItems }] : []),
    ...(staffItems.length ? [{ id: 'staff', label: t.staff, current: onBo('staff') || onBo('payroll') || onBo('devices'), items: staffItems }] : []),
    ...(stockItems.length ? [{ id: 'stock', label: t.stock, current: onBo('stock') || onBo('suppliers') || onBo('purchaseNew') || onBo('purchases') || onBo('stockTransfer') || onBo('kitchenCharges') || onBo('stockState'), items: stockItems }] : []),
    ...(statsItems.length ? [{
      id: 'stats', label: t.navStats, current: statsPages.some(onBo), items: statsItems,
    }] : []),
    ...(can('settings') ? [{
      id: 'settings', label: t.settings, current: onBo('settings') || onBo('wallpaper') || onBo('config'), items: [
        // Order of i-Restaurant: Configurations, imprimantes, fond d'écran (the next ones come with later updates).
        { id: 'config', label: t.cfgTitle, checked: onBo('config'), onSelect: () => openBo('config') },
        { id: 'printers', label: t.printersManage, onSelect: () => { toFloor(); setPrinterSettings(true) } },
        { id: 'wallpaper', label: t.bgTitle, checked: onBo('wallpaper'), onSelect: () => openBo('wallpaper') },
      ],
    }] : []),
    { id: 'help', label: t.navHelp, items: [{ id: 'about', label: t.about, onSelect: () => setInfo('about') }] },
  ]
  const adminMenu = <AdminMenu groups={adminGroups} end={<LangToggle />} />
  const infoDialog = info && (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setInfo(null)}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="info-title" onKeyDown={(e) => e.key === 'Escape' && setInfo(null)}>
        <div className="panel-head">
          <h2 id="info-title">{info === 'account' ? t.account : t.about}</h2>
          <button className="ghost" onClick={() => setInfo(null)} aria-label={t.close}>✕</button>
        </div>
        {info === 'about' && <p className="small">{t.aboutText}</p>}
        <p className="muted small">
          {info === 'account' ? t.signedInAs(user.display_name ? `${user.display_name} (${user.username})` : user.username) : repo.mode === 'local' ? t.aboutDemo : t.aboutOnline}
        </p>
        {info === 'account' && <p className="small"><span className="tag">{t.roles[user.role]}</span></p>}
        {info === 'account' && <button className="danger" onClick={onSignOut}>{t.signOut}</button>}
      </div>
    </div>
  )

  if (menuAdmin && can('edit')) return <MenuAdmin onBack={() => setMenuAdmin(false)} />
  if (printerSettings && can('settings')) return <PrinterSettings onBack={() => setPrinterSettings(false)} />
  if (backOffice && pageAllowed(backOffice)) {
    return (
      <>
        <BackOffice page={backOffice} menu={adminMenu} onBack={() => setBackOffice(null)}
          onOpenPrinters={() => { setBackOffice(null); setPrinterSettings(true) }}
          onOpenTicket={can('ticket') ? () => setBackOffice('ticket') : undefined}
          onOpenMenu={can('edit') ? () => { setBackOffice(null); setMenuAdmin(true) } : undefined}
          onPage={(page) => setBackOffice(page)}
          onOpenOrder={(id, tableId) => {
            setBackOffice(null)
            setHallId(id)
            openOrder(tableId, false)
          }} />
        {infoDialog}
      </>
    )
  }

  const leaveOrder = () => {
    setOrderTableId(null)
    setTakeaway(null)
    reload()
    reloadTakeaways()
  }
  if (takeaway) {
    return (
      <OrderScreen key={`takeaway-${takeaway.orderId ?? takeaway.key}`} table={null} hall={null} orderId={takeaway.orderId ?? undefined}
        onBack={leaveOrder} onNewTakeaway={askTakeaway} onNewDelivery={startDelivery} />
    )
  }
  const orderTable = tables.find((t) => t.id === orderTableId)
  if (orderTable && hall) {
    return (
      <OrderScreen key={orderTable.id} table={orderTable} hall={hall} startCheckout={checkoutFirst}
        onBack={leaveOrder} onNewTakeaway={askTakeaway} onNewDelivery={startDelivery} />
    )
  }

  return (
    <div className={`app mode-${mode}`}>
      {adminMenu}
      <ServiceTabs restaurant={restaurant} halls={halls} hallId={hallId} takeaways={takeaways.length} deliveries={deliveries.length}
        area={openList} onAccount={() => setInfo('account')} onHall={(id) => { setOpenList(null); setHallId(id); setSelectedId(null) }} onAddHall={can('edit') ? addHall : undefined}
        onTakeaway={() => setOpenList('takeaway')} onDelivery={() => setOpenList('delivery')} />

      {repo.mode === 'local' && (
        <div className="banner">{t.demoBanner}</div>
      )}
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {resError && <div className="banner error" onClick={() => setResError(null)}>{resError}</div>}

      <main className="content">
        {openList ? (
          <AreaFloor area={openList} orders={openList === 'delivery' ? deliveries : takeaways} config={floorConfig}
            onNew={() => (openList === 'delivery' ? startDelivery() : askTakeaway())}
            onOpen={(order) => (order.status === 'paid' ? setPickupFor(order) : openTakeaway(order.id))} />
        ) : loading ? (
          <div className="center muted">{t.loading}</div>
        ) : !hall ? (
          <div className="center">
            <div className="card empty">
              <p>{t.noHalls}</p>
              {can('edit') && <button className="primary" onClick={addHall}>{t.addFirstHall}</button>}
            </div>
          </div>
        ) : (
          <>
            <section className="floor-area">
              <div className="floor-toolbar">
                <span className="pill free">{t.freeCount(counts.free)}</span>
                <span className="pill occupied">{t.occupiedCount(counts.occupied)}</span>
                <span className="hint">
                  {mode === 'service' ? t.hintService : t.hintEdit}
                </span>
                {mode === 'edit' && <button className="primary" onClick={addTable}>{t.addTable}</button>}
                {mode === 'edit' && <button onClick={() => setMode('service')}>✓ {t.doneEditing}</button>}
              </div>
              <FloorPlan
                hall={hall}
                tables={tables}
                editable={mode === 'edit'}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onTap={tapTable}
                onMove={(id, x, y) => updateTable(id, { x, y })}
                reservations={reservedTables}
                onReservation={(reservation, table) => setResInfo({ reservation, table })}
                orders={tableOrders}
                timer={floorConfig}
              />
            </section>
            {mode === 'edit' && (
              <aside className="side">
                {selected ? (
                  <TablePanel
                    key={selected.id}
                    table={selected}
                    hall={hall}
                    onChange={(patch) => updateTable(selected.id, patch)}
                    onDelete={() => deleteTable(selected)}
                    onClose={() => setSelectedId(null)}
                  />
                ) : (
                  <HallPanel
                    key={hall.id}
                    hall={hall}
                    onChange={(patch) => run(() => repo.updateHall(hall.id, patch).then(reload))}
                    onDelete={() => deleteHall(hall)}
                    onBackground={reload}
                  />
                )}
              </aside>
            )}
          </>
        )}
      </main>
      {actions && (
        <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setActions(null)}>
          <div className="dialog table-actions" role="dialog" aria-modal="true" aria-labelledby="table-actions-title"
            onKeyDown={(e) => e.key === 'Escape' && setActions(null)}>
            <div className="panel-head">
              <h2 id="table-actions-title">{t.tableActions(actions.table.label)}</h2>
              <button className="ghost" onClick={() => setActions(null)} aria-label={t.close}>✕</button>
            </div>
            <p className="muted small">{t.itemCount(actions.count)} · {money(actions.total)}</p>
            <button className="primary big" autoFocus onClick={() => openOrder(actions.table.id, true)}>{t.checkoutAmount(money(actions.total))}</button>
            <button className="big" onClick={() => openOrder(actions.table.id, false)}>{t.viewOrder}</button>
          </div>
        </div>
      )}
      {pickupFor && (
        <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setPickupFor(null)}>
          <div className="dialog table-actions" role="dialog" aria-modal="true" aria-labelledby="pickup-title" onKeyDown={(e) => e.key === 'Escape' && setPickupFor(null)}>
            <div className="panel-head">
              <h2 id="pickup-title">{pickupFor.order_type === 'delivery' ? t.deliveryShort(String(pickupFor.delivery_no ?? '?')) : t.takeawayShort(String(pickupFor.takeaway_no ?? '?'))}</h2>
              <button className="ghost" onClick={() => setPickupFor(null)} aria-label={t.close}>✕</button>
            </div>
            {pickupFor.order_type === 'delivery' ? (
              <>
                <p className="muted small">{t.deliveryPaidHint}</p>
                {pickupFor.delivery_status !== 'on_the_way' && (
                  <button className="big" autoFocus onClick={() => setPickup(pickupFor, 'on_the_way')}>🛵 {t.deliveryStatuses.on_the_way}</button>
                )}
                <button className="primary big" onClick={() => setPickup(pickupFor, 'delivered')}>✓ {t.deliveryStatuses.delivered}</button>
              </>
            ) : (
              <>
                <p className="muted small">{t.pickupPaidHint}</p>
                {pickupFor.pickup_status !== 'ready' && (
                  <button className="big" autoFocus onClick={() => setPickup(pickupFor, 'ready')}>🔔 {t.pickupStatuses.ready}</button>
                )}
                <button className="primary big" onClick={() => setPickup(pickupFor, 'handed')}>✓ {t.pickupStatuses.handed}</button>
              </>
            )}
          </div>
        </div>
      )}
      {startingTakeaway && (
        <TakeawayStartDialog min={floorConfig.takeaway_number_min} max={floorConfig.takeaway_number_max} used={takeawayUsed}
          onCancel={() => setStartingTakeaway(false)}
          onStart={async (number) => {
            // Created now: the number is reserved at once (an empty order is cancelled when left).
            const order = await repo.openTakeaway(number)
            reloadTakeaways()
            openTakeaway(order.id)
          }} />
      )}
      {newDelivery && (
        <DeliveryDialog submitLabel={t.deliveryStart} numbers={{ min: floorConfig.delivery_number_min, max: floorConfig.delivery_number_max, used: deliveryUsed }}
          onCancel={() => setNewDelivery(false)}
          onSubmit={async (customer) => {
            const order = await repo.openDelivery(customer)
            reloadTakeaways()
            openTakeaway(order.id)
          }} />
      )}
      {resInfo && (
        <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setResInfo(null)}>
          <div className="dialog table-actions" role="dialog" aria-modal="true" aria-labelledby="res-info-title"
            onKeyDown={(e) => e.key === 'Escape' && setResInfo(null)}>
            <div className="panel-head">
              <h2 id="res-info-title">{t.resInfoTitle(resInfo.table.label)}</h2>
              <button className="ghost" onClick={() => setResInfo(null)} aria-label={t.close}>✕</button>
            </div>
            <p className="res-info-time"><strong>{timeText(resInfo.reservation.reserved_at, lang)}</strong> · {t.resPartySize(resInfo.reservation.party_size)}</p>
            <p><bdi>{resInfo.reservation.client_name}</bdi>
              {resInfo.reservation.phone && <> · <a href={`tel:${resInfo.reservation.phone.replace(/[^\d+]/g, '')}`} dir="ltr">{resInfo.reservation.phone}</a></>}
            </p>
            {resInfo.reservation.note && <p className="muted small"><bdi>{resInfo.reservation.note}</bdi></p>}
            <button className="primary big" autoFocus onClick={() => { const table = resInfo.table; setResInfo(null); tapTable(table) }}>{t.resOpenTable}</button>
            {can('reservations') && <button className="big" onClick={() => { setResInfo(null); openBo('reservations') }}>{t.resSeeList}</button>}
          </div>
        </div>
      )}
      {infoDialog}
      {dialog.element}
    </div>
  )
}

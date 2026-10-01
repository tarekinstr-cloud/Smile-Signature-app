import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { repo } from '../lib/repo'
import type {
  AdjustmentsPatch, ChosenOption, DeliveryStatus, Discount, DiningTable, Driver, Hall, ItemOption, Menu, MenuItem, OptionGroup, Order, OrderLine, PaidOrder, Payment, PickupStatus,
} from '../lib/types'
import { money } from '../lib/format'
import PaymentScreen, { minus } from './PaymentScreen'
import { computeBill, discountOf } from '../lib/billing'
import ReceiptDialog from './ReceiptDialog'
import KitchenTicketsDialog from './KitchenTicketsDialog'
import DiscountDialog from './DiscountDialog'
import MoveTableDialog from './MoveTableDialog'
import { BillDialog, InvoiceDialog } from './DocumentDialog'
import { dispatchTickets, type SendResult } from '../lib/kitchen'
import { deliveryContact, placeText, ticketPlace } from '../lib/place'
import DeliveryDialog from './DeliveryDialog'
import { useDialog } from './Dialog'
import CancelDialog from './CancelDialog'
import LangToggle from './LangToggle'
import { useI18n } from '../lib/i18n'
import { usePermissions } from '../lib/permissions'
import { reservations } from '../lib/reservations'

interface Props {
  /** Table tapped on the floor plan; null for a takeaway order. */
  table: DiningTable | null
  hall: Hall | null
  /** Open order to show (a takeaway order picked from the list). Otherwise the table's open order, or a new one. */
  orderId?: string
  /** Opens the checkout as soon as the order is loaded (checkout started from the floor plan). */
  startCheckout?: boolean
  /** New takeaway: the number of people chosen before the order screen (saved when the order is created). */
  startGuests?: number
  onBack(): void
  /** Nouvelle CMD → À emporter: the floor screen opens a fresh takeaway order. */
  onNewTakeaway(): void
  /** Nouvelle CMD → Livraison: the floor screen asks for the customer, then opens the new delivery. */
  onNewDelivery(): void
}

const DELIVERY_STATUSES: DeliveryStatus[] = ['preparing', 'on_the_way', 'delivered']
const PICKUP_STATUSES: PickupStatus[] = ['preparing', 'ready', 'handed']

const sameOptions = (a: ChosenOption[], b: ChosenOption[]) =>
  a.length === b.length && a.every((o, i) => o.group === b[i].group && o.name === b[i].name)

const chosen = (g: OptionGroup, o: ItemOption): ChosenOption => ({ group: g.name, name: o.name, price_delta: o.price_delta, option_id: o.id })
const isChosen = (options: ChosenOption[], g: OptionGroup, o: ItemOption) => options.some((c) => c.group === g.name && c.name === o.name)
const optionsPrice = (options: ChosenOption[]) => options.reduce((s, c) => s + c.price_delta, 0)

/** The item's first required pick-one group (Taille…): each of its options is its own button in the grid. */
const mainGroup = (groups: OptionGroup[]) => groups.find((g) => g.min_select >= 1 && g.max_select === 1 && g.options.length > 0)

/** Options of a new line: the tapped size, and the first option of any other required pick-one group. */
function baseOptions(groups: OptionGroup[], main?: OptionGroup, size?: ItemOption): ChosenOption[] {
  return groups.flatMap((g) => {
    if (g === main && size) return [chosen(g, size)]
    return g.min_select >= 1 && g.max_select === 1 && g.options[0] ? [chosen(g, g.options[0])] : []
  })
}

/** Keeps a line's options in menu order (group, then option), so equal choices compare equal. */
function menuOrder(groups: OptionGroup[], options: ChosenOption[]): ChosenOption[] {
  const rank = (c: ChosenOption) => {
    const gi = groups.findIndex((g) => g.name === c.group)
    return gi < 0 ? Infinity : gi * 1000 + groups[gi].options.findIndex((o) => o.name === c.name)
  }
  return [...options].sort((a, b) => rank(a) - rank(b))
}

/** One button of the items grid: an item, or one size of it. */
interface GridButton {
  key: string
  item: MenuItem
  size?: ItemOption
  price: number
}

/** How the payment screen was opened from the action bar. */
interface PayMode {
  partial?: boolean
  /** Payer sans ticket: the payment is recorded, no receipt is shown or printed. */
  noTicket?: boolean
}

type Modal = 'move' | 'invoice' | 'bill' | 'print' | 'new' | 'discount' | 'delivery'

export default function OrderScreen({ table, hall: startHall, orderId: startOrderId, startCheckout, startGuests, onBack, onNewTakeaway, onNewDelivery }: Props) {
  const [menu, setMenu] = useState<Menu | null>(null)
  const [categoryId, setCategoryId] = useState<string | null>(null)
  /** Where the order is: a table (with its hall), or null for takeaway. Follows Changement de Table. */
  const [place, setPlace] = useState<{ table: DiningTable; hall: Hall } | null>(table && startHall ? { table, hall: startHall } : null)
  const [order, setOrder] = useState<Order | null>(null)
  const [lines, setLines] = useState<OrderLine[]>([])
  /** Partial payments already made on the open order. */
  const [payments, setPayments] = useState<Payment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [paying, setPaying] = useState<PayMode | null>(null)
  const [paid, setPaid] = useState<{ order: PaidOrder; lines: OrderLine[]; payments: Payment[]; noTicket?: boolean } | null>(null)
  /** Kitchen tickets on screen: the result of the last Valider, or a reprint. */
  const [sent, setSent] = useState<(SendResult & { sentCount: number; reprint?: boolean }) | null>(null)
  const [modal, setModal] = useState<Modal | null>(null)
  /** Annuler la CMD in progress: the reason dialog. */
  const [cancelling, setCancelling] = useState(false)
  /** Couverts: the guests picker is open. */
  const [guestsOpen, setGuestsOpen] = useState(false)
  /** Number of people of a new takeaway, saved when its first item creates the order. */
  const [pendingGuests, setPendingGuests] = useState(startGuests)
  /** Bipeur enabled in Paramètres > Configurations. */
  const [pagerEnabled, setPagerEnabled] = useState(false)
  /** Livraison: the driver picker is open, with the drivers to choose from. */
  const [driverOpen, setDriverOpen] = useState(false)
  const [drivers, setDrivers] = useState<Driver[] | null>(null)
  useEffect(() => {
    const read = () => repo.getFloorConfig().then((c) => setPagerEnabled(c.pager_enabled), () => {})
    read()
    return repo.subscribeConfig(read)
  }, [])
  useEffect(() => {
    if (driverOpen) repo.listDrivers().then(setDrivers, () => setDrivers([]))
  }, [driverOpen])
  // Line that supplement buttons, Remise and Offrir apply to: the one last added, or the one tapped in the order.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const opening = useRef<Promise<Order> | null>(null)
  /** The order being shown, once there is one; kept in a ref for the realtime reloads. */
  const orderIdRef = useRef<string | null>(startOrderId ?? null)
  const placeRef = useRef(place)
  placeRef.current = place
  const menuRef = useRef<HTMLElement | null>(null)
  const dialog = useDialog()
  const { t } = useI18n()
  /** Annuler la CMD, Offrir and Remise are shown only with their permission (Fichier > Permissions). */
  const { can } = usePermissions()

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      setError(null)
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  /** Keeps the header on the order's table when it was moved, here or on another device. */
  const followTable = useCallback(async (o: Order) => {
    const current = placeRef.current
    if (!o.table_id) {
      if (current) setPlace(null)
      return
    }
    if (current?.table.id === o.table_id) return
    const [halls, tables] = await Promise.all([repo.listHalls(), repo.listAllTables()])
    const tbl = tables.find((x) => x.id === o.table_id)
    const h = tbl && halls.find((x) => x.id === tbl.hall_id)
    if (tbl && h) setPlace({ table: tbl, hall: h })
  }, [])

  const reloadOrder = useCallback(async () => {
    await run(async () => {
      const id = orderIdRef.current
      const tbl = placeRef.current?.table
      const current = id ? await repo.getOrder(id) : tbl ? await repo.getOpenOrder(tbl.id) : null
      if (current) {
        orderIdRef.current = current.order.id
        await followTable(current.order)
      }
      setOrder(current?.order ?? null)
      setLines(current?.lines ?? [])
      setPayments(current?.payments ?? [])
    })
  }, [run, followTable])

  useEffect(() => {
    ;(async () => {
      await run(async () => {
        const m = await repo.getMenu()
        setMenu(m)
        setCategoryId((id) => id ?? m.categories[0]?.id ?? null)
      })
      await reloadOrder()
      setLoading(false)
      if (startCheckout) setPaying({})
    })()
    // Only on first load: another table or order remounts this screen (keyed by it).
  }, [])

  // One realtime subscription per mount, always calling the latest reloadOrder; the cleanup unsubscribes.
  const reloadRef = useRef(reloadOrder)
  reloadRef.current = reloadOrder
  useEffect(() => repo.subscribeOrders(() => reloadRef.current()), [])

  const items = useMemo(() => menu?.items.filter((i) => i.category_id === categoryId) ?? [], [menu, categoryId])
  const buttons = useMemo<GridButton[]>(
    () =>
      items.flatMap((item) => {
        const main = mainGroup(menu?.groups[item.id] ?? [])
        if (!main) return [{ key: item.id, item, price: item.price }]
        return main.options.map((size) => ({ key: size.id, item, size, price: item.price + size.price_delta }))
      }),
    [items, menu],
  )
  const selected = lines.find((l) => l.id === selectedId) ?? null
  const selectedItem = selected && menu?.items.find((i) => i.id === selected.item_id)
  const selectedGroups = selectedItem ? (menu?.groups[selectedItem.id] ?? []) : []
  // Supplements of the selected line's item, or, before a line is selected, those of the category's items.
  const supplementGroups = useMemo(() => {
    const source = selectedItem ? [selectedItem] : items
    const seen = new Set<string>()
    return source.flatMap((item) => {
      const groups = menu?.groups[item.id] ?? []
      const main = mainGroup(groups)
      return groups.filter((g) => g !== main && !seen.has(g.name) && seen.add(g.name))
    })
  }, [selectedItem, items, menu])
  const bill = computeBill(order, lines, payments)
  const count = lines.reduce((s, l) => s + l.quantity, 0)
  const newCount = lines.reduce((s, l) => s + (l.sent_at ? 0 : l.quantity), 0)
  const selectedSent = !!selected?.sent_at
  const anySent = lines.some((l) => l.sent_at)

  const where = placeText(t, order ?? { order_type: place ? 'dine_in' : 'takeaway', takeaway_no: null }, place?.table ?? null)
  const hasItems = !!order && lines.length > 0
  /** Change given back on the last cash payment, shown after a payment made on the keypad. */
  const lastChange = payments.at(-1)?.change_amount ?? 0

  async function ensureOrder(): Promise<Order> {
    if (order) return order
    // Two quick taps must not open two orders.
    const target = place?.table.id
    opening.current ??= (target ? repo.openOrder(target) : repo.openTakeaway(pendingGuests)).finally(() => {
      opening.current = null
    })
    const o = await opening.current
    orderIdRef.current = o.id
    setOrder(o)
    return o
  }

  /**
   * Taps an item (or one of its sizes): one more on the item's last line when that line has no
   * supplement, otherwise a new line. The line becomes the selected one.
   */
  async function tapItem({ item, size }: GridButton) {
    const groups = menu?.groups[item.id] ?? []
    const main = mainGroup(groups)
    const options = baseOptions(groups, main, size)
    const last = lines.filter((l) => l.item_id === item.id && (!main || l.options.some((c) => c.group === main.name && c.name === size?.name))).at(-1)
    setBusy(true)
    await run(async () => {
      // A line already sent to the kitchen stays as it was: more of the same goes on a new line.
      if (last && !last.sent_at && !last.is_takeaway && !last.note && !last.offered && !discountOf(last) && sameOptions(last.options, options)) {
        await repo.updateLine(last.id, { quantity: last.quantity + 1 })
        setSelectedId(last.id)
      } else {
        const o = await ensureOrder()
        const line = await repo.addLine(o.id, { item_id: item.id, name: item.name, unit_price: item.price + optionsPrice(options), quantity: 1, options, note: null })
        setSelectedId(line.id)
      }
      await reloadOrder()
    })
    setBusy(false)
  }

  /** Whether a supplement button can change the selected line (its item has that option). */
  function supplementTarget(g: OptionGroup, o: ItemOption) {
    const group = selectedGroups.find((x) => x.name === g.name)
    const option = group?.options.find((x) => x.name === o.name)
    return group && option ? { group, option } : null
  }

  /** Switches a supplement on or off on the selected line, for all its portions. */
  async function tapSupplement(g: OptionGroup, o: ItemOption) {
    const target = supplementTarget(g, o)
    if (!selected || selected.sent_at || !target) return
    const { group, option } = target
    const on = isChosen(selected.options, group, option)
    const inGroup = selected.options.filter((c) => c.group === group.name)
    let options: ChosenOption[]
    if (on) {
      if (inGroup.length <= group.min_select) return
      options = selected.options.filter((c) => !(c.group === group.name && c.name === option.name))
    } else if (group.max_select === 1) {
      options = [...selected.options.filter((c) => c.group !== group.name), chosen(group, option)]
    } else {
      if (inGroup.length >= group.max_select) return
      options = [...selected.options, chosen(group, option)]
    }
    options = menuOrder(selectedGroups, options)
    const unit_price = selected.unit_price - optionsPrice(selected.options) + optionsPrice(options)
    setBusy(true)
    await run(async () => {
      await repo.updateLine(selected.id, { options, unit_price })
      await reloadOrder()
    })
    setBusy(false)
  }

  async function changeQty(line: OrderLine, delta: number) {
    if (delta > 0 && line.sent_at) return addToSent(line)
    const quantity = line.quantity + delta
    setLines((ls) => (quantity > 0 ? ls.map((l) => (l.id === line.id ? { ...l, quantity } : l)) : ls.filter((l) => l.id !== line.id)))
    await run(() => (quantity > 0 ? repo.updateLine(line.id, { quantity }) : repo.deleteLine(line.id)))
    await reloadOrder()
  }

  /** "+" on a line already sent: the extra portion is new, so it goes on an unsent line of the same item. */
  async function addToSent(line: OrderLine) {
    const twin = lines.find((l) => !l.sent_at && !l.offered && !discountOf(l) && l.is_takeaway === line.is_takeaway && l.item_id === line.item_id && l.name === line.name && l.note === line.note && sameOptions(l.options, line.options))
    setBusy(true)
    await run(async () => {
      if (twin) {
        await repo.updateLine(twin.id, { quantity: twin.quantity + 1 })
        setSelectedId(twin.id)
      } else {
        const o = await ensureOrder()
        const copy = await repo.addLine(o.id, { item_id: line.item_id, name: line.name, unit_price: line.unit_price, quantity: 1, options: line.options, note: line.note, is_takeaway: line.is_takeaway })
        setSelectedId(copy.id)
      }
      await reloadOrder()
    })
    setBusy(false)
  }

  /** Couverts: guests at the table, shown as taken chairs on the floor plan. */
  async function setGuests(guests: number | null) {
    setGuestsOpen(false)
    // A new takeaway not created yet (no item): kept until the first item creates it.
    if (!order) return guests && setPendingGuests(guests)
    setOrder({ ...order, guests })
    await run(() => repo.setGuests(order.id, guests))
    await reloadOrder()
  }

  /** « Servi »: the floor timer stops until the next send to the kitchen (Suite then Valider). */
  async function markServed() {
    if (!order) return
    setBusy(true)
    await run(async () => {
      await repo.markServed(order.id)
      await reloadOrder()
      setNotice(t.servedNotice)
    })
    setBusy(false)
  }

  /** Valider: sends the new lines to the kitchen and shows each printer's ticket. The order stays open. */
  async function validate() {
    if (!order || newCount === 0) return
    setBusy(true)
    await run(async () => {
      const result = await repo.sendOrder(order.id, ticketPlace(order, place?.table ?? null))
      await reloadOrder()
      if (!result.tickets.length && !result.unrouted.length) throw new Error(t.nothingToSend)
      const printers = result.tickets.length ? await repo.listPrinters() : []
      const left = await dispatchTickets(result.tickets, printers)
      setSent({ tickets: left, unrouted: result.unrouted, sentCount: result.tickets.length })
    })
    setBusy(false)
  }

  const clock = (iso: string) => new Date(iso).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

  /** Sur place / À emporter on one line. Only while it is new: the kitchen already has the sent ones. */
  async function toggleTakeaway(line: OrderLine) {
    if (line.sent_at) return
    const is_takeaway = !line.is_takeaway
    setLines((ls) => ls.map((l) => (l.id === line.id ? { ...l, is_takeaway } : l)))
    await run(() => repo.updateLine(line.id, { is_takeaway }))
    await reloadOrder()
  }

  async function editNote(line: OrderLine) {
    if (line.sent_at) return
    const note = await dialog.askText(t.noteFor(line.name), t.save)
    if (note === null) return
    await run(() => repo.updateLine(line.id, { note }))
    await reloadOrder()
  }

  /** Runs an action of the bar with the buttons locked, then reloads the order. */
  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setNotice(null)
    await run(async () => {
      await fn()
      await reloadOrder()
    })
    setBusy(false)
  }

  /** Suite (+): back to the categories and items to add more; the order stays open. */
  function suite() {
    setSelectedId(null)
    setNotice(t.suiteHint)
    menuRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  /** Changement de Table: the order, its lines, kitchen status and payments go to the chosen free table. */
  async function moveTo(target: DiningTable, targetHall: Hall) {
    if (!order) {
      // Nothing saved yet: the next item simply opens the order on the new table.
      setPlace({ table: target, hall: targetHall })
      setModal(null)
      return
    }
    const from = where
    await act(async () => {
      await repo.moveOrder(order.id, target.id)
      setPlace({ table: target, hall: targetHall })
      setModal(null)
      setNotice(t.moved(from, t.table(target.label)))
    })
  }

  /** Remise and Offrir apply to the selected line, or to the whole order when no line is selected. */
  const adjust = (lineId: string | null, patch: AdjustmentsPatch) =>
    act(async () => {
      if (order) await repo.adjust(order.id, lineId, patch)
      setModal(null)
    })

  const applyDiscount = (d: Discount | null) =>
    adjust(selected?.id ?? null, d ? { discount_type: d.type, discount_value: d.value } : { discount_type: null, discount_value: 0 })

  async function offer() {
    if (!order) return
    if (selected) return adjust(selected.id, { offered: !selected.offered })
    const on = !order.offered
    if (!(await dialog.confirm(on ? t.confirmOfferOrder(where) : t.confirmUnofferOrder(where), on ? t.offerOrder : t.unofferOrder))) return
    await adjust(null, { offered: on })
  }

  /** Imprimer → Ticket cuisine: the kitchen tickets already sent for this order, again. */
  async function reprintKitchen() {
    if (!order) return
    setModal(null)
    await act(async () => {
      const tickets = await repo.listKitchenTickets(order.id)
      if (!tickets.length) throw new Error(t.noKitchenTickets)
      setSent({ tickets, unrouted: [], sentCount: tickets.length, reprint: true })
    })
  }

  /** Annuler la CMD: a reason is required once the order has items; a printed bill needs cancel_invoice. */
  async function cancelOrder() {
    if (!order) return
    if (lines.length === 0) {
      if (!(await dialog.confirm(t.confirmCancelOrder(where), t.actCancel))) return
      return run(async () => {
        await repo.cancelOrder(order.id)
        onBack()
      })
    }
    if ((order.printed_at || order.invoice_no) && !can('cancel_invoice')) return setError(t.errCancelInvoice)
    setCancelling(true)
  }

  /**
   * Leaves the screen; an order that was opened but never got an item does not keep its table occupied. Except the
   * order of a booking marked Honorée: the customer is seated, so the table stays occupied until items are added or
   * the order is cancelled (Annuler la CMD).
   */
  async function leaveEmpty() {
    if (order && lines.length === 0 && !(await reservations.hasOrder(order.id))) await run(() => repo.cancelOrder(order.id))
  }

  async function back() {
    await leaveEmpty()
    onBack()
  }

  async function newOrder(kind: 'table' | 'takeaway' | 'delivery') {
    setModal(null)
    await leaveEmpty()
    if (kind === 'takeaway') onNewTakeaway()
    else if (kind === 'delivery') onNewDelivery()
    else onBack()
  }

  /** À emporter: En préparation → Prête (the icon blinks in the view) → Remise au client. */
  async function setPickupStatus(status: PickupStatus) {
    if (!order || order.pickup_status === status) return
    setOrder({ ...order, pickup_status: status })
    await run(async () => {
      await repo.setPickupStatus(order.id, status)
      await reloadOrder()
    })
  }

  /** Bipeur: number of the pager given to the customer (empty removes it). */
  async function editPager() {
    if (!order) return
    const value = await dialog.askText(t.pagerAsk, t.save)
    if (value === null) return
    await run(async () => {
      await repo.setPager(order.id, value)
      await reloadOrder()
    })
  }

  /** Livraison: the driver taking it (their name and phone go on the order). */
  async function setDriver(driverId: string | null) {
    if (!order) return
    setDriverOpen(false)
    await run(async () => {
      await repo.setOrderDriver(order.id, driverId)
      await reloadOrder()
    })
  }

  async function setDeliveryStatus(status: DeliveryStatus) {
    if (!order || order.delivery_status === status) return
    setOrder({ ...order, delivery_status: status })
    await run(async () => setOrder(await repo.updateDelivery(order.id, { status })))
  }

  // The paid order is no longer open: name it from the paid order itself (takeaway number included).
  const paidWhere = paid ? placeText(t, paid.order, place?.table ?? null) : where
  if (paid?.noTicket) {
    const change = paid.payments.at(-1)?.change_amount ?? 0
    return (
      <div className="dialog-backdrop">
        <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="paid-title">
          <div className="panel-head">
            <h2 id="paid-title">{t.paidNoTicket}</h2>
            <span className="pill free">{t.paid}</span>
          </div>
          <p className="muted small">{paidWhere} · {t.paidNoTicketHint}</p>
          <div className="due"><span>{t.total}</span><strong>{money(paid.order.total)}</strong></div>
          {change > 0 && <div className="change"><span>{t.changeGiven}</span><strong>{money(change)}</strong></div>}
          <div className="dialog-actions">
            <button className="primary big" autoFocus onClick={onBack}>{t.doneBack}</button>
          </div>
        </div>
      </div>
    )
  }
  if (paid) {
    return <ReceiptDialog order={paid.order} lines={paid.lines} payments={paid.payments} place={paidWhere} hallName={place?.hall.name ?? null} onDone={onBack} />
  }
  if (paying && order && lines.length > 0) {
    const mode = paying
    return (
      <PaymentScreen orderId={order.id} place={where} hallName={place?.hall.name ?? null} startPartial={mode.partial} noTicket={mode.noTicket}
        onBack={() => { setPaying(null); reloadOrder() }}
        onPaid={(result) => { setPaying(null); setPaid({ ...result, noTicket: mode.noTicket }) }} />
    )
  }

  const isDelivery = order?.order_type === 'delivery'
  const offerOn = selected ? selected.offered : !!order?.offered
  const target = selected ? selected.name : t.wholeOrder
  const selectedBill = selected ? bill.lines.find((b) => b.line.id === selected.id) : null

  return (
    <div className="app order-screen">
      <header className="topbar">
        <button className="ghost back" onClick={back} aria-label={t.backToFloor}>{t.back}</button>
        <div className="order-title">
          <strong>{where}</strong>
          <span>
            {place ? <><bdi>{place.hall.name}</bdi> · {t.seatsCount(place.table.seats)}</>
              : isDelivery ? <bdi>{[deliveryContact(order), order.customer_address, order.delivery_zone_name].filter(Boolean).join(' · ')}</bdi>
              : order?.customer_name ? <bdi>{order.customer_name}</bdi>
              : t.takeaway}
          </span>
        </div>
        {order?.order_type === 'takeaway' && (
          <>
            <div className="segmented delivery-status-bar" role="group" aria-label={t.pickupStatus}>
              {PICKUP_STATUSES.map((s) => (
                <button key={s} className={order.pickup_status === s ? 'on' : ''} aria-pressed={order.pickup_status === s}
                  onClick={() => setPickupStatus(s)}>{t.pickupStatuses[s]}</button>
              ))}
            </div>
            {pagerEnabled && <button className="ghost" onClick={editPager}>📟 {order.pager_no ? t.pagerShort(order.pager_no) : t.pagerTitle}</button>}
          </>
        )}
        {isDelivery && (
          <>
            <button className="ghost" onClick={() => setModal('delivery')}>✎ {t.customer}</button>
            <button className="ghost" onClick={() => setDriverOpen(true)}>🛵 {order.driver_name ? <bdi>{order.driver_name}</bdi> : t.chooseDriver}</button>
            <div className="segmented delivery-status-bar" role="group" aria-label={t.deliveryStatus}>
              {DELIVERY_STATUSES.map((s) => (
                <button key={s} className={order.delivery_status === s ? 'on' : ''} aria-pressed={order.delivery_status === s}
                  onClick={() => setDeliveryStatus(s)}>{t.deliveryStatuses[s]}</button>
              ))}
            </div>
          </>
        )}
        <div className="spacer" />
        {(order || pendingGuests) && (
          <button className="ghost order-guests" onClick={() => setGuestsOpen(true)} title={t.guestsTitle}>
            👤 {(order ? order.guests : pendingGuests) ? (place ? t.guestsCount : t.peopleCount)((order ? order.guests : pendingGuests)!) : t.guestsTitle}
          </button>
        )}
        {order && place && lines.some((l) => l.sent_at) && (
          order.served_at
            ? <span className="pill free order-served" title={t.servedHint}>✓ {t.floorServed}</span>
            : <button className="order-served" onClick={markServed} disabled={busy} title={t.servedHint}>✓ {t.servedBtn}</button>
        )}
        {order && <span className="pill occupied">{t.openOrder}</span>}
        <LangToggle />
      </header>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {notice && <div className="banner ok" onClick={() => setNotice(null)}>{notice}</div>}

      {loading ? (
        <div className="center muted">{t.loading}</div>
      ) : (
        <main className="content order-content">
          <nav className="categories category-col" aria-label={t.categories}>
            {menu?.categories.map((c) => (
              <button
                key={c.id}
                className={c.id === categoryId ? 'category on' : 'category'}
                style={{ ['--cat' as string]: c.color }}
                onClick={() => setCategoryId(c.id)}
              >
                {c.name}
              </button>
            ))}
          </nav>
          <section className="menu-area" ref={menuRef}>
            {menu && menu.categories.length === 0 ? (
              <div className="card empty">
                <p>{t.emptyMenu}</p>
              </div>
            ) : (
              <div className="items-grid">
                {buttons.map((b) => (
                  <button key={b.key} className="item-card" onClick={() => tapItem(b)} disabled={busy}>
                    <span className="item-name">{b.item.name}</span>
                    {b.size && <span className="item-size">{b.size.name}</span>}
                    <span className="item-price">{money(b.price)}</span>
                  </button>
                ))}
                {items.length === 0 && <p className="muted">{t.noItemsInCategory}</p>}
              </div>
            )}

            <div className="supplements" aria-label={t.supplements}>
              <div className="supp-head">
                <strong>{t.supplements}</strong>
                <span className="muted small">{selectedSent ? t.sentLocked : selected ? <>→ <bdi>{selected.name}</bdi>{selected.options[0] && <> <bdi>{selected.options[0].name}</bdi></>}</> : t.selectLineHint}</span>
              </div>
              {supplementGroups.length === 0 ? (
                <p className="muted small">{t.noSupplements}</p>
              ) : (
                <div className="supp-btns">
                  {supplementGroups.flatMap((g) =>
                    g.options.map((o) => {
                      const target = supplementTarget(g, o)
                      const on = !!(selected && target && isChosen(selected.options, target.group, target.option))
                      const delta = target?.option.price_delta ?? o.price_delta
                      return (
                        <button key={o.id} className={on ? 'supp-btn on' : 'supp-btn'} aria-pressed={on} disabled={busy || !target || selectedSent}
                          onClick={() => tapSupplement(g, o)}>
                          <bdi>{o.name}</bdi>
                          {delta !== 0 && <span className="small"> <bdi dir="ltr">{delta > 0 ? '+' : ''}{money(delta)}</bdi></span>}
                        </button>
                      )
                    }),
                  )}
                </div>
              )}
            </div>
          </section>

          <aside className="ticket">
            <div className="panel">
              <div className="panel-head">
                <h2>{t.order}</h2>
                <span className="muted small">{t.itemCount(count)}</span>
              </div>
              {lines.length === 0 ? (
                <p className="muted small">{t.orderHint}</p>
              ) : (
                <ul className="lines">
                  {bill.lines.map(({ line: l, offered }) => (
                    <li key={l.id} className={l.id === selectedId ? 'line on' : 'line'} aria-selected={l.id === selectedId}
                      onClick={() => setSelectedId(l.id === selectedId ? null : l.id)}>
                      <div className="line-main">
                        <span className="line-name">{l.name}</span>
                        <span className="line-total">{offered ? <s className="muted">{money(l.unit_price * l.quantity)}</s> : money(l.unit_price * l.quantity)}</span>
                      </div>
                      {l.is_takeaway && <span className="tag takeaway-tag">{t.lineTakeaway}</span>}
                      {offered && <span className="tag offered-tag">{t.offered}</span>}
                      {discountOf(l) && !offered && <span className="tag">{t.discount}</span>}
                      {l.sent_at ? (
                        <div className="line-sent">✓ {t.sentAt(clock(l.sent_at))}</div>
                      ) : (
                        anySent && <span className="tag new-tag">{t.newLine}</span>
                      )}
                      {(l.options.length > 0 || l.note) && (
                        <div className="line-details">
                          {l.options.map((o) => o.name).join(t.listSep)}
                          {l.note && <em> · {l.note}</em>}
                        </div>
                      )}
                      <div className="stepper" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => changeQty(l, -1)} aria-label={t.decrease}>−</button>
                        <span>{l.quantity}</span>
                        <button onClick={() => changeQty(l, 1)} aria-label={t.increase}>+</button>
                        <span className="muted small">× {money(l.unit_price)}</span>
                        {order?.order_type === 'dine_in' && (
                          <button className={l.is_takeaway ? 'takeaway-toggle on' : 'takeaway-toggle'} onClick={() => toggleTakeaway(l)}
                            disabled={!!l.sent_at} aria-pressed={l.is_takeaway} title={l.sent_at ? t.sentLocked : t.lineTakeawayHint}>
                            {l.is_takeaway ? `🥡 ${t.lineTakeaway}` : `🍽 ${t.lineOnSite}`}
                          </button>
                        )}
                        {!l.sent_at && <button className="note-btn" onClick={() => editNote(l)} title={t.addNote} aria-label={t.addNote}>✎</button>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {bill.total !== bill.gross && (
                <div className="ticket-sub"><span>{t.subtotal}</span><span>{money(bill.gross)}</span></div>
              )}
              {bill.delivery > 0 && (
                <div className="ticket-sub"><span>{t.deliveryFee}</span><span>{money(bill.delivery)}</span></div>
              )}
              {bill.paid > 0 && (
                <div className="ticket-sub"><span>{t.alreadyPaid}</span><span>{minus(bill.paid)}</span></div>
              )}
              {lines.length > 0 && (
                <button className="validate-btn" onClick={validate} disabled={busy || newCount === 0} title={t.validateHint}>
                  {newCount > 0 ? t.validateCount(newCount) : t.validate}
                </button>
              )}
              <button onClick={back}>{t.doneBack}</button>
            </div>
          </aside>
        </main>
      )}

      {!loading && (
        <nav className="action-bar" aria-label={t.actions}>
          <div className="action-sum" aria-live="polite">
            <div className="sum-row sum-total"><span>{t.total}</span><strong>{money(bill.total)}</strong></div>
            {bill.paid > 0 && <div className="sum-row sum-rest"><span>{t.remaining}</span><strong>{money(bill.remaining)}</strong></div>}
            {lastChange > 0 && <div className="sum-row sum-change"><span>{t.changeGiven}</span><strong>{money(lastChange)}</strong></div>}
          </div>
          <div className="action-btns">
            <button onClick={suite}><i aria-hidden>＋</i>{t.actSuite}</button>
            <button onClick={() => setModal('new')} disabled={busy}><i aria-hidden>🆕</i>{t.actNewOrder}</button>
            <button onClick={() => setModal('move')} disabled={busy || isDelivery} title={isDelivery ? t.deliveryNoMove : undefined}>
              <i aria-hidden>⇄</i>{t.actMoveTable}
            </button>
            <button onClick={() => setModal('invoice')} disabled={busy || !hasItems}><i aria-hidden>🧾</i>{t.actInvoice}</button>
            <button onClick={() => setPaying({ noTicket: true })} disabled={busy || !hasItems}><i aria-hidden>💵</i>{t.actPayNoTicket}</button>
            <button onClick={() => setModal('print')} disabled={busy || !hasItems}><i aria-hidden>🖨</i>{t.actPrint}</button>
            <button className="act-pay" onClick={() => setPaying({})} disabled={busy || !hasItems}><i aria-hidden>💳</i>{t.actPay}</button>
            {can('discount') && (
              <button onClick={() => setModal('discount')} disabled={busy || !hasItems || !!order?.offered || !!selectedBill?.offered}>
                <i aria-hidden>%</i>{t.actDiscount}<small><bdi>{target}</bdi></small>
              </button>
            )}
            <button onClick={() => setPaying({ partial: true })} disabled={busy || !hasItems || bill.remaining <= 0}><i aria-hidden>½</i>{t.actPartial}</button>
            {can('cancel_order') && (
              <button className="act-cancel" onClick={cancelOrder} disabled={busy || !order}><i aria-hidden>✕</i>{t.actCancel}</button>
            )}
            {can('offer') && (
              <button className={offerOn ? 'act-offer on' : 'act-offer'} aria-pressed={offerOn} onClick={offer}
                disabled={busy || !hasItems || (!!selected && !!order?.offered)}>
                <i aria-hidden>🎁</i>{offerOn ? t.actUnoffer : t.actOffer}<small><bdi>{target}</bdi></small>
              </button>
            )}
          </div>
        </nav>
      )}

      {sent && (
        <KitchenTicketsDialog tickets={sent.tickets} sentCount={sent.sentCount} unrouted={sent.unrouted} reprint={sent.reprint} onClose={() => setSent(null)} />
      )}
      {modal === 'move' && (
        <MoveTableDialog currentTableId={place?.table.id ?? null} busy={busy} onCancel={() => setModal(null)} onPick={moveTo} />
      )}
      {modal === 'delivery' && order && (
        <DeliveryDialog place={where} submitLabel={t.save} onCancel={() => setModal(null)}
          initial={{ name: order.customer_name ?? '', phone: order.customer_phone ?? '', address: order.customer_address ?? '' }}
          zone={{ id: order.delivery_zone_id ?? null, name: order.delivery_zone_name ?? null, fee: order.delivery_fee ?? 0 }}
          onSubmit={async (customer) => {
            setOrder(await repo.updateDelivery(order.id, customer))
            setModal(null)
          }} />
      )}
      {modal === 'discount' && order && (
        <DiscountDialog
          target={target}
          base={selectedBill ? selectedBill.gross : bill.subtotal}
          current={selected ? discountOf(selected) : discountOf(order)}
          busy={busy}
          onCancel={() => setModal(null)}
          onApply={applyDiscount}
        />
      )}
      {modal === 'invoice' && order && (
        <InvoiceDialog order={order} lines={lines} payments={payments} place={where} hallName={place?.hall.name ?? null} onClose={() => { setModal(null); reloadOrder() }} />
      )}
      {modal === 'bill' && order && (
        <BillDialog order={order} lines={lines} payments={payments} place={where} hallName={place?.hall.name ?? null} onClose={() => setModal(null)} />
      )}
      {(modal === 'print' || modal === 'new') && (
        <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setModal(null)}>
          <div className="dialog table-actions" role="dialog" aria-modal="true" aria-labelledby="choice-title" onKeyDown={(e) => e.key === 'Escape' && setModal(null)}>
            <div className="panel-head">
              <h2 id="choice-title">{modal === 'print' ? t.printWhat : t.newOrderTitle}</h2>
              <button className="ghost" onClick={() => setModal(null)} aria-label={t.close}>✕</button>
            </div>
            {modal === 'print' ? (
              <>
                <button className="big" autoFocus onClick={reprintKitchen}>🍳 {t.printKitchen}</button>
                <button className="big" onClick={() => setModal('bill')}>🧾 {t.printBill}</button>
              </>
            ) : (
              <>
                <button className="big" autoFocus onClick={() => newOrder('table')}>🍽 {t.newOrderTable}</button>
                <button className="big" onClick={() => newOrder('takeaway')}>🥡 {t.newOrderTakeaway}</button>
                <button className="big" onClick={() => newOrder('delivery')}>🛵 {t.newOrderDelivery}</button>
              </>
            )}
          </div>
        </div>
      )}
      {cancelling && order && (
        <CancelDialog title={t.confirmCancelOrder(where)} confirmLabel={t.actCancel}
          detail={order.printed_at || order.invoice_no ? t.cancelPrintedDetail : undefined}
          onCancel={() => setCancelling(false)}
          onConfirm={async (why) => {
            await repo.cancelOrder(order.id, why)
            setCancelling(false)
            onBack()
          }} />
      )}
      {guestsOpen && (order || pendingGuests) && (
        <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setGuestsOpen(false)}>
          <div className="dialog table-actions" role="dialog" aria-modal="true" aria-labelledby="guests-title"
            onKeyDown={(e) => e.key === 'Escape' && setGuestsOpen(false)}>
            <div className="panel-head">
              <h2 id="guests-title">{place ? t.guestsTitle : t.peopleTitle}</h2>
              <button className="ghost" onClick={() => setGuestsOpen(false)} aria-label={t.close}>✕</button>
            </div>
            <p className="muted small">{place ? t.guestsHint(place.table.seats) : t.guestsHintNoTable}</p>
            <div className="keypad">
              {Array.from({ length: Math.min(99, Math.max(place?.table.seats ?? 10, order?.guests ?? 0, 1) + (place ? 2 : 0)) }, (_, i) => i + 1).map((n) => {
                const current = order ? order.guests : pendingGuests
                return <button key={n} type="button" className={current === n ? 'key-fn' : undefined} aria-pressed={current === n} onClick={() => setGuests(n)}>{n}</button>
              })}
            </div>
            {place && order?.guests != null && <button onClick={() => setGuests(null)}>{t.guestsClear}</button>}
          </div>
        </div>
      )}
      {driverOpen && order && (
        <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setDriverOpen(false)}>
          <div className="dialog table-actions" role="dialog" aria-modal="true" aria-labelledby="driver-title" onKeyDown={(e) => e.key === 'Escape' && setDriverOpen(false)}>
            <div className="panel-head">
              <h2 id="driver-title">{t.chooseDriver}</h2>
              <button className="ghost" onClick={() => setDriverOpen(false)} aria-label={t.close}>✕</button>
            </div>
            {!drivers ? <p className="muted">{t.loading}</p> : drivers.length === 0 ? <p className="muted small">{t.noDrivers}</p> : drivers.map((d) => (
              <button key={d.user_id} className={`big${order.driver_id === d.user_id ? ' primary' : ''}`} onClick={() => setDriver(d.user_id)}>
                🛵 <bdi>{d.name}</bdi>{d.phone && <span className="muted small"> · <bdi dir="ltr">{d.phone}</bdi></span>}
              </button>
            ))}
            {order.driver_id && <button onClick={() => setDriver(null)}>{t.removeDriver}</button>}
          </div>
        </div>
      )}
      {dialog.element}
    </div>
  )
}

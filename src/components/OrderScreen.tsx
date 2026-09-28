import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { repo } from '../lib/repo'
import type { ChosenOption, DiningTable, Hall, ItemOption, Menu, MenuItem, OptionGroup, Order, OrderLine, PaidOrder, PaymentMethod } from '../lib/types'
import { money } from '../lib/format'
import CheckoutDialog from './CheckoutDialog'
import ReceiptDialog from './ReceiptDialog'
import KitchenTicketsDialog from './KitchenTicketsDialog'
import { dispatchTickets, type SendResult } from '../lib/kitchen'
import { useDialog } from './Dialog'
import LangToggle from './LangToggle'
import { useI18n } from '../lib/i18n'

interface Props {
  table: DiningTable
  hall: Hall
  /** Opens the checkout as soon as the order is loaded (checkout started from the floor plan). */
  startCheckout?: boolean
  onBack(): void
}

const sameOptions = (a: ChosenOption[], b: ChosenOption[]) =>
  a.length === b.length && a.every((o, i) => o.group === b[i].group && o.name === b[i].name)

const chosen = (g: OptionGroup, o: ItemOption): ChosenOption => ({ group: g.name, name: o.name, price_delta: o.price_delta })
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

export default function OrderScreen({ table, hall, startCheckout, onBack }: Props) {
  const [menu, setMenu] = useState<Menu | null>(null)
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [order, setOrder] = useState<Order | null>(null)
  const [lines, setLines] = useState<OrderLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [paying, setPaying] = useState(false)
  const [paid, setPaid] = useState<{ order: PaidOrder; lines: OrderLine[] } | null>(null)
  /** Result of the last Valider, shown as kitchen ticket previews. */
  const [sent, setSent] = useState<(SendResult & { sentCount: number }) | null>(null)
  // Line that supplement buttons apply to: the one last added, or the one tapped in the order.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const opening = useRef<Promise<Order> | null>(null)
  const dialog = useDialog()
  const { t } = useI18n()

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      setError(null)
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const reloadOrder = useCallback(async () => {
    await run(async () => {
      const current = await repo.getOpenOrder(table.id)
      setOrder(current?.order ?? null)
      setLines(current?.lines ?? [])
    })
  }, [run, table.id])

  useEffect(() => {
    ;(async () => {
      await run(async () => {
        const m = await repo.getMenu()
        setMenu(m)
        setCategoryId((id) => id ?? m.categories[0]?.id ?? null)
      })
      await reloadOrder()
      setLoading(false)
      if (startCheckout) setPaying(true)
    })()
    // Only on first load: a different table remounts this screen (keyed by table id).
  }, [])

  useEffect(() => repo.subscribeOrders(() => reloadOrder()), [reloadOrder])

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
  const total = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0)
  const count = lines.reduce((s, l) => s + l.quantity, 0)
  const newCount = lines.reduce((s, l) => s + (l.sent_at ? 0 : l.quantity), 0)
  const selectedSent = !!selected?.sent_at
  const anySent = lines.some((l) => l.sent_at)

  async function ensureOrder(): Promise<Order> {
    if (order) return order
    // Two quick taps must not open two orders.
    opening.current ??= repo.openOrder(table.id).finally(() => {
      opening.current = null
    })
    const o = await opening.current
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
      if (last && !last.sent_at && !last.note && sameOptions(last.options, options)) {
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
    const twin = lines.find((l) => !l.sent_at && l.item_id === line.item_id && l.name === line.name && l.note === line.note && sameOptions(l.options, line.options))
    setBusy(true)
    await run(async () => {
      if (twin) {
        await repo.updateLine(twin.id, { quantity: twin.quantity + 1 })
        setSelectedId(twin.id)
      } else {
        const o = await ensureOrder()
        const copy = await repo.addLine(o.id, { item_id: line.item_id, name: line.name, unit_price: line.unit_price, quantity: 1, options: line.options, note: line.note })
        setSelectedId(copy.id)
      }
      await reloadOrder()
    })
    setBusy(false)
  }

  /** Valider: sends the new lines to the kitchen and shows each printer's ticket. The order stays open. */
  async function validate() {
    if (!order || newCount === 0) return
    setBusy(true)
    await run(async () => {
      const result = await repo.sendOrder(order.id, table.label)
      await reloadOrder()
      if (!result.tickets.length && !result.unrouted.length) throw new Error(t.nothingToSend)
      const printers = result.tickets.length ? await repo.listPrinters() : []
      const left = await dispatchTickets(result.tickets, printers)
      setSent({ tickets: left, unrouted: result.unrouted, sentCount: result.tickets.length })
    })
    setBusy(false)
  }

  const clock = (iso: string) => new Date(iso).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

  async function editNote(line: OrderLine) {
    if (line.sent_at) return
    const note = await dialog.askText(t.noteFor(line.name), t.save)
    if (note === null) return
    await run(() => repo.updateLine(line.id, { note }))
    await reloadOrder()
  }

  async function cancelOrder() {
    if (!order) return
    if (!(await dialog.confirm(t.confirmCancelOrder(table.label), t.cancelOrder))) return
    await run(async () => {
      await repo.cancelOrder(order.id)
      onBack()
    })
  }

  async function pay(method: PaymentMethod, received: number | null) {
    if (!order) return
    const snapshot = lines
    setBusy(true)
    await run(async () => {
      const done = await repo.checkoutOrder(order.id, method, received)
      setPaying(false)
      setPaid({ order: done, lines: snapshot })
    })
    setBusy(false)
  }

  async function back() {
    // An order that was opened but never got an item should not keep the table occupied.
    if (order && lines.length === 0) await run(() => repo.cancelOrder(order.id))
    onBack()
  }

  return (
    <div className="app order-screen">
      <header className="topbar">
        <button className="ghost back" onClick={back} aria-label={t.backToFloor}>{t.back}</button>
        <div className="order-title">
          <strong>{t.table(table.label)}</strong>
          <span><bdi>{hall.name}</bdi> · {t.seatsCount(table.seats)}</span>
        </div>
        <div className="spacer" />
        {order && <span className="pill occupied">{t.openOrder}</span>}
        <LangToggle />
      </header>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}

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
          <section className="menu-area">
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
                  {lines.map((l) => (
                    <li key={l.id} className={l.id === selectedId ? 'line on' : 'line'} onClick={() => setSelectedId(l.id)} aria-selected={l.id === selectedId}>
                      <div className="line-main">
                        <span className="line-name">{l.name}</span>
                        <span className="line-total">{money(l.unit_price * l.quantity)}</span>
                      </div>
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
                        {!l.sent_at && <button className="note-btn" onClick={() => editNote(l)} title={t.addNote} aria-label={t.addNote}>✎</button>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="ticket-total">
                <span>{t.total}</span>
                <strong>{money(total)}</strong>
              </div>
              {lines.length > 0 && (
                <button className="validate-btn" onClick={validate} disabled={busy || newCount === 0} title={t.validateHint}>
                  {newCount > 0 ? t.validateCount(newCount) : t.validate}
                </button>
              )}
              {lines.length > 0 && (
                <button className="primary checkout-btn" onClick={() => setPaying(true)}>{t.checkoutAmount(money(total))}</button>
              )}
              <button onClick={back}>{t.doneBack}</button>
              {order && <button className="danger" onClick={cancelOrder}>{t.cancelOrder}</button>}
            </div>
          </aside>
        </main>
      )}

      {paying && order && lines.length > 0 && (
        <CheckoutDialog tableLabel={table.label} total={total} busy={busy} onCancel={() => setPaying(false)} onPay={pay} />
      )}
      {paid && (
        <ReceiptDialog order={paid.order} lines={paid.lines} tableLabel={table.label} hallName={hall.name} onDone={onBack} />
      )}
      {sent && (
        <KitchenTicketsDialog tickets={sent.tickets} sentCount={sent.sentCount} unrouted={sent.unrouted} onClose={() => setSent(null)} />
      )}
      {dialog.element}
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { repo } from '../lib/repo'
import type { ChosenOption, DiningTable, Hall, ItemOption, Menu, MenuItem, OptionGroup, Order, OrderLine, PaidOrder, PaymentMethod } from '../lib/types'
import { money } from '../lib/format'
import CheckoutDialog from './CheckoutDialog'
import ReceiptDialog from './ReceiptDialog'
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

/** Keeps a line's options in menu order (group, then option), so equal choices compare equal. */
function menuOrder(groups: OptionGroup[], options: ChosenOption[]): ChosenOption[] {
  const rank = (c: ChosenOption) => {
    const gi = groups.findIndex((g) => g.name === c.group)
    const oi = gi < 0 ? -1 : groups[gi].options.findIndex((o) => o.name === c.name)
    return gi < 0 ? Infinity : gi * 1000 + oi
  }
  return [...options].sort((a, b) => rank(a) - rank(b))
}

/** The item's first required pick-one group (Taille…): each of its options is a button that adds the item. */
const mainGroup = (groups: OptionGroup[]) => groups.find((g) => g.min_select >= 1 && g.max_select === 1 && g.options.length > 0)

/** Options of a new line: the tapped size, and the first option of any other required pick-one group. */
function defaultOptions(groups: OptionGroup[], main?: OptionGroup, picked?: ItemOption): ChosenOption[] {
  return groups.flatMap((g) => {
    if (g === main && picked) return [chosen(g, picked)]
    return g.min_select >= 1 && g.max_select === 1 && g.options[0] ? [chosen(g, g.options[0])] : []
  })
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
  // The order summary is its own view: after adding an item the waiter stays on the menu to keep adding.
  const [view, setView] = useState<'menu' | 'order'>(startCheckout ? 'order' : 'menu')
  const [lastAdded, setLastAdded] = useState<{ text: string; key: number } | null>(null)
  const opening = useRef<Promise<Order> | null>(null)
  // Line each item was last added to: supplements tapped on the item's card apply to it.
  const lastLineOf = useRef<Record<string, string>>({})
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

  useEffect(() => {
    if (!lastAdded) return
    const timer = setTimeout(() => setLastAdded(null), 2000)
    return () => clearTimeout(timer)
  }, [lastAdded])

  const items = useMemo(() => menu?.items.filter((i) => i.category_id === categoryId) ?? [], [menu, categoryId])
  const total = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0)
  const count = lines.reduce((s, l) => s + l.quantity, 0)

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

  /** Adds one portion of the item (with its size…) as a new line, or one more on an identical line. */
  async function addToOrder(item: MenuItem, options: ChosenOption[], label = item.name) {
    setBusy(true)
    await run(async () => {
      const o = await ensureOrder()
      const same = lines.find((l) => l.item_id === item.id && !l.note && sameOptions(l.options, options))
      if (same) {
        await repo.updateLine(same.id, { quantity: same.quantity + 1 })
        lastLineOf.current[item.id] = same.id
      } else {
        const unit_price = item.price + options.reduce((s, x) => s + x.price_delta, 0)
        const line = await repo.addLine(o.id, { item_id: item.id, name: item.name, unit_price, quantity: 1, options, note: null })
        lastLineOf.current[item.id] = line.id
      }
      await reloadOrder()
      setLastAdded({ text: t.added(label), key: Date.now() })
    })
    setBusy(false)
  }

  /** Line a supplement tapped on this item's card applies to: the one last added, else the item's latest line. */
  function targetLine(itemId: string): OrderLine | undefined {
    const id = lastLineOf.current[itemId]
    return lines.find((l) => l.id === id) ?? lines.filter((l) => l.item_id === itemId).at(-1)
  }

  /** Switches a supplement (Gratiné, Garniture…) on or off on the item's last line, or adds the item with it. */
  async function toggleSupplement(item: MenuItem, groups: OptionGroup[], g: OptionGroup, opt: ItemOption) {
    const line = targetLine(item.id)
    if (!line) return addToOrder(item, menuOrder(groups, [...defaultOptions(groups), chosen(g, opt)]), `${item.name} + ${opt.name}`)
    const on = isChosen(line.options, g, opt)
    const inGroup = line.options.filter((c) => c.group === g.name)
    let options: ChosenOption[]
    if (on) {
      if (inGroup.length <= g.min_select) return
      options = line.options.filter((c) => !(c.group === g.name && c.name === opt.name))
    } else if (g.max_select === 1) {
      options = [...line.options.filter((c) => c.group !== g.name), chosen(g, opt)]
    } else {
      if (inGroup.length >= g.max_select) return
      options = [...line.options, chosen(g, opt)]
    }
    options = menuOrder(groups, options)
    const delta = (xs: ChosenOption[]) => xs.reduce((s, x) => s + x.price_delta, 0)
    const unit_price = line.unit_price - delta(line.options) + delta(options)
    setBusy(true)
    await run(async () => {
      if (line.quantity > 1) {
        // Only one of the portions changes: it becomes its own line.
        await repo.updateLine(line.id, { quantity: line.quantity - 1 })
        const added = await repo.addLine(line.order_id, { item_id: item.id, name: line.name, unit_price, quantity: 1, options, note: line.note })
        lastLineOf.current[item.id] = added.id
      } else {
        await repo.updateLine(line.id, { options, unit_price })
      }
      await reloadOrder()
      setLastAdded({ text: on ? t.supplementRemoved(opt.name, item.name) : t.supplementAdded(opt.name, item.name), key: Date.now() })
    })
    setBusy(false)
  }

  async function changeQty(line: OrderLine, delta: number) {
    const quantity = line.quantity + delta
    setLines((ls) => (quantity > 0 ? ls.map((l) => (l.id === line.id ? { ...l, quantity } : l)) : ls.filter((l) => l.id !== line.id)))
    await run(() => (quantity > 0 ? repo.updateLine(line.id, { quantity }) : repo.deleteLine(line.id)))
    await reloadOrder()
  }

  async function editNote(line: OrderLine) {
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

  function openView(v: 'menu' | 'order') {
    setView(v)
    window.scrollTo({ top: 0 })
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
          {view === 'menu' ? (
          <section className="menu-area">
            <nav className="categories" aria-label={t.categories}>
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
            {menu && menu.categories.length === 0 ? (
              <div className="card empty">
                <p>{t.emptyMenu}</p>
              </div>
            ) : (
              <div className="items-grid">
                {items.map((i) => {
                  const groups = menu?.groups[i.id] ?? []
                  if (groups.length === 0) {
                    return (
                      <button key={i.id} className="item-card" onClick={() => addToOrder(i, [])} disabled={busy}>
                        <span className="item-name">{i.name}</span>
                        <span className="item-price">{money(i.price)}</span>
                      </button>
                    )
                  }
                  const main = mainGroup(groups)
                  const target = targetLine(i.id)
                  return (
                    <div key={i.id} className="item-card with-options">
                      {main ? (
                        <>
                          <span className="item-name">{i.name}</span>
                          <div className="size-btns">
                            {main.options.map((o) => (
                              <button key={o.id} className="size-btn" disabled={busy}
                                onClick={() => addToOrder(i, defaultOptions(groups, main, o), `${i.name} ${o.name}`)}>
                                <span className="size-name">{o.name}</span>
                                <span className="size-price">{money(i.price + o.price_delta)}</span>
                              </button>
                            ))}
                          </div>
                        </>
                      ) : (
                        <button className="size-btn item-base" disabled={busy} onClick={() => addToOrder(i, defaultOptions(groups))}>
                          <span className="size-name">{i.name}</span>
                          <span className="size-price">{money(i.price)}</span>
                        </button>
                      )}
                      {groups.filter((g) => g !== main).map((g) => (
                        <div key={g.id} className="supp-group">
                          <span className="supp-label">{g.name}</span>
                          <div className="supp-btns">
                            {g.options.map((o) => {
                              const on = !!target && isChosen(target.options, g, o)
                              return (
                                <button key={o.id} className={on ? 'supp-btn on' : 'supp-btn'} aria-pressed={on} disabled={busy}
                                  onClick={() => toggleSupplement(i, groups, g, o)}>
                                  {o.name}
                                  {o.price_delta !== 0 && <span className="small"> <bdi dir="ltr">{o.price_delta > 0 ? '+' : ''}{money(o.price_delta)}</bdi></span>}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                })}
                {items.length === 0 && <p className="muted">{t.noItemsInCategory}</p>}
              </div>
            )}
          </section>
          ) : (
          <aside className="ticket">
            <div className="panel">
              <button className="back-to-menu" onClick={() => openView('menu')}>{t.backToMenu}</button>
              <div className="panel-head">
                <h2>{t.order}</h2>
                <span className="muted small">{t.itemCount(count)}</span>
              </div>
              {lines.length === 0 ? (
                <p className="muted small">{t.orderHint}</p>
              ) : (
                <ul className="lines">
                  {lines.map((l) => (
                    <li key={l.id} className="line">
                      <div className="line-main">
                        <button className="ghost line-name" onClick={() => editNote(l)} title={t.addNote}>{l.name}</button>
                        <span className="line-total">{money(l.unit_price * l.quantity)}</span>
                      </div>
                      {(l.options.length > 0 || l.note) && (
                        <div className="line-details">
                          {l.options.map((o) => o.name).join(t.listSep)}
                          {l.note && <em> · {l.note}</em>}
                        </div>
                      )}
                      <div className="stepper">
                        <button onClick={() => changeQty(l, -1)} aria-label={t.decrease}>−</button>
                        <span>{l.quantity}</span>
                        <button onClick={() => changeQty(l, 1)} aria-label={t.increase}>+</button>
                        <span className="muted small">× {money(l.unit_price)}</span>
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
                <button className="primary checkout-btn" onClick={() => setPaying(true)}>{t.checkoutAmount(money(total))}</button>
              )}
              <button onClick={back}>{t.doneBack}</button>
              {order && <button className="danger" onClick={cancelOrder}>{t.cancelOrder}</button>}
            </div>
          </aside>
          )}

          {view === 'menu' && lines.length > 0 && (
            <button className="ticket-bar primary" onClick={() => openView('order')}>
              {lastAdded && <span key={lastAdded.key} className="added-flash">✓ {lastAdded.text}</span>}
              <span>{t.showOrder} · {t.itemCount(count)} · {money(total)}</span>
            </button>
          )}
        </main>
      )}

      {paying && order && lines.length > 0 && (
        <CheckoutDialog tableLabel={table.label} total={total} busy={busy} onCancel={() => setPaying(false)} onPay={pay} />
      )}
      {paid && (
        <ReceiptDialog order={paid.order} lines={paid.lines} tableLabel={table.label} hallName={hall.name} onDone={onBack} />
      )}
      {dialog.element}
    </div>
  )
}

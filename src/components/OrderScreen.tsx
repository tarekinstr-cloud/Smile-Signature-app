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

/** Choices on an item card before they are added: picked option ids, a quantity per size and per supplement. */
interface Draft {
  picked: string[]
  qty: Record<string, number>
  supp: Record<string, number>
}

/** One order line to add: its options and how many. */
interface Part {
  options: ChosenOption[]
  quantity: number
}

/** The item's first required pick-one group (Taille…): each of its options is a row with its price and a quantity. */
const mainGroup = (groups: OptionGroup[]) => groups.find((g) => g.min_select >= 1 && g.max_select === 1 && g.options.length > 0)

/** Optional groups (Gratiné, Garniture…): each option gets its own quantity, one per portion of the item. */
const isSupplement = (g: OptionGroup, main?: OptionGroup) => g !== main && g.min_select === 0

const selectedSize = (d: Draft, main?: OptionGroup) => main?.options.find((o) => d.picked.includes(o.id))
const draftQuantity = (d: Draft, main?: OptionGroup) => d.qty[selectedSize(d, main)?.id ?? ''] ?? 1
const suppTotal = (d: Draft) => Object.values(d.supp).reduce((s, n) => s + n, 0)

/** Lowers supplement quantities (last ones first) so they never exceed the item's quantity. */
function fitSupplements(d: Draft, main?: OptionGroup): Draft {
  let over = suppTotal(d) - draftQuantity(d, main)
  if (over <= 0) return d
  const supp = { ...d.supp }
  for (const id of Object.keys(supp).reverse()) {
    const cut = Math.min(over, supp[id])
    supp[id] -= cut
    over -= cut
    if (!supp[id]) delete supp[id]
  }
  return { ...d, supp }
}

/**
 * Splits the card's choices into order lines: one line per supplement with its quantity,
 * and the portions left without a supplement on a plain line. E.g. 3× M with Gratiné ×2
 * gives "M + Gratiné" ×2 and "M" ×1.
 */
function planDraft(item: MenuItem, groups: OptionGroup[], main: OptionGroup | undefined, d: Draft) {
  const quantity = draftQuantity(d, main)
  const base = groups
    .filter((g) => !isSupplement(g, main))
    .flatMap((g) => g.options.filter((o) => d.picked.includes(o.id)).map((o) => chosen(g, o)))
  const parts: Part[] = []
  let left = quantity
  for (const g of groups) {
    if (!isSupplement(g, main)) continue
    for (const o of g.options) {
      const n = Math.min(d.supp[o.id] ?? 0, left)
      if (n <= 0) continue
      parts.push({ options: groups.flatMap((h) => (h === g ? [chosen(g, o)] : base.filter((c) => c.group === h.name))), quantity: n })
      left -= n
    }
  }
  if (left > 0) parts.unshift({ options: base, quantity: left })
  const total = parts.reduce((s, p) => s + (item.price + p.options.reduce((x, c) => x + c.price_delta, 0)) * p.quantity, 0)
  return { size: selectedSize(d, main), quantity, parts, total }
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
  // What is being picked on each item card (size, quantity per size, supplements) before "Ajouter".
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
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

  /** Adds the item as these lines, each merged into an identical line when there is one. */
  async function addToOrder(item: MenuItem, parts: Part[], label = item.name) {
    setBusy(true)
    await run(async () => {
      const o = await ensureOrder()
      for (const { options, quantity } of parts) {
        const same = lines.find((l) => l.item_id === item.id && !l.note && sameOptions(l.options, options))
        if (same) {
          await repo.updateLine(same.id, { quantity: same.quantity + quantity })
        } else {
          const unit_price = item.price + options.reduce((s, x) => s + x.price_delta, 0)
          await repo.addLine(o.id, { item_id: item.id, name: item.name, unit_price, quantity, options, note: null })
        }
      }
      await reloadOrder()
      const quantity = parts.reduce((s, p) => s + p.quantity, 0)
      setLastAdded({ text: t.added(quantity > 1 ? `${quantity}× ${label}` : label), key: Date.now() })
    })
    setBusy(false)
  }

  /** A card starts on the first size and the first option of every other required pick-one group, quantity 1. */
  function draftOf(item: MenuItem, groups: OptionGroup[]): Draft {
    return (
      drafts[item.id] ?? {
        picked: groups.flatMap((g) => (g.min_select >= 1 && g.max_select === 1 && g.options[0] ? [g.options[0].id] : [])),
        qty: {},
        supp: {},
      }
    )
  }

  function setDraft(item: MenuItem, groups: OptionGroup[], change: (d: Draft) => Draft) {
    const main = mainGroup(groups)
    setDrafts((ds) => ({ ...ds, [item.id]: fitSupplements(change(ds[item.id] ?? draftOf(item, groups)), main) }))
  }

  /** Picks an option of a required group on the card: pick-one groups switch, others toggle within their limit. */
  function pick(item: MenuItem, groups: OptionGroup[], g: OptionGroup, opt: ItemOption) {
    setDraft(item, groups, (d) => {
      const inGroup = d.picked.filter((id) => g.options.some((o) => o.id === id))
      if (d.picked.includes(opt.id)) {
        return inGroup.length <= g.min_select ? d : { ...d, picked: d.picked.filter((id) => id !== opt.id) }
      }
      if (g.max_select === 1) return { ...d, picked: [...d.picked.filter((id) => !inGroup.includes(id)), opt.id] }
      return inGroup.length >= g.max_select ? d : { ...d, picked: [...d.picked, opt.id] }
    })
  }

  function stepQty(item: MenuItem, groups: OptionGroup[], sizeId: string, delta: number) {
    setDraft(item, groups, (d) => ({ ...d, qty: { ...d.qty, [sizeId]: Math.max(1, (d.qty[sizeId] ?? 1) + delta) } }))
  }

  /** Changes a supplement's quantity; all supplements together stay within the item's quantity. */
  function stepSupp(item: MenuItem, groups: OptionGroup[], optionId: string, delta: number) {
    setDraft(item, groups, (d) => {
      const n = (d.supp[optionId] ?? 0) + delta
      if (n < 0 || (delta > 0 && suppTotal(d) >= draftQuantity(d, mainGroup(groups)))) return d
      const { [optionId]: _, ...rest } = d.supp
      return { ...d, supp: n > 0 ? { ...rest, [optionId]: n } : rest }
    })
  }

  /** Adds the card's choices in one go, split into lines per supplement, then puts the card back to its start. */
  async function addDraft(item: MenuItem, groups: OptionGroup[], main?: OptionGroup) {
    const { parts, size } = planDraft(item, groups, main, draftOf(item, groups))
    setDrafts(({ [item.id]: _, ...rest }) => rest)
    await addToOrder(item, parts, size ? `${item.name} ${size.name}` : item.name)
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
                      <button key={i.id} className="item-card" onClick={() => addToOrder(i, [{ options: [], quantity: 1 }])} disabled={busy}>
                        <span className="item-name">{i.name}</span>
                        <span className="item-price">{money(i.price)}</span>
                      </button>
                    )
                  }
                  const main = mainGroup(groups)
                  const d = draftOf(i, groups)
                  const { size, quantity, total } = planDraft(i, groups, main, d)
                  const suppFull = suppTotal(d) >= quantity
                  return (
                    <div key={i.id} className="item-card with-options">
                      <span className="item-name">{i.name}</span>
                      {main ? (
                        <div className="size-rows">
                          {main.options.map((o) => {
                            const on = d.picked.includes(o.id)
                            const q = d.qty[o.id] ?? 1
                            return (
                              <div key={o.id} className={on ? 'size-row on' : 'size-row'}>
                                <button className="size-btn" aria-pressed={on} onClick={() => pick(i, groups, main, o)}>
                                  <span className="size-name">{o.name}</span>
                                  <span className="size-price">{money(i.price + o.price_delta)}</span>
                                </button>
                                <div className="stepper">
                                  <button onClick={() => { pick(i, groups, main, o); stepQty(i, groups, o.id, -1) }} disabled={q <= 1} aria-label={t.decrease}>−</button>
                                  <span>{q}</span>
                                  <button onClick={() => { if (!on) pick(i, groups, main, o); stepQty(i, groups, o.id, 1) }} aria-label={t.increase}>+</button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <div className="size-row on">
                          <span className="size-price">{money(i.price)}</span>
                          <div className="stepper">
                            <button onClick={() => stepQty(i, groups, '', -1)} disabled={quantity <= 1} aria-label={t.decrease}>−</button>
                            <span>{quantity}</span>
                            <button onClick={() => stepQty(i, groups, '', 1)} aria-label={t.increase}>+</button>
                          </div>
                        </div>
                      )}
                      {groups.filter((g) => g !== main).map((g) => (
                        <div key={g.id} className="supp-group">
                          <span className="supp-label">{g.name}</span>
                          {isSupplement(g, main) ? (
                            <div className="supp-rows">
                              {g.options.map((o) => {
                                const n = d.supp[o.id] ?? 0
                                return (
                                  <div key={o.id} className={n > 0 ? 'supp-row on' : 'supp-row'}>
                                    <span className="supp-name">
                                      <bdi>{o.name}</bdi>
                                      {o.price_delta !== 0 && <span className="small"> <bdi dir="ltr">{o.price_delta > 0 ? '+' : ''}{money(o.price_delta)}</bdi></span>}
                                    </span>
                                    <div className="stepper">
                                      <button onClick={() => stepSupp(i, groups, o.id, -1)} disabled={n <= 0} aria-label={t.decrease}>−</button>
                                      <span>{n}</span>
                                      <button onClick={() => stepSupp(i, groups, o.id, 1)} disabled={suppFull} aria-label={t.increase}>+</button>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          ) : (
                            <div className="supp-btns">
                              {g.options.map((o) => {
                                const on = d.picked.includes(o.id)
                                return (
                                  <button key={o.id} className={on ? 'supp-btn on' : 'supp-btn'} aria-pressed={on} onClick={() => pick(i, groups, g, o)}>
                                    {o.name}
                                    {o.price_delta !== 0 && <span className="small"> <bdi dir="ltr">{o.price_delta > 0 ? '+' : ''}{money(o.price_delta)}</bdi></span>}
                                  </button>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      ))}
                      <button className="primary add-draft" disabled={busy || (!!main && !size)} onClick={() => addDraft(i, groups, main)}>
                        {t.add} {quantity}×{size && <> <bdi>{size.name}</bdi></>} · <bdi dir="ltr">{money(total)}</bdi>
                      </button>
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

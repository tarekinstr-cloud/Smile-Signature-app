import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { repo } from '../lib/repo'
import type { ChosenOption, DiningTable, Hall, Menu, MenuItem, Order, OrderLine, PaidOrder, PaymentMethod } from '../lib/types'
import { money } from '../lib/format'
import ItemOptionsDialog from './ItemOptionsDialog'
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

export default function OrderScreen({ table, hall, startCheckout, onBack }: Props) {
  const [menu, setMenu] = useState<Menu | null>(null)
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [order, setOrder] = useState<Order | null>(null)
  const [lines, setLines] = useState<OrderLine[]>([])
  const [configuring, setConfiguring] = useState<MenuItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [paying, setPaying] = useState(false)
  const [paid, setPaid] = useState<{ order: PaidOrder; lines: OrderLine[] } | null>(null)
  // The order summary is its own view: after adding an item the waiter stays on the menu to keep adding.
  const [view, setView] = useState<'menu' | 'order'>(startCheckout ? 'order' : 'menu')
  const [lastAdded, setLastAdded] = useState<{ name: string; key: number } | null>(null)
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

  async function addToOrder(item: MenuItem, options: ChosenOption[], quantity: number, note: string | null) {
    setBusy(true)
    await run(async () => {
      const o = await ensureOrder()
      const same = !note && lines.find((l) => l.item_id === item.id && !l.note && sameOptions(l.options, options))
      if (same) {
        await repo.updateLine(same.id, { quantity: same.quantity + quantity })
      } else {
        const unit_price = item.price + options.reduce((s, x) => s + x.price_delta, 0)
        await repo.addLine(o.id, { item_id: item.id, name: item.name, unit_price, quantity, options, note })
      }
      await reloadOrder()
      setView('menu')
      setLastAdded({ name: item.name, key: Date.now() })
    })
    setBusy(false)
  }

  function tapItem(item: MenuItem) {
    if (menu?.groups[item.id]?.length) setConfiguring(item)
    else addToOrder(item, [], 1, null)
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
                {items.map((i) => (
                  <button key={i.id} className="item-card" onClick={() => tapItem(i)} disabled={busy}>
                    <span className="item-name">{i.name}</span>
                    {menu?.groups[i.id]?.length ? <span className="item-has-options">{t.hasOptions}</span> : null}
                    <span className="item-price">{money(i.price)}</span>
                  </button>
                ))}
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
              {lastAdded && <span key={lastAdded.key} className="added-flash">✓ {t.added(lastAdded.name)}</span>}
              <span>{t.showOrder} · {t.itemCount(count)} · {money(total)}</span>
            </button>
          )}
        </main>
      )}

      {configuring && menu && (
        <ItemOptionsDialog
          item={configuring}
          groups={menu.groups[configuring.id] ?? []}
          onCancel={() => setConfiguring(null)}
          onAdd={(options, quantity, note) => {
            const item = configuring
            setConfiguring(null)
            addToOrder(item, options, quantity, note)
          }}
        />
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

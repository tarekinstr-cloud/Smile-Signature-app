import { useEffect } from 'react'
import type { OpenOrder } from '../lib/repo'
import type { DeliveryStatus, FloorConfig, Order, PickupStatus } from '../lib/types'
import { computeBill } from '../lib/billing'
import { money } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { minutesSince, useServerNow } from '../lib/serverClock'
import { timerLevel } from './FloorPlan'

const PICKUP_STEPS: PickupStatus[] = ['preparing', 'ready', 'handed']
const DELIVERY_STEPS: DeliveryStatus[] = ['preparing', 'on_the_way', 'delivered']

interface Props {
  type: 'takeaway' | 'delivery'
  /** Open orders, and for À emporter the paid ones not handed yet. */
  orders: OpenOrder[]
  timer: FloorConfig
  onNew(): void
  onOpen(order: Order): void
  onPickup(order: Order, status: PickupStatus): void
  onDelivery(order: Order, status: DeliveryStatus): void
  onClose(): void
}

/**
 * Commandes à emporter / Livraison: the running orders as a grid of cards, oldest first, like the tables of a hall:
 * big number to call out, customer, items, amount, status, waiter and the waiting time (server clock, same colours and
 * thresholds as the tables). « Prête » makes the card stand out so the customer is called.
 */
export default function OrdersBoard({ type, orders, timer, onNew, onOpen, onPickup, onDelivery, onClose }: Props) {
  const { t } = useI18n()
  const now = useServerNow()
  const list = [...orders].sort((a, b) => a.order.created_at.localeCompare(b.order.created_at))
  const delivery = type === 'delivery'
  // Escape closes the board wherever the focus is (a status button re-rendered under the finger loses it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog orders-board" role="dialog" aria-modal="true" aria-labelledby="board-title">
        <div className="panel-head">
          <h2 id="board-title">{delivery ? t.deliveryOrders : t.takeawayOrders} <span className="muted">({list.length})</span></h2>
          <button className="ghost" onClick={onClose} aria-label={t.close}>✕</button>
        </div>
        <button className="primary big board-new" autoFocus onClick={onNew}>{delivery ? t.newDelivery : t.newTakeaway}</button>
        {list.length === 0 ? (
          <p className="muted small">{delivery ? t.noDeliveries : t.noTakeaways}</p>
        ) : (
          <div className="board-grid">
            {list.map(({ order, lines, payments }) => {
              const paid = order.status === 'paid'
              const bill = computeBill(order, lines, payments)
              const minutes = minutesSince(order.created_at, now)
              const no = delivery ? order.delivery_no : order.takeaway_no
              const who = [order.customer_name, delivery ? order.customer_phone : null].filter(Boolean).join(' · ')
              const status = delivery ? order.delivery_status ?? 'preparing' : order.pickup_status ?? 'preparing'
              const items = lines.reduce((s, l) => s + l.quantity, 0)
              return (
                <article key={order.id} className={`board-card ${delivery ? 'delivery' : 'takeaway'} status-${status}${paid ? ' paid' : ''}`}>
                  <button type="button" className="board-open" onClick={() => !paid && onOpen(order)} disabled={paid}
                    aria-label={`${delivery ? t.deliveryNo(String(no ?? '')) : t.takeawayNo(String(no ?? ''))}${who ? ` · ${who}` : ''}`}>
                    <span className="board-no">
                      {delivery ? t.deliveryShort(String(no ?? '?')) : t.takeawayShort(String(no ?? '?'))}
                      {order.guests ? <span className="board-guests"> · {order.guests} 👤</span> : null}
                    </span>
                    <span className={`table-timer ${timerLevel(minutes, timer)}`}>⏱ {t.floorMinutes(minutes)}</span>
                    {who ? <bdi className="board-who">{who}</bdi> : delivery ? <span className="board-who muted">{t.boardNoName}</span> : null}
                    <span className="board-meta">
                      <span>{t.itemCount(items)}</span>
                      <strong>{paid ? money(bill.total) : money(bill.remaining)}</strong>
                    </span>
                    <span className="board-meta muted small">
                      <span>{order.created_by_name ? <bdi>{order.created_by_name}</bdi> : ''}</span>
                      {paid ? <span className="tag pay-status paid">{t.boardPaid}</span> : bill.paid > 0 ? <span className="tag">{t.boardPartPaid}</span> : null}
                    </span>
                  </button>
                  <div className="segmented board-status" role="group" aria-label={delivery ? t.deliveryStatus : t.pickupStatus}>
                    {delivery
                      ? DELIVERY_STEPS.map((s) => (
                          <button key={s} type="button" className={status === s ? 'on' : ''} aria-pressed={status === s}
                            title={t.deliveryStatuses[s]} onClick={() => status !== s && onDelivery(order, s)}>{t.deliveryStepShort[s]}</button>
                        ))
                      : PICKUP_STEPS.map((s) => (
                          <button key={s} type="button" className={status === s ? 'on' : ''} aria-pressed={status === s}
                            title={t.pickupStatuses[s]} onClick={() => status !== s && onPickup(order, s)}>{t.pickupStepShort[s]}</button>
                        ))}
                  </div>
                </article>
              )
            })}
          </div>
        )}
        {!delivery && <p className="muted small">{t.boardTakeawayHint}</p>}
      </div>
    </div>
  )
}

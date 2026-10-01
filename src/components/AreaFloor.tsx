import type { OpenOrder } from '../lib/repo'
import type { FloorConfig, Order, OrderArea } from '../lib/types'
import { computeBill } from '../lib/billing'
import { money } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { minutesSince, useServerNow } from '../lib/serverClock'
import { timerLevel } from './FloorPlan'

/** À emporter: a customer standing with a bag, seen from the front. */
function PersonIcon() {
  return (
    <svg className="area-svg" viewBox="0 0 64 64" aria-hidden focusable="false">
      <circle className="fig-fill" cx="30" cy="14" r="9" />
      <path className="fig-fill" d="M17 58 V34 q0-10 13-10 q13 0 13 10 V58 h-7 V40 h-2 V58 h-8 V40 h-2 V58 Z" />
      <rect className="fig-accent" x="42" y="36" width="13" height="15" rx="2" />
      <path className="fig-line" d="M45 36 q3.5-6 7 0" fill="none" />
    </svg>
  )
}

/** Livraison: a delivery scooter seen from the side, with its box on the back. */
function ScooterIcon() {
  return (
    <svg className="area-svg" viewBox="0 0 72 56" aria-hidden focusable="false">
      <rect className="fig-accent" x="5" y="9" width="19" height="16" rx="2" />
      <path className="fig-fill" d="M6 40 C6 31 12 28 20 28 H35 L39 37 H50 L52 41 H6 Z" />
      <rect className="fig-seat" x="13" y="24.5" width="19" height="4.5" rx="2.2" />
      <path className="fig-line" d="M50 39 L55 15" fill="none" />
      <path className="fig-line" d="M50 15 H60" fill="none" />
      <path className="fig-fill" d="M51 37 Q57 33 63 38 V41 H51 Z" />
      <circle className="fig-wheel" cx="16" cy="45" r="7" />
      <circle className="fig-wheel" cx="58" cy="45" r="7" />
      <circle className="fig-hub" cx="16" cy="45" r="2.5" />
      <circle className="fig-hub" cx="58" cy="45" r="2.5" />
    </svg>
  )
}

interface Props {
  area: OrderArea
  /** Open orders, and for À emporter the paid ones not handed yet. */
  orders: OpenOrder[]
  config: FloorConfig
  onNew(): void
  onOpen(order: Order): void
}

/**
 * À emporter / Livraison shown like a hall (inspired by i-Restaurant): a full-screen view on its own background picture,
 * one drawn icon per running order (a customer for À emporter, a scooter for Livraison), oldest first, with its number,
 * people, waiting timer (server clock, same colours as the tables), and for a delivery the driver and status. « Prête »
 * makes the icon blink. The big « + » starts a new order.
 */
export default function AreaFloor({ area, orders, config, onNew, onOpen }: Props) {
  const { t } = useI18n()
  const now = useServerNow()
  const delivery = area === 'delivery'
  const bg = delivery ? config.delivery_background_url : config.takeaway_background_url
  const list = [...orders].sort((a, b) => a.order.created_at.localeCompare(b.order.created_at))

  return (
    <section className={`area-floor ${area}${bg ? ' has-bg' : ''}`} style={bg ? { backgroundImage: `url("${bg.replace(/"/g, '%22')}")` } : undefined}
      aria-label={delivery ? t.deliveryOrders : t.takeawayOrders}>
      <div className="area-grid">
        <button type="button" className="area-item area-new" onClick={onNew} aria-label={delivery ? t.newDelivery : t.newTakeaway}>
          <span className="area-plus" aria-hidden>+</span>
          <span className="area-tag"><strong>{delivery ? t.areaNewDelivery : t.areaNewTakeaway}</strong></span>
        </button>
        {list.map(({ order, lines, payments }) => {
          const paid = order.status === 'paid'
          const status = delivery ? order.delivery_status ?? 'preparing' : order.pickup_status ?? 'preparing'
          const no = String((delivery ? order.delivery_no : order.takeaway_no) ?? '?')
          const minutes = minutesSince(order.created_at, now)
          const bill = computeBill(order, lines, payments)
          const label = delivery ? t.deliveryShort(no) : t.takeawayShort(no)
          return (
            <button key={order.id} type="button" className={`area-item status-${status}${paid ? ' paid' : ''}`} onClick={() => onOpen(order)}
              aria-label={[label, order.guests ? t.peopleCount(order.guests) : '', t.floorWaitAria(minutes),
                delivery ? t.deliveryStatuses[order.delivery_status ?? 'preparing'] : t.pickupStatuses[order.pickup_status ?? 'preparing']].filter(Boolean).join(' · ')}>
              {delivery ? <ScooterIcon /> : <PersonIcon />}
              <span className="area-tag">
                <strong className="area-no">{label}{order.guests ? <span className="area-guests"> · {order.guests} 👤</span> : null}</strong>
                <span className={`table-timer ${timerLevel(minutes, config)}`}>⏱ {t.floorMinutes(minutes)}</span>
                {!delivery && order.pager_no && <span className="area-pager">{t.pagerShort(order.pager_no)}</span>}
                {delivery && (
                  order.driver_name
                    ? <span className="area-driver"><bdi>{order.driver_name}</bdi>{order.driver_phone && <bdi className="area-phone" dir="ltr">{order.driver_phone}</bdi>}</span>
                    : <span className="area-driver muted">{t.noDriver}</span>
                )}
                <span className={`area-status status-${status}`}>
                  {delivery ? t.deliveryStatuses[order.delivery_status ?? 'preparing'] : t.pickupStatuses[order.pickup_status ?? 'preparing']}
                  {paid ? ` · ${t.boardPaid}` : ` · ${money(bill.remaining)}`}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      {list.length === 0 && <p className="area-empty">{delivery ? t.noDeliveries : t.noTakeaways}</p>}
    </section>
  )
}

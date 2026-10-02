import type { Hall, OrderArea } from '../../lib/types'
import { useI18n } from '../../lib/i18n'

interface Props {
  /** Name shown on the first tab, beside the logo. */
  restaurant: string
  halls: Hall[]
  hallId: string | null
  /** À emporter or Livraison view shown instead of a hall. */
  area?: OrderArea | null
  takeaways: number
  deliveries: number
  onAccount(): void
  onHall(id: string): void
  /** Absent for an Employé: adding a hall is an admin task. */
  onTakeaway(): void
  onDelivery(): void
}

/**
 * Line 2 of the navigation: service tabs, all the same size and style (Connexion, Accès rapide, the halls, + Salle,
 * Emporter, Livraison). Open takeaway and delivery orders show as a small badge, not a different button colour.
 */
export default function ServiceTabs(p: Props) {
  const { t } = useI18n()
  // « À emporter (5) »: the number of running orders, readable from across the room.
  const badge = (n: number) => n > 0 && <span className="svc-count" aria-label={t.openCount(n)}> ({n})</span>
  return (
    <nav className="service-tabs" aria-label={t.navService}>
      <button className="svc-tab svc-account" onClick={p.onAccount} title={t.account}>
        <img src="/icon.svg" alt="" width={22} height={22} />
        <bdi>{p.restaurant}</bdi>
      </button>
      {/* Reserved for favourite tables; not built yet. */}
      <button className="svc-tab" disabled title={t.quickAccessSoon}>⚡ {t.quickAccess}</button>
      {p.halls.map((h) => (
        <button key={h.id} className="svc-tab" aria-pressed={!p.area && h.id === p.hallId} onClick={() => p.onHall(h.id)}>
          <bdi>{h.name}</bdi>
        </button>
      ))}
      <button className="svc-tab" aria-pressed={p.area === 'takeaway'} onClick={p.onTakeaway} title={t.takeawayOrders}>
        🥡 {t.takeawayBtn}{badge(p.takeaways)}
      </button>
      <button className="svc-tab" aria-pressed={p.area === 'delivery'} onClick={p.onDelivery} title={t.deliveryOrders}>
        🛵 {t.deliveryBtn}{badge(p.deliveries)}
      </button>
    </nav>
  )
}

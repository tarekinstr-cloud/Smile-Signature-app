import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { DiningTable, FloorConfig, Hall, Reservation, TableOrderInfo } from '../lib/types'
import { useI18n } from '../lib/i18n'
import { minutesSince, useServerNow } from '../lib/serverClock'
import TableGraphic, { chairDepth } from './TableGraphic'

const GRID = 10
const MOVE_THRESHOLD = 4 // screen px before a press becomes a drag

interface Props {
  hall: Hall
  tables: DiningTable[]
  editable: boolean
  selectedId: string | null
  onSelect(id: string | null): void
  onTap(t: DiningTable): void
  onMove(id: string, x: number, y: number): void
  /** Upcoming booking of each table (by table id): a dashed border and a small clock mark. */
  reservations?: Map<string, Reservation>
  /** The clock mark was tapped (service mode): show the booking. The rest of the table opens it as usual. */
  onReservation?(r: Reservation, t: DiningTable): void
  /** Open order of each occupied table (by table id): waiter under the table, guests on the chairs, waiting timer. */
  orders?: Map<string, TableOrderInfo>
  /** Timer colours: green below timer_warn_min, orange up to timer_alert_min, red after. */
  timer?: FloorConfig
}

/** « T 1 » for a table numbered 1; other names as they are. */
export const tableName = (label: string) => (/^\d+$/.test(label.trim()) ? `T ${label.trim()}` : label)

/** Minutes the guests have been waiting, or null when the order was marked served (until the next send). */
export function waitMinutes(o: TableOrderInfo, now: number): number | null {
  if (o.served_at) return null
  return minutesSince(o.timer_at ?? o.created_at, now)
}

export const timerLevel = (minutes: number, c: FloorConfig) => (minutes >= c.timer_alert_min ? 'alert' : minutes >= c.timer_warn_min ? 'warn' : 'ok')

interface Drag {
  id: string
  pointerId: number
  startClientX: number
  startClientY: number
  originX: number
  originY: number
  x: number
  y: number
  moved: boolean
  /** Pressed on the booking's clock mark (pointer capture makes the release target the table itself). */
  onMark: boolean
}

const snap = (v: number) => Math.round(v / GRID) * GRID
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max)

export default function FloorPlan({ hall, tables, editable, selectedId, onSelect, onTap, onMove, reservations, onReservation, orders, timer }: Props) {
  const { t: tx, lang } = useI18n()
  // Server time, refreshed every 15 s: each timer changes as soon as its minute does.
  const now = useServerNow()
  const time = (r: Reservation) => new Date(r.reserved_at).toLocaleTimeString(lang === 'ar' ? 'ar-DZ' : 'fr-FR', { hour: '2-digit', minute: '2-digit' })
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)

  // Fit the hall's logical size into the available width.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setScale(Math.min(1.4, el.clientWidth / hall.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [hall.width])

  function setDragState(d: Drag | null) {
    dragRef.current = d
    setDrag(d)
  }

  function onPointerDown(e: ReactPointerEvent, t: DiningTable) {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragState({
      id: t.id, pointerId: e.pointerId,
      startClientX: e.clientX, startClientY: e.clientY,
      originX: t.x, originY: t.y, x: t.x, y: t.y, moved: false,
      onMark: !!(e.target as Element).closest('.res-mark'),
    })
  }

  function onPointerMove(e: ReactPointerEvent, t: DiningTable) {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId || !editable) return
    // The canvas is always laid out left-to-right, even when the page is RTL (Arabic), so screen deltas map directly.
    const dx = e.clientX - d.startClientX
    const dy = e.clientY - d.startClientY
    const moved = d.moved || Math.hypot(dx, dy) > MOVE_THRESHOLD
    if (!moved) return
    setDragState({
      ...d,
      moved,
      x: clamp(snap(d.originX + dx / scale), 0, hall.width - t.width),
      y: clamp(snap(d.originY + dy / scale), 0, hall.height - t.height),
    })
  }

  function onPointerUp(e: ReactPointerEvent, t: DiningTable) {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    setDragState(null)
    if (d.moved) {
      if (d.x !== t.x || d.y !== t.y) onMove(t.id, d.x, d.y)
      onSelect(t.id)
    } else if (editable) {
      onSelect(t.id)
    } else {
      const booking = reservations?.get(t.id)
      if (booking && onReservation && d.onMark) onReservation(booking, t)
      else onTap(t)
    }
  }

  function onPointerCancel() {
    setDragState(null)
  }

  return (
    <div className="floor-wrap" ref={wrapRef}>
      <div
        className={`floor ${editable ? 'editable' : ''} ${hall.background_url ? 'has-bg' : ''}`}
        dir="ltr"
        // The image covers the hall's own size (width × height, in plan units) scaled like the tables, so the tables
        // stay on the same spot of the picture whatever the screen.
        style={{
          width: hall.width * scale, height: hall.height * scale,
          ...(hall.background_url
            ? { backgroundImage: `url("${hall.background_url.replace(/"/g, '%22')}")` }
            : { backgroundSize: `${GRID * 4 * scale}px ${GRID * 4 * scale}px` }),
        }}
        onPointerDown={(e) => { if (e.target === e.currentTarget) onSelect(null) }}
      >
        {tables.map((t) => {
          const pos = drag?.id === t.id ? drag : t
          const booking = reservations?.get(t.id)
          const info = t.status === 'occupied' ? orders?.get(t.id) : undefined
          const w = t.width * scale
          const h = t.height * scale
          const minutes = info ? waitMinutes(info, now) : null
          const waiter = info?.created_by_name?.trim()
          return (
            <button
              key={t.id}
              type="button"
              className={[
                'table', 'drawn', t.shape, t.status,
                selectedId === t.id ? 'selected' : '',
                drag?.id === t.id && drag.moved ? 'dragging' : '',
                booking ? 'reserved' : '',
              ].join(' ')}
              title={booking ? tx.resOnTable(time(booking), booking.client_name, booking.party_size) : undefined}
              style={{
                left: pos.x * scale,
                top: pos.y * scale,
                width: t.width * scale,
                height: t.height * scale,
                fontSize: Math.max(11, 18 * scale),
              }}
              onPointerDown={(e) => onPointerDown(e, t)}
              onPointerMove={(e) => onPointerMove(e, t)}
              onPointerUp={(e) => onPointerUp(e, t)}
              onPointerCancel={onPointerCancel}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  if (editable) onSelect(t.id)
                  else onTap(t)
                }
              }}
              aria-label={tx.tableAria(t.label, t.seats, t.status === 'free')
                + (waiter ? ` · ${waiter}` : '')
                + (info ? ` · ${minutes === null ? tx.floorServed : tx.floorWaitAria(minutes)}` : '')
                + (booking ? ` · ${tx.resOnTable(time(booking), booking.client_name, booking.party_size)}` : '')}
            >
              <TableGraphic shape={t.shape} width={w} height={h} seats={t.seats} occupied={t.status === 'occupied'} guests={info?.guests ?? null} />
              {booking && (
                <span className="res-mark" aria-hidden title={tx.resBadge(time(booking))}>
                  🕒 {time(booking)}
                </span>
              )}
              <span className="label">{t.label}</span>
              <span className="seats">{info?.guests ? `${Math.min(info.guests, 99)}/${t.seats}` : t.seats} 👤</span>
              {/* On a small screen (plan scaled down) the waiter is left out so neighbouring labels do not overlap. */}
              <span className="table-tag" aria-hidden style={{ top: h + chairDepth(w, h) * 1.3 + 2, fontSize: Math.max(9, Math.min(14, 13 * scale)) }}>
                <span className="table-name">{tableName(t.label)}{waiter && scale >= 0.6 && <> (<bdi>{waiter}</bdi>)</>}</span>
                {info && (
                  minutes === null
                    ? <span className="table-timer served">✓ {tx.floorServed}</span>
                    : <span className={`table-timer ${timerLevel(minutes, timer ?? { timer_warn_min: 15, timer_alert_min: 30 })}`}>⏱ {tx.floorMinutes(minutes)}</span>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

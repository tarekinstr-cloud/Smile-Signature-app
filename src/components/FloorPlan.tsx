import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { DiningTable, Hall } from '../lib/types'

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
}

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
}

const snap = (v: number) => Math.round(v / GRID) * GRID
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max)

export default function FloorPlan({ hall, tables, editable, selectedId, onSelect, onTap, onMove }: Props) {
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
    })
  }

  function onPointerMove(e: ReactPointerEvent, t: DiningTable) {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId || !editable) return
    // The canvas is laid out left-to-right even though the page is RTL, so screen deltas map directly.
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
      onTap(t)
    }
  }

  function onPointerCancel() {
    setDragState(null)
  }

  return (
    <div className="floor-wrap" ref={wrapRef}>
      <div
        className={`floor ${editable ? 'editable' : ''}`}
        dir="ltr"
        style={{ width: hall.width * scale, height: hall.height * scale, backgroundSize: `${GRID * 4 * scale}px ${GRID * 4 * scale}px` }}
        onPointerDown={(e) => { if (e.target === e.currentTarget) onSelect(null) }}
      >
        {tables.map((t) => {
          const pos = drag?.id === t.id ? drag : t
          return (
            <button
              key={t.id}
              type="button"
              className={[
                'table', t.shape, t.status,
                selectedId === t.id ? 'selected' : '',
                drag?.id === t.id && drag.moved ? 'dragging' : '',
              ].join(' ')}
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
              aria-label={`طاولة ${t.label}، ${t.seats} مقاعد، ${t.status === 'free' ? 'حرة' : 'مشغولة'}`}
            >
              <span className="label">{t.label}</span>
              <span className="seats">{t.seats} 👤</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

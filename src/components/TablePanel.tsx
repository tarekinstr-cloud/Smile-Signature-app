import { useState } from 'react'
import type { DiningTable, Hall, TablePatch, TableShape } from '../lib/types'

const SHAPES: { value: TableShape; label: string }[] = [
  { value: 'square', label: 'مربعة' },
  { value: 'round', label: 'دائرية' },
  { value: 'rect', label: 'مستطيلة' },
]

interface Props {
  table: DiningTable
  hall: Hall
  onChange(patch: TablePatch): void
  onDelete(): void
  onClose(): void
}

export default function TablePanel({ table, hall, onChange, onDelete, onClose }: Props) {
  const [label, setLabel] = useState(table.label)

  function commitLabel() {
    const v = label.trim()
    if (v && v !== table.label) onChange({ label: v })
    else setLabel(table.label)
  }

  function setShape(shape: TableShape) {
    const patch: TablePatch = { shape }
    if (shape === 'rect' && table.width === table.height) patch.width = table.width * 2
    if (shape !== 'rect') patch.height = patch.width = Math.min(table.width, table.height)
    patch.x = Math.min(table.x, hall.width - (patch.width ?? table.width))
    onChange(patch)
  }

  function setSize(key: 'width' | 'height', value: number) {
    if (!Number.isFinite(value)) return
    const v = Math.max(30, Math.min(600, Math.round(value)))
    const patch: TablePatch = table.shape === 'rect' ? { [key]: v } : { width: v, height: v }
    patch.x = Math.min(table.x, hall.width - (patch.width ?? table.width))
    patch.y = Math.min(table.y, hall.height - (patch.height ?? table.height))
    onChange(patch)
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>طاولة {table.label}</h2>
        <button className="ghost" onClick={onClose} aria-label="إغلاق">✕</button>
      </div>
      <label>
        الرقم / الاسم
        <input value={label} onChange={(e) => setLabel(e.target.value)} onBlur={commitLabel} onKeyDown={(e) => e.key === 'Enter' && commitLabel()} />
      </label>
      <label>
        عدد المقاعد
        <input type="number" min={1} max={40} value={table.seats} onChange={(e) => {
          const n = Number(e.target.value)
          if (n >= 1 && n <= 40) onChange({ seats: n })
        }} />
      </label>
      <div className="field">
        <span>الشكل</span>
        <div className="segmented">
          {SHAPES.map((s) => (
            <button key={s.value} className={table.shape === s.value ? 'on' : ''} onClick={() => setShape(s.value)}>{s.label}</button>
          ))}
        </div>
      </div>
      <div className="row">
        <label>
          العرض
          <input type="number" step={10} value={table.width} onChange={(e) => setSize('width', Number(e.target.value))} />
        </label>
        {table.shape === 'rect' && (
          <label>
            الطول
            <input type="number" step={10} value={table.height} onChange={(e) => setSize('height', Number(e.target.value))} />
          </label>
        )}
      </div>
      <div className="field">
        <span>الحالة</span>
        <div className="segmented">
          <button className={table.status === 'free' ? 'on' : ''} onClick={() => onChange({ status: 'free' })}>حرة</button>
          <button className={table.status === 'occupied' ? 'on' : ''} onClick={() => onChange({ status: 'occupied' })}>مشغولة</button>
        </div>
      </div>
      <p className="muted small">الموقع: X {table.x} · Y {table.y}</p>
      <button className="danger" onClick={onDelete}>حذف الطاولة</button>
    </div>
  )
}

import { useState } from 'react'
import type { DiningTable, Hall, TablePatch, TableShape } from '../lib/types'
import { useI18n } from '../lib/i18n'

const SHAPES: TableShape[] = ['square', 'round', 'rect']

interface Props {
  table: DiningTable
  hall: Hall
  onChange(patch: TablePatch): void
  onDelete(): void
  onClose(): void
}

export default function TablePanel({ table, hall, onChange, onDelete, onClose }: Props) {
  const { t } = useI18n()
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
        <h2>{t.table(table.label)}</h2>
        <button className="ghost" onClick={onClose} aria-label={t.close}>✕</button>
      </div>
      <label>
        {t.tableLabel}
        <input value={label} onChange={(e) => setLabel(e.target.value)} onBlur={commitLabel} onKeyDown={(e) => e.key === 'Enter' && commitLabel()} />
      </label>
      <label>
        {t.seats}
        <input type="number" min={1} max={40} value={table.seats} onChange={(e) => {
          const n = Number(e.target.value)
          if (n >= 1 && n <= 40) onChange({ seats: n })
        }} />
      </label>
      <div className="field">
        <span>{t.shape}</span>
        <div className="segmented">
          {SHAPES.map((s) => (
            <button key={s} className={table.shape === s ? 'on' : ''} onClick={() => setShape(s)}>{t[s]}</button>
          ))}
        </div>
      </div>
      <div className="row">
        <label>
          {t.width}
          <input type="number" step={10} value={table.width} onChange={(e) => setSize('width', Number(e.target.value))} />
        </label>
        {table.shape === 'rect' && (
          <label>
            {t.height}
            <input type="number" step={10} value={table.height} onChange={(e) => setSize('height', Number(e.target.value))} />
          </label>
        )}
      </div>
      <div className="field">
        <span>{t.status}</span>
        <div className="segmented">
          <button className={table.status === 'free' ? 'on' : ''} onClick={() => onChange({ status: 'free' })}>{t.free}</button>
          <button className={table.status === 'occupied' ? 'on' : ''} onClick={() => onChange({ status: 'occupied' })}>{t.occupied}</button>
        </div>
      </div>
      <p className="muted small">{t.position}: X {table.x} · Y {table.y}</p>
      <button className="danger" onClick={onDelete}>{t.deleteTable}</button>
    </div>
  )
}

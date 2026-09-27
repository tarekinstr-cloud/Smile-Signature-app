import { useState } from 'react'
import type { Hall, HallPatch } from '../lib/types'
import { useI18n } from '../lib/i18n'

interface Props {
  hall: Hall
  onChange(patch: HallPatch): void
  onDelete(): void
}

export default function HallPanel({ hall, onChange, onDelete }: Props) {
  const { t } = useI18n()
  const [name, setName] = useState(hall.name)
  const [width, setWidth] = useState(String(hall.width))
  const [height, setHeight] = useState(String(hall.height))

  function commit() {
    const patch: HallPatch = {}
    const n = name.trim()
    if (n && n !== hall.name) patch.name = n
    const w = Number(width), h = Number(height)
    if (w >= 200 && w <= 5000 && w !== hall.width) patch.width = Math.round(w)
    if (h >= 200 && h <= 5000 && h !== hall.height) patch.height = Math.round(h)
    if (Object.keys(patch).length) onChange(patch)
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t.hallSettings}</h2>
      </div>
      <p className="muted small">{t.hallHint}</p>
      <label>
        {t.hallName}
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      </label>
      <div className="row">
        <label>
          {t.width}
          <input type="number" step={50} value={width} onChange={(e) => setWidth(e.target.value)} onBlur={commit} />
        </label>
        <label>
          {t.height}
          <input type="number" step={50} value={height} onChange={(e) => setHeight(e.target.value)} onBlur={commit} />
        </label>
      </div>
      <button className="danger" onClick={onDelete}>{t.deleteHall}</button>
    </div>
  )
}

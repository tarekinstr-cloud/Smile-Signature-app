import type { TableShape } from '../lib/types'

/** How far chairs stand out of the table top, in screen pixels, for a table of this size on screen. */
export function chairDepth(width: number, height: number): number {
  return Math.max(7, Math.min(16, Math.min(width, height) * 0.2))
}

interface Chair {
  x: number
  y: number
  /** Rotation in degrees: the chair's back faces away from the table. */
  angle: number
}

/** Chairs per side (top, right, bottom, left) for a square or rectangular table: in proportion to the side's length. */
function perSide(n: number, w: number, h: number): number[] {
  const sides = [w, h, w, h]
  const total = sides.reduce((a, b) => a + b, 0)
  const exact = sides.map((s) => (n * s) / total)
  const counts = exact.map(Math.floor)
  let left = n - counts.reduce((a, b) => a + b, 0)
  // Largest remainder first; on a tie, the long sides (then top before bottom) get the chair.
  const order = exact.map((e, i) => ({ i, r: e - Math.floor(e), len: sides[i] })).sort((a, b) => b.r - a.r || b.len - a.len || a.i - b.i)
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) counts[order[k].i]++
  return counts
}

/** Chair centres around the table top (box w × h), clockwise from the top. */
function chairs(shape: TableShape, n: number, w: number, h: number, depth: number): Chair[] {
  const gap = depth * 0.25
  if (shape === 'round') {
    const rx = w / 2 + gap + depth / 2
    const ry = h / 2 + gap + depth / 2
    return Array.from({ length: n }, (_, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / n
      return { x: w / 2 + rx * Math.cos(a), y: h / 2 + ry * Math.sin(a), angle: (a * 180) / Math.PI + 90 }
    })
  }
  const [top, right, bottom, left] = perSide(n, w, h)
  const out: Chair[] = []
  const along = (count: number, len: number, i: number) => (len * (i + 0.5)) / count
  for (let i = 0; i < top; i++) out.push({ x: along(top, w, i), y: -gap - depth / 2, angle: 0 })
  for (let i = 0; i < right; i++) out.push({ x: w + gap + depth / 2, y: along(right, h, i), angle: 90 })
  for (let i = bottom - 1; i >= 0; i--) out.push({ x: along(bottom, w, i), y: h + gap + depth / 2, angle: 180 })
  for (let i = left - 1; i >= 0; i--) out.push({ x: -gap - depth / 2, y: along(left, h, i), angle: 270 })
  return out
}

interface Props {
  shape: TableShape
  /** Size of the table top on screen (px). */
  width: number
  height: number
  seats: number
  occupied: boolean
  /** Chairs taken (couverts); null on an occupied table: every chair. */
  guests: number | null
}

/**
 * A table seen from above, drawn in SVG: round, square or rectangular top, with one chair per seat. On an occupied
 * table the chairs taken (as many as the order's guests) are coloured, the others stay neutral.
 */
export default function TableGraphic({ shape, width, height, seats, occupied, guests }: Props) {
  const depth = chairDepth(width, height)
  const n = Math.max(0, Math.min(40, Math.round(seats)))
  const list = chairs(shape, n, width, height, depth)
  const taken = occupied ? Math.min(n, guests ?? n) : 0
  // Chairs are a little narrower than their share of the side, so neighbours never touch.
  const sideLen = shape === 'round' ? (Math.PI * (width + height)) / 2 : 2 * (width + height)
  const chairW = Math.max(6, Math.min(depth * 1.5, (sideLen / Math.max(n, 1)) * 0.7))
  const pad = depth * 1.4
  return (
    <svg className="table-svg" width={width + pad * 2} height={height + pad * 2} viewBox={`${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}`}
      style={{ left: -pad, top: -pad }} aria-hidden focusable="false">
      {list.map((c, i) => (
        <g key={i} transform={`translate(${c.x} ${c.y}) rotate(${c.angle})`} className={i < taken ? 'chair taken' : 'chair'}>
          <rect x={-chairW / 2} y={-depth / 2} width={chairW} height={depth} rx={Math.min(4, depth / 3)} />
          <rect className="chair-back" x={-chairW / 2} y={-depth / 2} width={chairW} height={Math.max(2, depth * 0.28)} rx={Math.min(3, depth / 4)} />
        </g>
      ))}
      {shape === 'round' ? (
        <ellipse className="table-top" cx={width / 2} cy={height / 2} rx={width / 2 - 1} ry={height / 2 - 1} />
      ) : (
        <rect className="table-top" x={1} y={1} width={width - 2} height={height - 2} rx={Math.min(10, Math.min(width, height) / 6)} />
      )}
    </svg>
  )
}

/**
 * Units of the stock and of the fiches techniques. The stock keeps one unit per item (kg, L, pièce…); a fiche may be
 * typed in a sub-unit (g for kg, ml or cl for L) and is converted to the stock unit. Stock units are free text, so the
 * usual spellings are recognised (kg, kilo, g, gr, L, litre, cl, ml).
 */

type Dimension = 'mass' | 'volume'
/** Each known unit: its dimension and its size in the dimension's smallest unit (g, ml). */
const KNOWN: Record<string, { dim: Dimension; size: number; label: string }> = {
  kg: { dim: 'mass', size: 1000, label: 'kg' },
  kilo: { dim: 'mass', size: 1000, label: 'kg' },
  kilos: { dim: 'mass', size: 1000, label: 'kg' },
  kilogramme: { dim: 'mass', size: 1000, label: 'kg' },
  kilogrammes: { dim: 'mass', size: 1000, label: 'kg' },
  g: { dim: 'mass', size: 1, label: 'g' },
  gr: { dim: 'mass', size: 1, label: 'g' },
  gramme: { dim: 'mass', size: 1, label: 'g' },
  grammes: { dim: 'mass', size: 1, label: 'g' },
  'كغ': { dim: 'mass', size: 1000, label: 'kg' },
  'غ': { dim: 'mass', size: 1, label: 'g' },
  l: { dim: 'volume', size: 1000, label: 'L' },
  litre: { dim: 'volume', size: 1000, label: 'L' },
  litres: { dim: 'volume', size: 1000, label: 'L' },
  liter: { dim: 'volume', size: 1000, label: 'L' },
  'لتر': { dim: 'volume', size: 1000, label: 'L' },
  cl: { dim: 'volume', size: 10, label: 'cl' },
  ml: { dim: 'volume', size: 1, label: 'ml' },
}

const SUB_UNITS: Record<Dimension, string[]> = { mass: ['kg', 'g'], volume: ['L', 'cl', 'ml'] }

const key = (unit: string) => unit.trim().toLowerCase().replace(/\.$/, '')
const known = (unit: string) => KNOWN[key(unit)]

/**
 * Units a fiche can be typed in for a stock unit: the stock unit itself first, then its sub-units (kg → g; L → cl, ml).
 * An unknown unit (pièce, bouteille…) has only itself.
 */
export function inputUnits(stockUnit: string): string[] {
  const k = known(stockUnit)
  if (!k) return [stockUnit.trim()]
  return [stockUnit.trim(), ...SUB_UNITS[k.dim].filter((u) => u !== k.label)]
}

/**
 * How many stock units one input unit is: 0.001 for g when the stock is in kg, 0.01 for cl in L, 1 for the stock unit
 * itself. null when the two units cannot be converted.
 */
export function unitFactor(inputUnit: string, stockUnit: string): number | null {
  if (key(inputUnit) === key(stockUnit)) return 1
  const a = known(inputUnit)
  const b = known(stockUnit)
  if (!a || !b || a.dim !== b.dim) return null
  return a.size / b.size
}

/** Converts a quantity typed in `inputUnit` to the stock unit (50 g → 0,05 kg), rounded to 6 decimals like the database. */
export function toStockUnit(quantity: number, inputUnit: string, stockUnit: string): number | null {
  const f = unitFactor(inputUnit, stockUnit)
  return f == null ? null : Math.round(quantity * f * 1e6) / 1e6
}

const fmt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 })

/**
 * Stock quantity with its purchase units, for the display: "14 bouteille (2 fardeau + 2)". Only when a purchase unit is
 * set and there is at least one whole purchase unit.
 */
export function purchaseHint(quantity: number, s: { unit: string; purchase_unit: string; purchase_factor: number | null }): string | null {
  if (!s.purchase_unit || !s.purchase_factor || s.purchase_factor <= 0 || s.purchase_factor === 1) return null
  const whole = Math.trunc(Math.round((quantity / s.purchase_factor) * 1000) / 1000)
  if (whole < 1) return null
  const rest = Math.round((quantity - whole * s.purchase_factor) * 1000) / 1000
  return `${fmt.format(whole)} ${s.purchase_unit}${rest > 0 ? ` + ${fmt.format(rest)}` : ''}`
}

import { tr } from './i18n'

const whole = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })

/**
 * Amount rounded to the whole dinar (no centimes in DA), half away from zero like Postgres round():
 * 1 451,61 → 1 452, −0,5 → −1. Used for every amount shown, totalled or exported, so that rows add up to their totals.
 */
export const da = (n: number) => (Number.isFinite(n) ? Math.sign(n) * Math.round(Math.abs(n)) || 0 : 0)

/** Amount in DA, e.g. "1 500 DA" (French) or "1 500 دج" (Arabic); always whole dinars. */
export const amount = (n: number) => whole.format(da(n))

/** Price in Algerian dinars with its currency. */
export const money = (n: number) => `${amount(n)} ${tr().currency}`

/** Amount for a CSV export: whole dinars, '' when there is none. */
export const csvDa = (n: number | null | undefined) => (n == null ? '' : da(Number(n)))

/**
 * Reads an amount typed in a text field, whatever the keyboard: Arabic-Indic digits (٧١٠٠, ۷۱۰۰), spaces or
 * non-breaking spaces between thousands, « DA » / « دج » after the number, a comma or a dot for decimals, and dots or
 * commas between thousands (7.100, 1,250,000). Null when it is not a number.
 */
export function readAmount(text: string): number | null {
  let s = text
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/[٬'’]/g, '')
    .replace(/\s| | /g, '')
    .replace(/(da|dzd|دج|د\.ج\.?)$/i, '')
  if (!s) return null
  const dot = s.lastIndexOf('.')
  const comma = s.lastIndexOf(',')
  if (dot >= 0 && comma >= 0) {
    // The last of the two is the decimal mark, the other separates thousands.
    const dec = dot > comma ? '.' : ','
    s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.')
  } else if (dot >= 0 || comma >= 0) {
    const sep = dot >= 0 ? '.' : ','
    const parts = s.split(sep)
    // 7.100 or 1,250,000: thousands (no centimes in DA); 12,5 or 12.50: decimals.
    s = parts.length > 2 || (parts.length === 2 && /^\d{3}$/.test(parts[1]) && /^-?\d{1,3}$/.test(parts[0])) ? parts.join('') : parts.join('.')
  }
  if (!/^-?\d+(\.\d*)?$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

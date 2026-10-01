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

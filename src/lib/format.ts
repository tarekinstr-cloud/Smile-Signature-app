import { tr } from './i18n'

const whole = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })
const cents = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Amount in DA, e.g. "1 500 DA" (French) or "1 500 دج" (Arabic); decimals only when there are some ("150,50 DA"). */
export const amount = (n: number) => {
  const r = Math.round(n * 100) / 100
  return (Number.isInteger(r) ? whole : cents).format(r)
}

/** Price in Algerian dinars with its currency. */
export const money = (n: number) => `${amount(n)} ${tr().currency}`

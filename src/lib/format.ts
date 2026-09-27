import { tr } from './i18n'

/** Price in Algerian dinars, e.g. "150.00 DA" (French) or "150.00 دج" (Arabic). */
export const money = (n: number) => `${n.toFixed(2)} ${tr().currency}`

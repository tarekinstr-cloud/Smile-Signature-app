import { serverNow } from './serverClock'

/**
 * Restaurant time: every date and hour of the app is shown and computed in Africa/Algiers (UTC+1, no daylight saving
 * time since 1981), whatever the time zone or the clock set on the tablet, phone or PC, and « now » is the Supabase
 * server's time (serverClock). Stored times stay absolute instants (ISO with offset); only the wall-clock reading of
 * them (day, hour, week, month) goes through these helpers.
 */
export const APP_TZ = 'Africa/Algiers'
/** UTC+1 all year round. */
export const TZ_OFFSET_MS = 60 * 60_000

/** Now, on the server's clock. */
export const appNow = () => new Date(serverNow())

/** Now as an ISO instant, on the server's clock (timestamps written by the app). */
export const nowIso = () => appNow().toISOString()

export interface TzParts {
  year: number
  /** 0 = January. */
  month: number
  day: number
  hour: number
  minute: number
  /** 0 = Sunday. */
  weekday: number
}

/** Wall-clock fields of an instant in Algiers. */
export function tzParts(d: Date | number | string = appNow()): TzParts {
  const x = new Date(new Date(d).getTime() + TZ_OFFSET_MS)
  return {
    year: x.getUTCFullYear(), month: x.getUTCMonth(), day: x.getUTCDate(),
    hour: x.getUTCHours(), minute: x.getUTCMinutes(), weekday: x.getUTCDay(),
  }
}

/** The instant of an Algiers wall-clock time (fields may overflow, like new Date(y, m, d + 1)). */
export function tzDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month, day, hour, minute) - TZ_OFFSET_MS)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** YYYY-MM-DD of an instant, in Algiers (for <input type="date"> and day keys). */
export function tzIsoDay(d: Date | number | string = appNow()): string {
  const p = tzParts(d)
  return `${p.year}-${pad(p.month + 1)}-${pad(p.day)}`
}

/** YYYY-MM of an instant, in Algiers. */
export function tzIsoMonth(d: Date | number | string = appNow()): string {
  return tzIsoDay(d).slice(0, 7)
}

/** HH:MM of an instant, in Algiers (for <input type="time">). */
export function tzTime(d: Date | number | string): string {
  const p = tzParts(d)
  return `${pad(p.hour)}:${pad(p.minute)}`
}

/** Midnight (Algiers) starting the day YYYY-MM-DD; an invalid text gives today. */
export function tzDayStart(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return tzStartOfDay(appNow())
  return tzDate(y, m - 1, d)
}

/** The instant of a day YYYY-MM-DD at HH:MM, Algiers time (reservations, hour filters). */
export function tzDateTime(iso: string, hhmm: string): Date {
  const [h, min] = hhmm.split(':').map(Number)
  const start = tzDayStart(iso)
  return new Date(start.getTime() + ((h || 0) * 60 + (min || 0)) * 60_000)
}

/** Midnight (Algiers) of the day of an instant. */
export function tzStartOfDay(d: Date | number | string = appNow()): Date {
  const p = tzParts(d)
  return tzDate(p.year, p.month, p.day)
}

/** Same Algiers wall-clock time, n days later (or earlier). */
export function tzAddDays(d: Date | number | string, n: number): Date {
  const p = tzParts(d)
  return tzDate(p.year, p.month, p.day + n, p.hour, p.minute)
}

/** Number of days of a month (0 = January). */
export const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

let installed = false

/**
 * Makes every date text of the app Algiers time: toLocaleString / toLocaleDateString / toLocaleTimeString and
 * Intl.DateTimeFormat get timeZone 'Africa/Algiers' unless one is given. Called once at start-up (main.tsx).
 */
export function installAppTimeZone() {
  if (installed) return
  installed = true
  const withZone = <T extends Intl.DateTimeFormatOptions | undefined>(o: T): Intl.DateTimeFormatOptions => ({ ...(o ?? {}), timeZone: o?.timeZone ?? APP_TZ })
  const proto = Date.prototype
  const { toLocaleString, toLocaleDateString, toLocaleTimeString } = proto
  proto.toLocaleString = function (this: Date, locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
    return toLocaleString.call(this, locales, withZone(options))
  }
  proto.toLocaleDateString = function (this: Date, locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
    return toLocaleDateString.call(this, locales, withZone(options))
  }
  proto.toLocaleTimeString = function (this: Date, locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
    return toLocaleTimeString.call(this, locales, withZone(options))
  }
  const Native = Intl.DateTimeFormat
  const Zoned = function (this: unknown, locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
    return new Native(locales, withZone(options))
  } as unknown as typeof Intl.DateTimeFormat
  Object.defineProperty(Zoned, 'prototype', { value: Native.prototype })
  Object.defineProperty(Zoned, 'supportedLocalesOf', { value: Native.supportedLocalesOf.bind(Native) })
  Intl.DateTimeFormat = Zoned
}

import { useI18n } from '../../lib/i18n'
import { appNow, tzAddDays, tzDate, tzDayStart, tzIsoDay, tzParts } from '../../lib/tz'

export const PERIOD_PRESETS = ['day', 'today', '7d', 'month', 'lastMonth', 'custom'] as const
/** Journée en cours (working day), Aujourd'hui, 7 jours, Ce mois, Mois dernier, Personnalisé. */
export type PeriodPreset = (typeof PERIOD_PRESETS)[number]

export interface Period {
  preset: PeriodPreset
  /** Personnalisé: first and last day, YYYY-MM-DD (both included). */
  from: string
  to: string
}

/** YYYY-MM-DD of an instant, Algiers time (lib/tz). */
export const isoDay = (d: Date) => tzIsoDay(d)

export const initialPeriod = (preset: PeriodPreset): Period => {
  const today = tzIsoDay(appNow())
  return { preset, from: today, to: today }
}

/**
 * Start and end (exclusive) of a period, in Algiers time, « now » being the server's time. `dayStart` is where the
 * working day in progress began (the previous closing); without it « Journée en cours » falls back to today.
 */
export function periodRange(p: Period, dayStart?: string | null): [Date, Date] {
  const now = appNow()
  const t = tzParts(now)
  const midnight = tzDate(t.year, t.month, t.day)
  const tomorrow = tzDate(t.year, t.month, t.day + 1)
  switch (p.preset) {
    case 'day':
      return [dayStart ? new Date(dayStart) : midnight, new Date(Math.max(tomorrow.getTime(), now.getTime() + 60_000))]
    case 'today':
      return [midnight, tomorrow]
    case '7d':
      return [tzDate(t.year, t.month, t.day - 6), tomorrow]
    case 'month':
      return [tzDate(t.year, t.month, 1), tzDate(t.year, t.month + 1, 1)]
    case 'lastMonth':
      return [tzDate(t.year, t.month - 1, 1), tzDate(t.year, t.month, 1)]
    case 'custom': {
      const a = tzDayStart(p.from)
      const b = tzDayStart(p.to < p.from ? p.from : p.to)
      return [a, tzAddDays(b, 1)]
    }
  }
}

/** "01/09/2026 – 30/09/2026" of a range whose end is exclusive. */
export function rangeLabel([from, to]: [Date, Date], loc: string): string {
  const last = new Date(to.getTime() - 1)
  const f = (d: Date) => d.toLocaleDateString(loc, { day: '2-digit', month: '2-digit', year: 'numeric' })
  return f(from) === f(last) ? f(from) : `${f(from)} – ${f(last)}`
}

/** Period buttons, with two dates for Personnalisé. `presets` picks which buttons are offered. */
export default function PeriodFilter({ value, onChange, presets = PERIOD_PRESETS }: {
  value: Period
  onChange(p: Period): void
  presets?: readonly PeriodPreset[]
}) {
  const { t } = useI18n()
  return (
    <div className="period-filter">
      <div className="segmented" role="radiogroup" aria-label={t.periodLabel}>
        {presets.map((p) => (
          <button key={p} type="button" role="radio" aria-checked={value.preset === p} className={value.preset === p ? 'on' : ''}
            onClick={() => onChange({ ...value, preset: p })}>
            {t.periodPresets[p]}
          </button>
        ))}
      </div>
      {value.preset === 'custom' && (
        <div className="period-dates">
          <label>
            {t.periodFrom}
            <input type="date" value={value.from} max={value.to} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} />
          </label>
          <label>
            {t.periodTo}
            <input type="date" value={value.to} min={value.from} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} />
          </label>
        </div>
      )}
    </div>
  )
}

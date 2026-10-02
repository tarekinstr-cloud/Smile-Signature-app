import { appNow, nowIso, tzStartOfDay } from './tz'
import { serverNow } from './serverClock'
import { cash } from './cash'
import { repo } from './repo'
import { cashSummary, categoryOfItems, computeDayReport } from './dayReport'
import type { CashDay, DayReport, SalesData } from './types'

export interface Live {
  day: CashDay | null
  report: DayReport
  sales: SalesData
}

/** Report of the working day in progress: sales since the last closing, cash expected in the drawer. */
export async function loadLive(): Promise<Live> {
  const day = await cash.currentDay()
  let start = day?.period_start
  if (!start) {
    // Drawer not opened yet: what was sold since the last closing (or since midnight).
    const [last] = await cash.closedDays(new Date(0), new Date(serverNow() + 86_400_000))
    start = last?.closed_at ?? tzStartOfDay(appNow()).toISOString()
  }
  const from = new Date(start)
  const to = new Date(serverNow() + 60_000)
  const [sales, menu, moves] = await Promise.all([
    cash.sales(from, to),
    repo.getMenu({ includeHidden: true }).catch(() => null),
    day ? cash.movements({ dayId: day.id }) : Promise.resolve([]),
  ])
  const sum = (k: 'in' | 'out') => moves.filter((m) => m.kind === k).reduce((s, m) => s + m.amount, 0)
  // Cash given back for tickets cancelled today (Factures annulées) leaves the drawer, as in cash_day_totals.
  const refunded = (sales.voids ?? []).filter((v) => day && v.voided_day_id === day.id).reduce((s, v) => s + (v.void_cash ?? 0), 0)
  const cashSales = sales.payments.filter((p) => p.method === 'cash').reduce((s, p) => s + p.amount, 0) - refunded
  const box = day ? cashSummary(day.opening_float, cashSales, sum('in'), sum('out')) : null
  const now = nowIso()
  // Drawer closed: everything since the last closing was taken with the drawer closed.
  return { day, sales, report: computeDayReport(sales, categoryOfItems(menu), from.toISOString(), now, box, day?.opened_at ?? now) }
}

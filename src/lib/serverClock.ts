import { useEffect, useSyncExternalStore } from 'react'
import { repo } from './repo'

/**
 * Server time for the floor timers. Each device's clock can be minutes (or hours) off; the times of the orders come
 * from the Supabase server. So the gap between the server's clock and this device's is measured when the app loads
 * (and again every 10 minutes), and every elapsed time is computed as « device time + gap − start », never below 0.
 */
let offset = 0
let synced = false
let syncing: Promise<void> | null = null
const listeners = new Set<() => void>()
let tick = 0

async function sync(): Promise<void> {
  try {
    const before = Date.now()
    const server = await repo.serverNow()
    const after = Date.now()
    // The server read the time about halfway through the request.
    offset = server - (before + after) / 2
    synced = true
  } catch {
    // Migration not run or offline: keep the last gap (0 at first); elapsed times stay clamped to 0 and above.
  }
  tick++
  listeners.forEach((l) => l())
}

export function syncServerClock(): Promise<void> {
  syncing ??= sync().finally(() => {
    syncing = null
  })
  return syncing
}

/** Now, on the server's clock (ms since 1970). */
export const serverNow = () => Date.now() + offset

/** Whole minutes from `iso` (a server time) to now, never negative. */
export function minutesSince(iso: string, now = serverNow()): number {
  const start = new Date(iso).getTime()
  if (!Number.isFinite(start)) return 0
  return Math.max(0, Math.floor((now - start) / 60_000))
}

export const clockSynced = () => synced

/**
 * Re-renders every `everyMs` (and after each clock sync) and returns the server time, for the floor timers. Syncs the
 * clock when first used and every 10 minutes while used.
 */
export function useServerNow(everyMs = 15_000): number {
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => tick,
  )
  useEffect(() => {
    syncServerClock()
    const resync = window.setInterval(syncServerClock, 10 * 60_000)
    const timer = window.setInterval(() => {
      tick++
      listeners.forEach((l) => l())
    }, everyMs)
    return () => {
      window.clearInterval(resync)
      window.clearInterval(timer)
    }
  }, [everyMs])
  return serverNow()
}

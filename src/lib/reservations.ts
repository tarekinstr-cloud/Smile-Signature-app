import type { SupabaseClient } from '@supabase/supabase-js'
import { sharedChannel, supabase } from './repo'
import { tr } from './i18n'
import type { NewReservation, Reservation, ReservationPatch } from './types'

/**
 * Table bookings (menu Clients, and the small indicator on the floor plan). Supabase table `reservations`
 * (migration 20260930010000_reservations.sql), or localStorage in demo mode, like `repo`.
 */
export interface ReservationsService {
  /** All bookings, oldest first. */
  list(): Promise<Reservation[]>
  /** Confirmed bookings whose time falls between `from` and `to`, for the floor plan. Errors are thrown, not hidden. */
  listBetween(from: Date, to: Date): Promise<Reservation[]>
  create(r: NewReservation): Promise<Reservation>
  update(id: string, patch: ReservationPatch): Promise<void>
  subscribe(onChange: () => void): () => void
}

/** Bookings of the next hours are shown even when they fall after midnight. */
export const UPCOMING_HOURS = 3

/**
 * Bookings shown on the floor plan: every confirmed one of today (local day, including those whose time has passed but
 * that nobody marked Honorée / No-show yet), and those of the next UPCOMING_HOURS after midnight.
 */
export function floorWindow(now = new Date()): [Date, Date] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  const ahead = new Date(now.getTime() + UPCOMING_HOURS * 3_600_000)
  return [start, ahead > end ? ahead : end]
}

/**
 * The booking to show on each table: its next one still to come, or else the latest of today (customer late, status
 * not updated yet).
 */
export function bookingsByTable(list: Reservation[], now = new Date()): Map<string, Reservation> {
  const byTable = new Map<string, Reservation>()
  for (const r of [...list].sort((a, b) => a.reserved_at.localeCompare(b.reserved_at))) {
    if (r.status !== 'confirmed' || !r.table_id) continue
    const current = byTable.get(r.table_id)
    // Sorted by time: a later booking replaces the current one only while the current one is already past.
    if (!current || new Date(current.reserved_at) < now) byTable.set(r.table_id, r)
  }
  return byTable
}

const norm = (r: Reservation): Reservation => ({ ...r, party_size: Number(r.party_size), phone: r.phone ?? '', note: r.note ?? '' })

function clean<T extends ReservationPatch>(r: T): T {
  const t = tr()
  if (r.client_name !== undefined && !r.client_name.trim()) throw new Error(t.errResName)
  if (r.party_size !== undefined && !(Number.isInteger(r.party_size) && r.party_size >= 1 && r.party_size <= 200)) throw new Error(t.errResParty)
  if (r.reserved_at !== undefined && Number.isNaN(Date.parse(r.reserved_at))) throw new Error(t.errResDate)
  return {
    ...r,
    ...(r.client_name !== undefined && { client_name: r.client_name.trim() }),
    ...(r.phone !== undefined && { phone: r.phone.trim() }),
    ...(r.note !== undefined && { note: r.note.trim() }),
  }
}

function resError(message: string): Error {
  const t = tr()
  if (/reservations/.test(message) && /does not exist|schema cache|Could not find/i.test(message)) return new Error(t.errMigrationReservations)
  if (/row-level security|permission denied/i.test(message)) return new Error(t.errNoPermission)
  if (message.includes('reservation_table_hall')) return new Error(t.errResTableHall)
  return new Error(message)
}

function supabaseReservations(sb: SupabaseClient): ReservationsService {
  const check = <T>(res: { data: T; error: { message: string } | null }): T => {
    if (res.error) throw resError(res.error.message)
    return res.data
  }
  const channel = sharedChannel(sb, 'reservations', ['reservations'])
  return {
    async list() {
      return (check(await sb.from('reservations').select('*').order('reserved_at')) as Reservation[]).map(norm)
    },
    async listBetween(from, to) {
      const res = await sb.from('reservations').select('*').eq('status', 'confirmed')
        .gte('reserved_at', from.toISOString()).lt('reserved_at', to.toISOString()).order('reserved_at')
      return (check(res) as Reservation[]).map(norm)
    },
    async create(r) {
      return norm(check(await sb.from('reservations').insert(clean(r)).select().single()) as Reservation)
    },
    async update(id, patch) {
      check(await sb.from('reservations').update(clean(patch)).eq('id', id))
    },
    subscribe: channel,
  }
}

const KEY = 'smile.reservations.v1'

function localReservations(): ReservationsService {
  const listeners = new Set<() => void>()
  const read = (): Reservation[] => {
    try {
      return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as Reservation[]).map(norm)
    } catch {
      return []
    }
  }
  const write = (rs: Reservation[]) => {
    localStorage.setItem(KEY, JSON.stringify(rs))
    listeners.forEach((l) => l())
  }
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) listeners.forEach((l) => l())
  })
  const sorted = (rs: Reservation[]) => [...rs].sort((a, b) => a.reserved_at.localeCompare(b.reserved_at))
  return {
    async list() {
      return sorted(read())
    },
    async listBetween(from, to) {
      return sorted(read()).filter((r) => r.status === 'confirmed' && new Date(r.reserved_at) >= from && new Date(r.reserved_at) < to)
    },
    async create(r) {
      const row: Reservation = { id: crypto.randomUUID(), status: 'confirmed', created_at: new Date().toISOString(), ...clean(r) }
      write([...read(), row])
      return row
    },
    async update(id, patch) {
      write(read().map((r) => (r.id === id ? { ...r, ...clean(patch) } : r)))
    },
    subscribe(onChange) {
      const l = () => onChange()
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
  }
}

export const reservations: ReservationsService = supabase ? supabaseReservations(supabase) : localReservations()

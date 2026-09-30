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
  /** Confirmed bookings whose time falls between `from` and `to`, for the floor plan. */
  listBetween(from: Date, to: Date): Promise<Reservation[]>
  create(r: NewReservation): Promise<Reservation>
  update(id: string, patch: ReservationPatch): Promise<void>
  subscribe(onChange: () => void): () => void
}

/** A table shows its booking on the floor plan from this long before the time… */
export const UPCOMING_HOURS = 3
/** …until this long after it, while the customer may still be on their way. */
export const LATE_MINUTES = 30

/** Bookings shown on the floor plan right now: confirmed, with a table, from LATE_MINUTES ago to UPCOMING_HOURS ahead. */
export function upcomingWindow(now = new Date()): [Date, Date] {
  return [new Date(now.getTime() - LATE_MINUTES * 60_000), new Date(now.getTime() + UPCOMING_HOURS * 3_600_000)]
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
        .gte('reserved_at', from.toISOString()).lte('reserved_at', to.toISOString()).order('reserved_at')
      // Before the migration the floor plan simply shows no bookings.
      if (res.error) return []
      return (res.data as Reservation[]).map(norm)
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
      return sorted(read()).filter((r) => r.status === 'confirmed' && new Date(r.reserved_at) >= from && new Date(r.reserved_at) <= to)
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

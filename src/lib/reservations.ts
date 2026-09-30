import type { SupabaseClient } from '@supabase/supabase-js'
import { repo, sharedChannel, supabase } from './repo'
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
  /**
   * Honorée: opens an order on the table (which turns occupied at once) and marks the booking honored with that order,
   * in one step. The table must be free. Returns the order id.
   */
  honor(id: string, tableId: string): Promise<string>
  /** Whether an order was opened by Honorée: such an order keeps its table occupied even with no item yet. */
  hasOrder(orderId: string): Promise<boolean>
  subscribe(onChange: () => void): () => void
}

/** A table shows its booking on the floor plan during the hours before it, never after its time. */
export const UPCOMING_HOURS = 3
/** A booking still Confirmée this long after its time becomes No-show (same rule in expire_reservations()). */
export const NO_SHOW_AFTER_MINUTES = 60

/** Bookings shown on the floor plan: confirmed, from now to UPCOMING_HOURS ahead. */
export function floorWindow(now = new Date()): [Date, Date] {
  return [now, new Date(now.getTime() + UPCOMING_HOURS * 3_600_000)]
}

/** The booking to show on each table: its next one (the earliest, when a table has several). */
export function bookingsByTable(list: Reservation[], now = new Date()): Map<string, Reservation> {
  const byTable = new Map<string, Reservation>()
  for (const r of [...list].sort((a, b) => a.reserved_at.localeCompare(b.reserved_at))) {
    if (r.status !== 'confirmed' || !r.table_id || new Date(r.reserved_at) < now) continue
    if (!byTable.has(r.table_id)) byTable.set(r.table_id, r)
  }
  return byTable
}

/** Whether a Confirmée booking is past the No-show delay. */
const expired = (r: Reservation, now = Date.now()) =>
  r.status === 'confirmed' && new Date(r.reserved_at).getTime() < now - NO_SHOW_AFTER_MINUTES * 60_000

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
  if (/honor_reservation|order_id/.test(message) && /does not exist|schema cache|Could not find/i.test(message)) return new Error(t.errMigrationHonor)
  if (message.includes('permission_denied')) return new Error(t.errNoPermission)
  if (message.includes('table_has_order')) return new Error(t.errResTableBusy)
  if (message.includes('reservation_not_confirmed')) return new Error(t.errResNotConfirmed)
  return new Error(message)
}

function supabaseReservations(sb: SupabaseClient): ReservationsService {
  const check = <T>(res: { data: T; error: { message: string } | null }): T => {
    if (res.error) throw resError(res.error.message)
    return res.data
  }
  const channel = sharedChannel(sb, 'reservations', ['reservations'])
  /** Confirmée bookings past the delay become No-show before every read (ignored before the migration). */
  const expire = () => sb.rpc('expire_reservations').then(() => undefined, () => undefined)
  return {
    async list() {
      await expire()
      return (check(await sb.from('reservations').select('*').order('reserved_at')) as Reservation[]).map(norm)
    },
    async listBetween(from, to) {
      await expire()
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
    async honor(id, tableId) {
      return check(await sb.rpc('honor_reservation', { p_reservation_id: id, p_table_id: tableId })) as string
    },
    async hasOrder(orderId) {
      const res = await sb.from('reservations').select('id').eq('order_id', orderId).limit(1)
      // Before the migration no order can come from a booking.
      return !res.error && (res.data?.length ?? 0) > 0
    },
    subscribe: channel,
  }
}

const KEY = 'smile.reservations.v1'

function localReservations(): ReservationsService {
  const listeners = new Set<() => void>()
  /** Saved bookings, with those Confirmée past the delay turned No-show (and saved so). */
  const read = (): Reservation[] => {
    let rs: Reservation[]
    try {
      rs = (JSON.parse(localStorage.getItem(KEY) ?? '[]') as Reservation[]).map(norm)
    } catch {
      return []
    }
    if (!rs.some((r) => expired(r))) return rs
    rs = rs.map((r) => (expired(r) ? { ...r, status: 'no_show' as const } : r))
    try {
      localStorage.setItem(KEY, JSON.stringify(rs))
    } catch {
      // Storage blocked: shown as No-show anyway.
    }
    return rs
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
    async honor(id, tableId) {
      const t = tr()
      const r = read().find((x) => x.id === id)
      if (!r || r.status !== 'confirmed') throw new Error(t.errResNotConfirmed)
      if (await repo.getOpenOrder(tableId)) throw new Error(t.errResTableBusy)
      const table = (await repo.listAllTables()).find((x) => x.id === tableId)
      const order = await repo.openOrder(tableId)
      write(read().map((x) => (x.id === id ? { ...x, status: 'honored', hall_id: table?.hall_id ?? x.hall_id, table_id: tableId, order_id: order.id } : x)))
      return order.id
    },
    async hasOrder(orderId) {
      return read().some((r) => r.order_id === orderId)
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

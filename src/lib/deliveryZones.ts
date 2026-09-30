import type { SupabaseClient } from '@supabase/supabase-js'
import { sharedChannel, supabase } from './repo'
import { tr } from './i18n'
import type { DeliveryZone, NewDeliveryZone } from './types'
import { newId } from './id'

/**
 * Delivery zones (menu Édition > Zones de livraison, and the zone picker of a delivery order). Supabase table
 * `delivery_zones` (migration 20260930030000_delivery_zones.sql), or localStorage in demo mode, like `repo`.
 */
export interface DeliveryZonesService {
  /** All zones, by name. */
  list(): Promise<DeliveryZone[]>
  create(zone: NewDeliveryZone): Promise<DeliveryZone>
  update(id: string, zone: NewDeliveryZone): Promise<void>
  /** Orders that used the zone keep its name and fee. */
  remove(id: string): Promise<void>
  subscribe(onChange: () => void): () => void
}

const norm = (z: DeliveryZone): DeliveryZone => ({
  id: z.id, name: z.name, fee: Number(z.fee), estimated_time: z.estimated_time == null ? null : Number(z.estimated_time),
})

const byName = (a: DeliveryZone, b: DeliveryZone) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })

/** Checks and trims a zone before it is saved. */
function clean(z: NewDeliveryZone): NewDeliveryZone {
  const t = tr()
  const name = z.name.trim()
  if (!name) throw new Error(t.errZoneName)
  if (!(Number.isFinite(z.fee) && z.fee >= 0)) throw new Error(t.errZoneFee)
  if (z.estimated_time !== null && !(Number.isInteger(z.estimated_time) && z.estimated_time >= 1 && z.estimated_time <= 1440)) {
    throw new Error(t.errZoneTime)
  }
  return { name, fee: Math.round(z.fee * 100) / 100, estimated_time: z.estimated_time }
}

function zoneError(message: string): Error {
  const t = tr()
  if (/delivery_zones/.test(message) && /does not exist|schema cache|Could not find/i.test(message)) return new Error(t.errMigrationZones)
  if (/delivery_zones_name_key|duplicate key/i.test(message)) return new Error(t.errZoneDuplicate)
  if (/row-level security|permission denied/i.test(message)) return new Error(t.errNoPermission)
  return new Error(message)
}

function supabaseZones(sb: SupabaseClient): DeliveryZonesService {
  const check = <T>(res: { data: T; error: { message: string } | null }): T => {
    if (res.error) throw zoneError(res.error.message)
    return res.data
  }
  return {
    async list() {
      return (check(await sb.from('delivery_zones').select('id, name, fee, estimated_time')) as DeliveryZone[]).map(norm).sort(byName)
    },
    async create(zone) {
      return norm(check(await sb.from('delivery_zones').insert(clean(zone)).select('id, name, fee, estimated_time').single()) as DeliveryZone)
    },
    async update(id, zone) {
      check(await sb.from('delivery_zones').update(clean(zone)).eq('id', id))
    },
    async remove(id) {
      check(await sb.from('delivery_zones').delete().eq('id', id))
    },
    subscribe: sharedChannel(sb, 'delivery_zones', ['delivery_zones']),
  }
}

const KEY = 'smile.deliveryZones.v1'

function localZones(): DeliveryZonesService {
  const listeners = new Set<() => void>()
  const read = (): DeliveryZone[] => {
    try {
      return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as DeliveryZone[]).map(norm)
    } catch {
      return []
    }
  }
  const write = (zones: DeliveryZone[]) => {
    localStorage.setItem(KEY, JSON.stringify(zones))
    listeners.forEach((l) => l())
  }
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) listeners.forEach((l) => l())
  })
  const refuseDuplicate = (name: string, id?: string) => {
    if (read().some((z) => z.id !== id && z.name.trim().toLowerCase() === name.toLowerCase())) throw new Error(tr().errZoneDuplicate)
  }
  return {
    async list() {
      return read().sort(byName)
    },
    async create(zone) {
      const row = { id: newId(), ...clean(zone) }
      refuseDuplicate(row.name)
      write([...read(), row])
      return row
    },
    async update(id, zone) {
      const fields = clean(zone)
      refuseDuplicate(fields.name, id)
      write(read().map((z) => (z.id === id ? { ...z, ...fields } : z)))
    },
    async remove(id) {
      write(read().filter((z) => z.id !== id))
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

export const deliveryZones: DeliveryZonesService = supabase ? supabaseZones(supabase) : localZones()

/** "Hydra · 200 DA · ≈ 30 min", for the zone picker. */
export function zoneLabel(z: DeliveryZone, money: (n: number) => string, minutes: (n: number) => string): string {
  return [z.name, money(z.fee), z.estimated_time ? minutes(z.estimated_time) : null].filter(Boolean).join(' · ')
}

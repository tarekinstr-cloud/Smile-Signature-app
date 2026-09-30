import type { SupabaseClient } from '@supabase/supabase-js'
import { PRICE_LOG_KEY, sharedChannel, supabase } from './repo'
import { tr } from './i18n'
import type { PriceChange } from './types'

/** Liste des modifications des prix: written by the database (triggers on items and options), only read here. */
export interface PriceLogService {
  /** Changes made during [from, to), newest first. */
  list(from: Date, to: Date): Promise<PriceChange[]>
  subscribe(onChange: () => void): () => void
}

const norm = (c: PriceChange): PriceChange => ({ ...c, old_price: Number(c.old_price), new_price: Number(c.new_price) })

function supabasePriceLog(sb: SupabaseClient): PriceLogService {
  return {
    async list(from, to) {
      const res = await sb.from('price_changes').select('*').gte('created_at', from.toISOString()).lt('created_at', to.toISOString())
        .order('created_at', { ascending: false }).limit(5000)
      if (res.error) {
        const t = tr()
        if (/price_changes/.test(res.error.message) && /does not exist|schema cache|Could not find/i.test(res.error.message)) throw new Error(t.errMigrationControl)
        if (/permission denied|row-level security/i.test(res.error.message)) throw new Error(t.errNoPermission)
        throw new Error(res.error.message)
      }
      return (res.data as PriceChange[]).map(norm)
    },
    subscribe: sharedChannel(sb, 'price-log', ['price_changes']),
  }
}

function localPriceLog(): PriceLogService {
  const listeners = new Set<() => void>()
  window.addEventListener('storage', (e) => {
    if (e.key === PRICE_LOG_KEY) listeners.forEach((l) => l())
  })
  return {
    async list(from, to) {
      let all: PriceChange[] = []
      try {
        all = JSON.parse(localStorage.getItem(PRICE_LOG_KEY) ?? '[]') as PriceChange[]
      } catch {
        // Unreadable: nothing logged.
      }
      return all.filter((c) => new Date(c.created_at) >= from && new Date(c.created_at) < to).map(norm)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
    },
    subscribe(onChange) {
      listeners.add(onChange)
      return () => {
        listeners.delete(onChange)
      }
    },
  }
}

export const priceLog: PriceLogService = supabase ? supabasePriceLog(supabase) : localPriceLog()

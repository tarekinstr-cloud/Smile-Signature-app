import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from './repo'
import { backOffice, editLocalStock, insufficientStock, localMovement, localUserName, stockRpcError } from './backoffice'
import { tr } from './i18n'
import type { ChargeReason, MovementFilter, MovementLine, StockLocation, StockMovement, StockMovementType, TransferDirection } from './types'
import { CHARGE_REASONS } from './types'
import { newId } from './id'
import { nowIso, tzDate } from './tz'

/**
 * Transfert dépôt / cuisine and Charges cuisine (menu Gestion du Stock). Supabase RPCs transfer_stock and
 * record_kitchen_charge, which change the quantities and write the stock_movements lines in one transaction
 * (migration 20260930080000_stock_locations.sql), or localStorage in demo mode, like `repo`.
 */
export interface StockMovesService {
  /** Moves the quantities from the Dépôt to the Cuisine (to_kitchen) or back (to_depot). All or nothing. */
  transfer(direction: TransferDirection, lines: MovementLine[], note: string): Promise<StockMovement[]>
  /** Takes the quantities out of the Cuisine stock with a motif. All or nothing. */
  charge(reason: ChargeReason, lines: MovementLine[], note: string): Promise<StockMovement[]>
  /** History, newest first: transfers and returns, or charges. */
  list(kind: 'transfers' | 'charges', filter: MovementFilter): Promise<StockMovement[]>
  /** Same shared « stock » channel as the stock page. */
  subscribe(onChange: () => void): () => void
}

/** At most this many lines in a history (the filters narrow it down). */
export const HISTORY_LIMIT = 500

const round3 = (n: number) => Math.round(n * 1000) / 1000
export const round2 = (n: number) => Math.round(n * 100) / 100
/** Estimated value of a charge: quantity × last purchase price; null when the item was never bought. */
export const movementValue = (m: Pick<StockMovement, 'quantity' | 'unit_cost'>) => (m.unit_cost == null ? null : round2(m.quantity * m.unit_cost))

const TYPES: Record<'transfers' | 'charges', StockMovementType[]> = { transfers: ['transfer', 'return'], charges: ['charge'] }

/** Start (included) and end (excluded) of the days (Algiers) of a filter, as ISO times. */
function range(f: MovementFilter): [string | null, string | null] {
  const day = (iso: string, plus: number) => {
    const [y, m, d] = iso.split('-').map(Number)
    return tzDate(y, m - 1, d + plus).toISOString()
  }
  return [f.from ? day(f.from, 0) : null, f.to ? day(f.to, 1) : null]
}

/** Same item twice in a form: one line with the sum, as the database does. */
function merge(lines: MovementLine[]): MovementLine[] {
  const t = tr()
  if (!lines.length) throw new Error(t.errMoveLines)
  const byId = new Map<string, number>()
  for (const l of lines) {
    if (!l.stock_item_id) throw new Error(t.errPurchaseItem)
    if (!(Number.isFinite(l.quantity) && l.quantity > 0)) throw new Error(t.errQuantity)
    byId.set(l.stock_item_id, round3((byId.get(l.stock_item_id) ?? 0) + l.quantity))
  }
  return [...byId].map(([stock_item_id, quantity]) => ({ stock_item_id, quantity }))
}

function movesError(message: string): Error {
  if (/stock_movements|transfer_stock|record_kitchen_charge|kitchen_quantity/.test(message) && /does not exist|schema cache|Could not find/i.test(message)) {
    return new Error(tr().errMigrationStockMoves)
  }
  if (message.includes('bad_reason')) return new Error(tr().errChargeReason)
  return stockRpcError(message) ?? new Error(message)
}

const norm = (m: StockMovement): StockMovement => ({
  ...m, quantity: Number(m.quantity), unit_cost: m.unit_cost == null ? null : Number(m.unit_cost), note: m.note ?? '', user_name: m.user_name ?? '',
})

function supabaseMoves(sb: SupabaseClient): StockMovesService {
  const check = <T>(res: { data: T; error: { message: string } | null }): T => {
    if (res.error) throw movesError(res.error.message)
    return res.data
  }
  return {
    async transfer(direction, lines, note) {
      return (check(await sb.rpc('transfer_stock', { p_direction: direction, p_lines: merge(lines), p_note: note.trim() })) as StockMovement[]).map(norm)
    },
    async charge(reason, lines, note) {
      if (!CHARGE_REASONS.includes(reason)) throw new Error(tr().errChargeReason)
      return (check(await sb.rpc('record_kitchen_charge', { p_reason: reason, p_lines: merge(lines), p_note: note.trim() })) as StockMovement[]).map(norm)
    },
    async list(kind, filter) {
      const [from, to] = range(filter)
      let q = sb.from('stock_movements').select('*').in('type', TYPES[kind])
      if (from) q = q.gte('created_at', from)
      if (to) q = q.lt('created_at', to)
      if (filter.stock_item_id) q = q.eq('stock_item_id', filter.stock_item_id)
      if (filter.reason) q = q.eq('reason', filter.reason)
      return (check(await q.order('created_at', { ascending: false }).limit(HISTORY_LIMIT)) as StockMovement[]).map(norm)
    },
    subscribe: (onChange) => backOffice.subscribeStock(onChange),
  }
}

// ───────────── Demo mode (localStorage, same store as the stock) ─────────────

function localMoves(): StockMovesService {
  /** Checks every line against what the place holds, then moves them all (nothing moves if one line is short). */
  async function move(lines: MovementLine[], from: StockLocation, to: StockLocation | null, extra: Partial<StockMovement>): Promise<StockMovement[]> {
    const merged = merge(lines)
    const user = await localUserName()
    const batch = newId()
    const held = (s: { quantity: number; kitchen_quantity: number }, l: StockLocation) => (l === 'depot' ? s.quantity : s.kitchen_quantity)
    return editLocalStock((db) => {
      const items = merged.map((l) => {
        const item = db.stock.find((s) => s.id === l.stock_item_id)
        if (!item) throw new Error(tr().errStockGone)
        if (held(item, from) < l.quantity) throw insufficientStock(item.name, item.unit, from, held(item, from), l.quantity)
        return item
      })
      return merged.map((l, i) => {
        const item = items[i]
        if (from === 'depot') item.quantity = round3(item.quantity - l.quantity)
        else item.kitchen_quantity = round3(item.kitchen_quantity - l.quantity)
        if (to === 'depot') item.quantity = round3(item.quantity + l.quantity)
        if (to === 'kitchen') item.kitchen_quantity = round3(item.kitchen_quantity + l.quantity)
        item.updated_at = nowIso()
        const m = localMovement({
          type: 'transfer', item, quantity: l.quantity, from_location: from, to_location: to, batch_id: batch, user_name: user, ...extra,
          ...(extra.type === 'charge' && { unit_cost: lastPrice(db.movements, item.id) }),
        })
        db.movements.push(m)
        return m
      })
    })
  }
  /** Last purchase price of an item, from the demo purchase movements. */
  const lastPrice = (moves: StockMovement[], itemId: string) =>
    [...moves].reverse().find((m) => m.type === 'purchase' && !m.voided && m.stock_item_id === itemId)?.unit_cost ?? null

  return {
    async transfer(direction, lines, note) {
      return direction === 'to_kitchen'
        ? move(lines, 'depot', 'kitchen', { type: 'transfer', note: note.trim() })
        : move(lines, 'kitchen', 'depot', { type: 'return', note: note.trim() })
    },
    async charge(reason, lines, note) {
      if (!CHARGE_REASONS.includes(reason)) throw new Error(tr().errChargeReason)
      return move(lines, 'kitchen', null, { type: 'charge', reason, note: note.trim() })
    },
    async list(kind, filter) {
      const [from, to] = range(filter)
      return editLocalStock((db) => db.movements)
        .filter((m) => TYPES[kind].includes(m.type)
          && (!from || m.created_at >= from) && (!to || m.created_at < to)
          && (!filter.stock_item_id || m.stock_item_id === filter.stock_item_id)
          && (!filter.reason || m.reason === filter.reason))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, HISTORY_LIMIT)
    },
    subscribe: (onChange) => backOffice.subscribeStock(onChange),
  }
}

export const stockMoves: StockMovesService = supabase ? supabaseMoves(supabase) : localMoves()

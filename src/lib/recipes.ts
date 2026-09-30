import type { SupabaseClient } from '@supabase/supabase-js'
import { onLocalOrderPaid, repo, supabase } from './repo'
import { backOffice, editLocalStock, localMovement, localUserName, stockRpcError } from './backoffice'
import { tr } from './i18n'
import type {
  ConsumptionRow, MenuItem, OptionGroup, OrderLine, PaidOrder, RecipeLine, RecipeLineInput, RecipeStockItem, StockMovement,
} from './types'
import { newId } from './id'

/**
 * Fiches techniques (Édition > Gérer les articles, Édition > Fiches techniques) and the automatic consumption of the
 * Cuisine stock by the sales. Supabase: table recipe_lines written by save_recipe(); the consumption is done by the
 * database when an order becomes paid (trigger orders_consume_stock, migration 20260930100000_recipes.sql), once per
 * order. Demo mode: localStorage, and the same consumption when the demo repo closes an order.
 */
export interface RecipesService {
  /** Every line of every fiche. */
  list(): Promise<RecipeLine[]>
  /** Stock items offered as ingredients, with their last purchase price per stock unit. */
  stockItems(): Promise<RecipeStockItem[]>
  /** Replaces the whole fiche of an item (base, sizes and supplements) in one step. */
  save(itemId: string, lines: RecipeLineInput[]): Promise<RecipeLine[]>
  /** Consommation théorique vs réelle over [from, to[. */
  consumption(from: Date, to: Date): Promise<ConsumptionRow[]>
  /** Paid orders whose consumption failed and waits for a retry. */
  failures(): Promise<number>
  /** Retries them; returns how many were taken out of the stock. */
  retry(): Promise<number>
  /** When the automatic consumption started: orders paid before are never taken out of the stock. */
  startedAt(): Promise<string | null>
  /** Same shared « stock » channel as the stock pages (it also watches recipe_lines). */
  subscribe(onChange: () => void): () => void
}

const round2 = (n: number) => Math.round(n * 100) / 100
const round3 = (n: number) => Math.round(n * 1000) / 1000
const round6 = (n: number) => Math.round(n * 1e6) / 1e6

// ───────────── Menu variants and costs (shared by the screens and the demo consumption) ─────────────

/** The item's sizes: its first required pick-one group, as on the order screen. */
export const sizeGroup = (groups: OptionGroup[]) => groups.find((g) => g.min_select >= 1 && g.max_select === 1 && g.options.length > 0)

/** One fiche of an item: its base (every size), one of its sizes, or one of its supplements / other options. */
export interface RecipeVariant {
  /** null: the item's base fiche. */
  option_id: string | null
  kind: 'base' | 'size' | 'option'
  label: string
  /** Group of an option (Suppléments, Cuisson…). */
  group?: string
  /** Sale price of one portion: item price (+ size), or what the option adds. */
  price: number
}

export function itemVariants(item: MenuItem, groups: OptionGroup[]): RecipeVariant[] {
  const sizes = sizeGroup(groups)
  const base: RecipeVariant = { option_id: null, kind: 'base', label: '', price: item.price }
  return [
    base,
    ...(sizes?.options.map((o): RecipeVariant => ({ option_id: o.id, kind: 'size', label: o.name, group: sizes.name, price: item.price + o.price_delta })) ?? []),
    ...groups.filter((g) => g !== sizes).flatMap((g) => g.options.map((o): RecipeVariant => ({
      option_id: o.id, kind: 'option', label: o.name, group: g.name, price: o.price_delta,
    }))),
  ]
}

/** Cost of some fiche lines: Σ quantity × last purchase price. missing: ingredients never bought (not counted). */
export function linesCost(lines: Pick<RecipeLine, 'stock_item_id' | 'quantity'>[], prices: Map<string, number | null>) {
  let cost = 0
  let missing = 0
  for (const l of lines) {
    const p = prices.get(l.stock_item_id)
    if (p == null) missing++
    else cost += l.quantity * p
  }
  return { cost: round2(cost), missing }
}

/** Margin of a sale price over a cost: in DA and in % of the price (null when the price is 0). */
export function margin(price: number, cost: number) {
  const amount = round2(price - cost)
  return { amount, percent: price > 0 ? Math.round((amount / price) * 1000) / 10 : null }
}

/**
 * Cost of one portion of a variant: a size adds its own lines to the base fiche; a supplement counts alone (it is
 * sold on top of the item).
 */
export function variantCost(v: RecipeVariant, lines: RecipeLine[], prices: Map<string, number | null>) {
  const own = lines.filter((l) => l.option_id === v.option_id)
  const withBase = v.kind === 'size' ? [...lines.filter((l) => l.option_id === null), ...own] : own
  return { ...linesCost(withBase, prices), lines: withBase.length }
}

/**
 * What is missing on an item's fiches: 'none' when it has no line at all, the names of the sizes without any line
 * (and no base fiche to cover them), or null when every portion sold consumes something.
 */
export function missingRecipe(item: MenuItem, groups: OptionGroup[], lines: RecipeLine[]): 'none' | string[] | null {
  const mine = lines.filter((l) => l.item_id === item.id)
  if (!mine.length) return 'none'
  const sizes = sizeGroup(groups)
  if (!sizes || mine.some((l) => l.option_id === null)) return null
  const missing = sizes.options.filter((o) => !mine.some((l) => l.option_id === o.id)).map((o) => o.name)
  return missing.length ? missing : null
}

const norm = (s: string) => s.trim().toLowerCase()

/**
 * Ingredients an order consumes: for each line, (the item's base fiche + the fiche of each option chosen) × portions.
 * Options are found by option_id, or by group and name on older lines. Same rules as order_consumption_needs().
 */
export function consumptionNeeds(lines: Pick<OrderLine, 'item_id' | 'quantity' | 'options'>[], groups: Record<string, OptionGroup[]>, recipe: RecipeLine[]) {
  const needs = new Map<string, number>()
  const add = (id: string, q: number) => needs.set(id, (needs.get(id) ?? 0) + q)
  for (const l of lines) {
    if (!l.item_id) continue
    for (const r of recipe) if (r.item_id === l.item_id && r.option_id === null) add(r.stock_item_id, l.quantity * r.quantity)
    const chosen = new Set<string>()
    for (const c of l.options ?? []) {
      for (const g of groups[l.item_id] ?? []) {
        for (const o of g.options) {
          if (c.option_id ? o.id === c.option_id : norm(g.name) === norm(c.group) && norm(o.name) === norm(c.name)) chosen.add(o.id)
        }
      }
    }
    for (const id of chosen) for (const r of recipe) if (r.option_id === id) add(r.stock_item_id, l.quantity * r.quantity)
  }
  return new Map([...needs].map(([id, q]) => [id, round3(q)] as const).filter(([, q]) => q > 0))
}

/**
 * Duplique la fiche: copies the lines of an item onto another one. The base goes to the base; an option goes to the
 * option of the same group and name, or else (sizes) to the size at the same place. Options with no match are dropped.
 */
export function copyRecipe(
  from: { lines: RecipeLine[]; groups: OptionGroup[] },
  to: { groups: OptionGroup[] },
): { lines: RecipeLineInput[]; dropped: number } {
  const fromSizes = sizeGroup(from.groups)
  const toSizes = sizeGroup(to.groups)
  const target = (optionId: string): string | null => {
    const g = from.groups.find((x) => x.options.some((o) => o.id === optionId))
    const o = g?.options.find((x) => x.id === optionId)
    if (!g || !o) return null
    const byName = to.groups.find((x) => norm(x.name) === norm(g.name))?.options.find((x) => norm(x.name) === norm(o.name))
      ?? (g === fromSizes ? toSizes?.options.find((x) => norm(x.name) === norm(o.name)) : undefined)
    if (byName) return byName.id
    if (g === fromSizes && toSizes) return toSizes.options[g.options.indexOf(o)]?.id ?? null
    return null
  }
  let dropped = 0
  const out: RecipeLineInput[] = []
  for (const l of [...from.lines].sort((a, b) => a.position - b.position)) {
    const option_id = l.option_id === null ? null : target(l.option_id)
    if (l.option_id !== null && option_id === null) {
      dropped++
      continue
    }
    // Two source options may land on the same target: the first one wins.
    if (out.some((x) => x.option_id === option_id && x.stock_item_id === l.stock_item_id)) continue
    out.push({ option_id, stock_item_id: l.stock_item_id, quantity: l.quantity, input_unit: l.input_unit, input_quantity: l.input_quantity })
  }
  return { lines: out, dropped }
}

/** Checks the lines of a fiche before they are sent: quantities > 0, an ingredient once per variant. */
function checkLines(lines: RecipeLineInput[]): RecipeLineInput[] {
  const t = tr()
  const seen = new Set<string>()
  return lines.map((l) => {
    if (!l.stock_item_id) throw new Error(t.errRecipeIngredient)
    if (!(Number.isFinite(l.quantity) && l.quantity > 0)) throw new Error(t.errQuantity)
    const k = `${l.option_id ?? ''}:${l.stock_item_id}`
    if (seen.has(k)) throw new Error(t.errRecipeDuplicate)
    seen.add(k)
    return { ...l, quantity: round6(l.quantity), input_unit: l.input_unit.trim() }
  })
}

function recipesError(message: string): Error {
  const t = tr()
  if (/recipe_lines|save_recipe|recipe_stock_items|consumption_report|order_stock_consumptions|recipe_settings|retry_stock_consumptions/.test(message)
    && /does not exist|schema cache|Could not find/i.test(message)) {
    return new Error(t.errMigrationRecipes)
  }
  if (message.includes('duplicate_ingredient')) return new Error(t.errRecipeDuplicate)
  if (message.includes('option_not_found') || message.includes('item_not_found')) return new Error(t.errRecipeMenuChanged)
  if (message.includes('bad_period')) return new Error(t.errPeriod)
  return stockRpcError(message) ?? new Error(message)
}

const num = (v: unknown) => Number(v ?? 0)
const numOrNull = (v: unknown) => (v == null ? null : Number(v))
const normLine = (l: RecipeLine): RecipeLine => ({
  ...l, quantity: num(l.quantity), input_quantity: numOrNull(l.input_quantity), input_unit: l.input_unit ?? '', option_id: l.option_id ?? null,
})

function supabaseRecipes(sb: SupabaseClient): RecipesService {
  const check = <T>(res: { data: T; error: { message: string } | null }): T => {
    if (res.error) throw recipesError(res.error.message)
    return res.data
  }
  return {
    async list() {
      return (check(await sb.from('recipe_lines').select('*').order('position')) as RecipeLine[]).map(normLine)
    },
    async stockItems() {
      return (check(await sb.rpc('recipe_stock_items')) as RecipeStockItem[]).map((s) => ({
        ...s, unit: s.unit ?? '', purchase_unit: s.purchase_unit ?? '', purchase_factor: numOrNull(s.purchase_factor), last_price: numOrNull(s.last_price),
      }))
    },
    async save(itemId, lines) {
      return (check(await sb.rpc('save_recipe', { p_item_id: itemId, p_lines: checkLines(lines) })) as RecipeLine[]).map(normLine)
    },
    async consumption(from, to) {
      if (!(to > from)) throw new Error(tr().errPeriod)
      return (check(await sb.rpc('consumption_report', { p_from: from.toISOString(), p_to: to.toISOString() })) as ConsumptionRow[]).map((r) => ({
        ...r, unit: r.unit ?? '', theoretical: num(r.theoretical), charges: num(r.charges), inventory_gap: num(r.inventory_gap), actual: num(r.actual),
        last_price: numOrNull(r.last_price),
      }))
    },
    async failures() {
      const res = await sb.from('order_stock_consumptions').select('order_id', { count: 'exact', head: true }).eq('status', 'error')
      // Before the migration (or without the right to read it): nothing to show.
      return res.error ? 0 : res.count ?? 0
    },
    async retry() {
      return num(check(await sb.rpc('retry_stock_consumptions')))
    },
    async startedAt() {
      const res = await sb.from('recipe_settings').select('consumption_started_at').maybeSingle()
      return res.error ? null : (res.data as { consumption_started_at: string } | null)?.consumption_started_at ?? null
    },
    subscribe: (onChange) => backOffice.subscribeStock(onChange),
  }
}

// ───────────── Demo mode (localStorage) ─────────────

const KEY = 'smile.recipes.v1'

interface LocalRecipes {
  lines: RecipeLine[]
  /** Orders already taken out of the stock: never twice. */
  consumed: string[]
  startedAt: string
}

function read(): LocalRecipes {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<LocalRecipes> | null
    if (saved?.startedAt) return { lines: saved.lines ?? [], consumed: saved.consumed ?? [], startedAt: saved.startedAt }
  } catch {
    // Unreadable: start again.
  }
  const db = { lines: [], consumed: [], startedAt: new Date().toISOString() }
  write(db)
  return db
}

function write(db: LocalRecipes) {
  try {
    localStorage.setItem(KEY, JSON.stringify(db))
  } catch {
    // Not persisted (private mode); kept for this visit only.
  }
}

/** Last purchase price per stock unit of each item, from the demo purchase movements. */
const lastPrices = (moves: StockMovement[]) => {
  const last = new Map<string, number>()
  for (const m of moves) if (m.type === 'purchase' && m.stock_item_id && m.unit_cost != null) last.set(m.stock_item_id, m.unit_cost)
  return last
}

/** Demo consumption of a paid order, once; the Cuisine may go below 0 (a sale is never refused). */
async function consumeLocal(order: PaidOrder, lines: OrderLine[]) {
  const db = read()
  if (db.consumed.includes(order.id) || (order.closed_at && order.closed_at < db.startedAt)) return
  db.consumed.push(order.id)
  write(db)
  if (!db.lines.length) return
  const menu = await repo.getMenu({ includeHidden: true })
  const needs = consumptionNeeds(lines, menu.groups, db.lines)
  if (!needs.size) return
  const user = await localUserName()
  const batch = newId()
  const note = `Commande${order.ticket_no != null ? ` n° ${order.ticket_no}` : ''}`
  editLocalStock((s) => {
    const prices = lastPrices(s.movements)
    for (const [id, quantity] of needs) {
      const item = s.stock.find((x) => x.id === id)
      if (!item) continue
      item.kitchen_quantity = round3(item.kitchen_quantity - quantity)
      item.updated_at = new Date().toISOString()
      s.movements.push(localMovement({
        type: 'consumption', item, quantity, from_location: 'kitchen', batch_id: batch, user_name: user, note, order_id: order.id,
        unit_cost: prices.get(id) ?? null,
      }))
    }
  })
  // Other tabs of this browser follow through the storage event; this one through its own pages' reloads.
  window.dispatchEvent(new StorageEvent('storage', { key: 'smile.backoffice.v1' }))
}

function localRecipes(): RecipesService {
  // The automatic consumption starts now, for the orders paid from here on.
  read()
  onLocalOrderPaid((order, lines) => {
    consumeLocal(order, lines).catch(() => {
      // The sale is done; the demo stock is simply not updated.
    })
  })
  return {
    async list() {
      return [...read().lines].sort((a, b) => a.position - b.position)
    },
    async stockItems() {
      const stock = await backOffice.listStock()
      const prices = editLocalStock((s) => lastPrices(s.movements))
      return stock.map((s) => ({
        id: s.id, name: s.name, unit: s.unit, purchase_unit: s.purchase_unit, purchase_factor: s.purchase_factor, last_price: prices.get(s.id) ?? null,
      }))
    },
    async save(itemId, lines) {
      const checked = checkLines(lines)
      const [menu, stock] = await Promise.all([repo.getMenu({ includeHidden: true }), backOffice.listStock()])
      if (!menu.items.some((i) => i.id === itemId)) throw new Error(tr().errRecipeMenuChanged)
      const options = new Set((menu.groups[itemId] ?? []).flatMap((g) => g.options.map((o) => o.id)))
      if (checked.some((l) => l.option_id !== null && !options.has(l.option_id))) throw new Error(tr().errRecipeMenuChanged)
      if (checked.some((l) => !stock.some((s) => s.id === l.stock_item_id))) throw new Error(tr().errStockGone)
      const db = read()
      const saved = checked.map((l, position): RecipeLine => ({ id: newId(), item_id: itemId, position, ...l }))
      db.lines = [...db.lines.filter((l) => l.item_id !== itemId), ...saved]
      write(db)
      return saved
    },
    async consumption(from, to) {
      if (!(to > from)) throw new Error(tr().errPeriod)
      const f = from.toISOString()
      const e = to.toISOString()
      return editLocalStock((s) => {
        const prices = lastPrices(s.movements)
        const rows = new Map<string, ConsumptionRow>()
        for (const m of s.movements) {
          if (!m.stock_item_id || m.created_at < f || m.created_at >= e) continue
          const item = s.stock.find((x) => x.id === m.stock_item_id)
          if (!item) continue
          const r = rows.get(item.id) ?? {
            id: item.id, name: item.name, unit: item.unit, theoretical: 0, charges: 0, inventory_gap: 0, actual: 0, last_price: prices.get(item.id) ?? null,
          }
          if (m.type === 'consumption') r.theoretical += m.quantity
          else if (m.type === 'charge') r.charges += m.quantity
          else if (m.type === 'adjustment' && m.inventory_id) r.inventory_gap += (m.to_location ? m.quantity : 0) - (m.from_location ? m.quantity : 0)
          else continue
          rows.set(item.id, r)
        }
        return [...rows.values()]
          .map((r) => ({
            ...r, theoretical: round3(r.theoretical), charges: round3(r.charges), inventory_gap: round3(r.inventory_gap),
            actual: round3(r.theoretical + r.charges - r.inventory_gap),
          }))
          .filter((r) => r.theoretical || r.charges || r.inventory_gap)
          .sort((a, b) => a.name.localeCompare(b.name))
      })
    },
    async failures() {
      return 0
    },
    async retry() {
      return 0
    },
    async startedAt() {
      return read().startedAt
    },
    subscribe: (onChange) => backOffice.subscribeStock(onChange),
  }
}

export const recipes: RecipesService = supabase ? supabaseRecipes(supabase) : localRecipes()

import type { Repo } from './repo'
import { toCsv } from './admin'
import { tr } from './i18n'
import type { Category, Menu, MenuItem, OptionGroup } from './types'

/**
 * Import / export of the menu's items as CSV (Édition > Importer / Exporter les articles).
 *
 * One row per item, columns (French headers, ";" separators, as the backup CSV):
 *   categorie   category name (created when it does not exist yet)
 *   couleur     category colour, e.g. #b45309 (optional; only used to create a category)
 *   article     item name; an item is found again by category + name (case and spaces ignored)
 *   prix        base price in DA ("150", "150.5" or "150,5")
 *   actif       oui / non (empty: oui)
 *   tailles     required option groups (min ≥ 1), the first one being the size buttons of the order screen
 *   supplements optional option groups (min 0)
 * A group is written « Nom (min-max): Option=prix | Option=prix », groups separated by « ; ». The price of an option is
 * what it adds to the item's price (price_delta), as in the database. The group header may be left out:
 * « Petit=0 | Grand=100 » in tailles is a required pick-one group « Taille », in supplements an optional group
 * « Suppléments » where any number can be picked.
 * Items missing from the file are left as they are (an import never deletes).
 */

export const CSV_COLUMNS = ['categorie', 'couleur', 'article', 'prix', 'actif', 'tailles', 'supplements'] as const

/** An option group as written in the file: no ids, options in order. */
export interface CsvGroup {
  name: string
  min_select: number
  max_select: number
  options: { name: string; price_delta: number }[]
}

export interface CsvItem {
  category: string
  color: string | null
  name: string
  price: number
  active: boolean
  groups: CsvGroup[]
}

/** A line of the file that could not be read, with its number in the file (header = line 1). */
export interface CsvError {
  line: number
  text: string
  message: string
}

export interface PlannedChange {
  line: number
  item: CsvItem
  /** The item to change; undefined for a new item. */
  existing?: MenuItem
  /** New category to create first (name as in the file). */
  newCategory: boolean
  /** What changes on an existing item: prix, actif, options. */
  changes: ('price' | 'active' | 'options')[]
}

export interface ImportPlan {
  creates: PlannedChange[]
  updates: PlannedChange[]
  /** Rows identical to the menu. */
  unchanged: number
  errors: CsvError[]
  /** Categories the import will create. */
  newCategories: string[]
}

export interface ImportResult {
  created: number
  updated: number
  errors: CsvError[]
}

const key = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
const money = (n: number) => String(Math.round(n * 100) / 100)

// ───────────── Export ─────────────

function groupText(g: OptionGroup | CsvGroup): string {
  const opts = g.options.map((o) => `${o.name}=${o.price_delta > 0 ? '+' : ''}${money(o.price_delta)}`).join(' | ')
  return `${g.name} (${g.min_select}-${g.max_select}): ${opts}`
}

/** Every item of the menu (hidden ones too), sorted as in the admin screen. */
export function menuToCsv(menu: Menu): string {
  const rows: Record<string, unknown>[] = []
  for (const c of menu.categories) {
    for (const i of menu.items.filter((x) => x.category_id === c.id)) {
      const groups = menu.groups[i.id] ?? []
      rows.push({
        categorie: c.name,
        couleur: c.color,
        article: i.name,
        prix: money(i.price),
        actif: i.active ? 'oui' : 'non',
        tailles: groups.filter((g) => g.min_select >= 1).map(groupText).join(' ; '),
        supplements: groups.filter((g) => g.min_select < 1).map(groupText).join(' ; '),
      })
    }
  }
  if (!rows.length) rows.push(Object.fromEntries(CSV_COLUMNS.map((c) => [c, ''])))
  return toCsv(rows)
}

// ───────────── Reading the file ─────────────

/** Splits CSV text into rows of cells (quotes, doubled quotes and line breaks inside quotes), with each row's line number. */
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const src = text.replace(/^﻿/, '')
  const firstLine = src.split(/\r?\n/, 1)[0] ?? ''
  // The file may come from Excel in French (;), in English (,) or be tab separated.
  const counts = [';', ',', '\t'].map((d) => [d, firstLine.split(d).length] as const)
  const sep = counts.reduce((a, b) => (b[1] > a[1] ? b : a))[0]
  const rows: { line: number; cells: string[] }[] = []
  let cells: string[] = []
  let cell = ''
  let quoted = false
  let line = 1
  let start = 1
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        if (ch === '\n') line++
        cell += ch
      }
    } else if (ch === '"' && cell === '') {
      quoted = true
    } else if (ch === sep) {
      cells.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      cells.push(cell)
      rows.push({ line: start, cells })
      cells = []
      cell = ''
      line++
      start = line
    } else {
      cell += ch
    }
  }
  if (cell !== '' || cells.length) {
    cells.push(cell)
    rows.push({ line: start, cells })
  }
  return rows.filter((r) => r.cells.some((c) => c.trim() !== ''))
}

/** "150", "150,5", "+ 20", "1 200" → number; null when it is not a number. */
function number(text: string): number | null {
  const s = text.replace(/[\s ]/g, '').replace(/(DA|دج)$/i, '').replace(',', '.')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** One cell of groups: « Nom (min-max): A=0 | B=5 ; Nom2: … ». */
function parseGroups(text: string, required: boolean): CsvGroup[] {
  const t = tr()
  const groups: CsvGroup[] = []
  for (const part of text.split(';').map((s) => s.trim()).filter(Boolean)) {
    const head = part.match(/^([^:=|]+?)\s*(?:\((\d+)\s*-\s*(\d+)\))?\s*:(.*)$/s)
    const name = head ? head[1].trim() : required ? t.csvDefaultSizeGroup : t.csvDefaultSuppGroup
    const body = head ? head[4] : part
    const options = body.split('|').map((s) => s.trim()).filter(Boolean).map((o) => {
      const eq = o.lastIndexOf('=')
      const optName = (eq < 0 ? o : o.slice(0, eq)).trim()
      const price = eq < 0 ? 0 : number(o.slice(eq + 1))
      if (!optName) throw new Error(t.csvErrOptionName(part))
      if (price === null) throw new Error(t.csvErrOptionPrice(o))
      return { name: optName, price_delta: price }
    })
    if (!options.length) throw new Error(t.csvErrNoOptions(name))
    const names = new Set<string>()
    for (const o of options) {
      if (names.has(key(o.name))) throw new Error(t.csvErrDupOption(o.name, name))
      names.add(key(o.name))
    }
    const min = head?.[2] !== undefined ? Number(head[2]) : required ? 1 : 0
    const max = head?.[3] !== undefined ? Number(head[3]) : required ? 1 : options.length
    if (required && min < 1) throw new Error(t.csvErrSizeMin(name))
    if (!required && min > 0) throw new Error(t.csvErrSuppMin(name))
    if (max < 1 || min > max) throw new Error(t.csvErrMinMax(name))
    groups.push({ name, min_select: min, max_select: max, options })
  }
  return groups
}

/** Header cell → column: accents, case and spaces ignored ("Catégorie", "Suppléments", "Prix (DA)"…). */
function column(header: string): string {
  return header.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\(.*\)/, '').replace(/[^a-z]/g, '')
}

/** Reads the file into items, and the lines that could not be read. */
export function readCsv(text: string): { items: (CsvItem & { line: number })[]; errors: CsvError[] } {
  const t = tr()
  const rows = parseCsv(text)
  if (!rows.length) throw new Error(t.csvErrEmpty)
  const header = rows[0].cells.map(column)
  const at = (name: string) => header.indexOf(name)
  const cols = { categorie: at('categorie'), couleur: at('couleur'), article: at('article'), prix: at('prix'), actif: at('actif'),
    tailles: at('tailles'), supplements: at('supplements') }
  const missing = (['categorie', 'article', 'prix'] as const).filter((c) => cols[c] < 0)
  if (missing.length) throw new Error(t.csvErrColumns(missing.join(', ')))

  const items: (CsvItem & { line: number })[] = []
  const errors: CsvError[] = []
  const seen = new Map<string, number>()
  for (const { line, cells } of rows.slice(1)) {
    const cell = (i: number) => (i < 0 ? '' : (cells[i] ?? '').trim())
    const raw = cells.join(' ; ')
    try {
      const category = cell(cols.categorie)
      const name = cell(cols.article)
      if (!category) throw new Error(t.csvErrCategory)
      if (!name) throw new Error(t.csvErrName)
      const price = number(cell(cols.prix))
      if (price === null || price < 0) throw new Error(t.csvErrPrice(cell(cols.prix)))
      const activeText = key(cell(cols.actif))
      if (activeText && !['oui', 'non', 'yes', 'no', '1', '0', 'true', 'false', 'نعم', 'لا', 'x'].includes(activeText)) {
        throw new Error(t.csvErrActive(cell(cols.actif)))
      }
      const active = !['non', 'no', '0', 'false', 'لا'].includes(activeText)
      const color = cell(cols.couleur)
      const groups = [...parseGroups(cell(cols.tailles), true), ...parseGroups(cell(cols.supplements), false)]
      const groupNames = new Set<string>()
      for (const g of groups) {
        if (groupNames.has(key(g.name))) throw new Error(t.csvErrDupGroup(g.name))
        groupNames.add(key(g.name))
      }
      const id = `${key(category)}\u0000${key(name)}`
      const first = seen.get(id)
      if (first !== undefined) throw new Error(t.csvErrDuplicate(first))
      seen.set(id, line)
      items.push({ line, category, color: /^#[0-9a-f]{6}$/i.test(color) ? color : null, name, price: Math.round(price * 100) / 100, active, groups })
    } catch (e) {
      errors.push({ line, text: raw, message: e instanceof Error ? e.message : String(e) })
    }
  }
  return { items, errors }
}

// ───────────── Preview: what the import will create or change ─────────────

const sameGroups = (a: OptionGroup[], b: CsvGroup[]) =>
  a.length === b.length && a.every((g, i) =>
    g.name.trim() === b[i].name && g.min_select === b[i].min_select && g.max_select === b[i].max_select
    && g.options.length === b[i].options.length
    && g.options.every((o, j) => o.name.trim() === b[i].options[j].name && o.price_delta === b[i].options[j].price_delta))

/** Required groups first, then optional ones, each in menu order: the order the export writes them in. */
const fileOrder = (groups: OptionGroup[]) => [...groups.filter((g) => g.min_select >= 1), ...groups.filter((g) => g.min_select < 1)]

export function planImport(menu: Menu, text: string): ImportPlan {
  const { items, errors } = readCsv(text)
  const categories = new Map(menu.categories.map((c) => [key(c.name), c]))
  const plan: ImportPlan = { creates: [], updates: [], unchanged: 0, errors, newCategories: [] }
  for (const item of items) {
    const category = categories.get(key(item.category))
    if (!category && !plan.newCategories.some((n) => key(n) === key(item.category))) plan.newCategories.push(item.category)
    const existing = category && menu.items.find((i) => i.category_id === category.id && key(i.name) === key(item.name))
    if (!existing) {
      plan.creates.push({ line: item.line, item, newCategory: !category, changes: [] })
      continue
    }
    const changes: PlannedChange['changes'] = []
    if (existing.price !== item.price) changes.push('price')
    if (existing.active !== item.active) changes.push('active')
    if (!sameGroups(fileOrder(menu.groups[existing.id] ?? []), item.groups)) changes.push('options')
    if (changes.length) plan.updates.push({ line: item.line, item, existing, newCategory: false, changes })
    else plan.unchanged++
  }
  return plan
}

// ───────────── Import ─────────────

const COLORS = ['#b45309', '#16a34a', '#f59e0b', '#dc2626', '#db2777', '#2563eb', '#7c3aed', '#0891b2']

async function writeGroups(repo: Repo, itemId: string, groups: CsvGroup[]) {
  for (const [gi, g] of groups.entries()) {
    const group = await repo.createOptionGroup({ item_id: itemId, name: g.name, min_select: g.min_select, max_select: g.max_select, sort_order: gi })
    for (const [oi, o] of g.options.entries()) {
      await repo.createOption({ group_id: group.id, name: o.name, price_delta: o.price_delta, sort_order: oi })
    }
  }
}

/**
 * Applies the preview: creates the new categories and items, changes the others (their option groups are replaced
 * when they differ). Each row is applied on its own: a row that fails is reported and the others go on.
 */
export async function applyImport(repo: Repo, plan: ImportPlan, onProgress?: (done: number, total: number) => void): Promise<ImportResult> {
  const menu = await repo.getMenu({ includeHidden: true })
  const categories = new Map<string, Category>(menu.categories.map((c) => [key(c.name), c]))
  const result: ImportResult = { created: 0, updated: 0, errors: [...plan.errors] }
  const all = [...plan.creates, ...plan.updates].sort((a, b) => a.line - b.line)
  let done = 0
  /** Next sort_order in each category, so new items go after the existing ones in file order. */
  const nextSort = new Map<string, number>()
  for (const change of all) {
    const { item } = change
    try {
      let category = categories.get(key(item.category))
      if (!category) {
        category = await repo.createCategory({
          name: item.category, color: item.color ?? COLORS[categories.size % COLORS.length], sort_order: categories.size, active: true,
        })
        categories.set(key(item.category), category)
      }
      const catId = category.id
      const sortOrder = nextSort.get(catId) ?? Math.max(-1, ...menu.items.filter((i) => i.category_id === catId).map((i) => i.sort_order)) + 1
      if (change.existing) {
        await repo.updateItem(change.existing.id, { price: item.price, active: item.active })
        if (change.changes.includes('options')) {
          for (const g of menu.groups[change.existing.id] ?? []) await repo.deleteOptionGroup(g.id)
          await writeGroups(repo, change.existing.id, item.groups)
        }
        result.updated++
      } else {
        const created = await repo.createItem({ category_id: catId, name: item.name, price: item.price, active: item.active, sort_order: sortOrder })
        nextSort.set(catId, sortOrder + 1)
        await writeGroups(repo, created.id, item.groups)
        result.created++
      }
    } catch (e) {
      result.errors.push({ line: change.line, text: `${item.category} ; ${item.name}`, message: e instanceof Error ? e.message : String(e) })
    }
    onProgress?.(++done, all.length)
  }
  result.errors.sort((a, b) => a.line - b.line)
  return result
}

/** Text of the options of a planned item, for the preview. */
export const groupsText = (groups: CsvGroup[]) => groups.map(groupText).join(' ; ')

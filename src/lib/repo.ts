import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { DiningTable, Hall, HallPatch, NewTable, TablePatch } from './types'

/** Data access for halls and tables. Backed by Supabase when configured, localStorage otherwise. */
export interface Repo {
  mode: 'supabase' | 'local'
  listHalls(): Promise<Hall[]>
  createHall(name: string): Promise<Hall>
  updateHall(id: string, patch: HallPatch): Promise<void>
  deleteHall(id: string): Promise<void>
  listTables(hallId: string): Promise<DiningTable[]>
  createTable(t: NewTable): Promise<DiningTable>
  updateTable(id: string, patch: TablePatch): Promise<void>
  deleteTable(id: string): Promise<void>
  /** Calls onChange whenever halls or tables change elsewhere. Returns an unsubscribe function. */
  subscribe(onChange: () => void): () => void
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey) : null

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data
}

function supabaseRepo(sb: SupabaseClient): Repo {
  return {
    mode: 'supabase',
    async listHalls() {
      return check(await sb.from('halls').select('*').order('sort_order').order('created_at')) as Hall[]
    },
    async createHall(name) {
      const halls = await this.listHalls()
      const sort_order = halls.length ? Math.max(...halls.map((h) => h.sort_order)) + 1 : 0
      return check(await sb.from('halls').insert({ name, sort_order }).select().single()) as Hall
    },
    async updateHall(id, patch) {
      check(await sb.from('halls').update(patch).eq('id', id))
    },
    async deleteHall(id) {
      check(await sb.from('halls').delete().eq('id', id))
    },
    async listTables(hallId) {
      return check(await sb.from('tables').select('*').eq('hall_id', hallId).order('created_at')) as DiningTable[]
    },
    async createTable(t) {
      return check(await sb.from('tables').insert(t).select().single()) as DiningTable
    },
    async updateTable(id, patch) {
      check(await sb.from('tables').update(patch).eq('id', id))
    },
    async deleteTable(id) {
      check(await sb.from('tables').delete().eq('id', id))
    },
    subscribe(onChange) {
      const channel = sb
        .channel('floor')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'halls' }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tables' }, onChange)
        .subscribe()
      return () => {
        sb.removeChannel(channel)
      }
    },
  }
}

const KEY = 'smile.floor.v1'

interface LocalDb {
  halls: Hall[]
  tables: DiningTable[]
}

function seed(): LocalDb {
  const h1 = crypto.randomUUID()
  const h2 = crypto.randomUUID()
  const t = (hall_id: string, label: string, seats: number, shape: DiningTable['shape'], x: number, y: number, width: number, height: number): DiningTable => ({
    id: crypto.randomUUID(), hall_id, label, seats, shape, x, y, width, height, status: 'free',
  })
  return {
    halls: [
      { id: h1, name: 'الصالة الرئيسية', width: 1000, height: 640, sort_order: 0 },
      { id: h2, name: 'التراس', width: 1000, height: 640, sort_order: 1 },
    ],
    tables: [
      t(h1, '1', 4, 'square', 60, 60, 90, 90),
      t(h1, '2', 4, 'square', 220, 60, 90, 90),
      t(h1, '3', 2, 'round', 380, 60, 80, 80),
      t(h1, '4', 6, 'rect', 60, 240, 160, 90),
      t(h1, '5', 8, 'rect', 300, 240, 200, 90),
      t(h2, 'T1', 2, 'round', 80, 80, 80, 80),
      t(h2, 'T2', 2, 'round', 240, 80, 80, 80),
    ],
  }
}

function localRepo(): Repo {
  const load = (): LocalDb => {
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) return JSON.parse(raw) as LocalDb
    } catch {
      /* fall through to seed */
    }
    const db = seed()
    save(db)
    return db
  }
  const save = (db: LocalDb) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(db))
    } catch {
      /* storage unavailable: keep working in memory for this session */
    }
  }
  const listeners = new Set<() => void>()
  const commit = (db: LocalDb) => {
    save(db)
    listeners.forEach((l) => l())
  }
  // Other tabs on the same device see changes too.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) listeners.forEach((l) => l())
  })

  return {
    mode: 'local',
    async listHalls() {
      return [...load().halls].sort((a, b) => a.sort_order - b.sort_order)
    },
    async createHall(name) {
      const db = load()
      const sort_order = db.halls.length ? Math.max(...db.halls.map((h) => h.sort_order)) + 1 : 0
      const hall: Hall = { id: crypto.randomUUID(), name, width: 1000, height: 640, sort_order }
      db.halls.push(hall)
      commit(db)
      return hall
    },
    async updateHall(id, patch) {
      const db = load()
      db.halls = db.halls.map((h) => (h.id === id ? { ...h, ...patch } : h))
      commit(db)
    },
    async deleteHall(id) {
      const db = load()
      db.halls = db.halls.filter((h) => h.id !== id)
      db.tables = db.tables.filter((t) => t.hall_id !== id)
      commit(db)
    },
    async listTables(hallId) {
      return load().tables.filter((t) => t.hall_id === hallId)
    },
    async createTable(t) {
      const db = load()
      if (db.tables.some((x) => x.hall_id === t.hall_id && x.label === t.label)) {
        throw new Error(`الطاولة "${t.label}" موجودة من قبل في هذه الصالة`)
      }
      const table: DiningTable = { ...t, id: crypto.randomUUID() }
      db.tables.push(table)
      commit(db)
      return table
    },
    async updateTable(id, patch) {
      const db = load()
      const current = db.tables.find((t) => t.id === id)
      if (current && patch.label !== undefined && db.tables.some((x) => x.id !== id && x.hall_id === current.hall_id && x.label === patch.label)) {
        throw new Error(`الطاولة "${patch.label}" موجودة من قبل في هذه الصالة`)
      }
      db.tables = db.tables.map((t) => (t.id === id ? { ...t, ...patch } : t))
      commit(db)
    },
    async deleteTable(id) {
      const db = load()
      db.tables = db.tables.filter((t) => t.id !== id)
      commit(db)
    },
    subscribe(onChange) {
      listeners.add(onChange)
      return () => {
        listeners.delete(onChange)
      }
    },
  }
}

export const repo: Repo = supabase ? supabaseRepo(supabase) : localRepo()

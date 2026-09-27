import { useCallback, useEffect, useMemo, useState } from 'react'
import { repo } from '../lib/repo'
import type { DiningTable, Hall, TablePatch } from '../lib/types'
import FloorPlan from './FloorPlan'
import TablePanel from './TablePanel'
import HallPanel from './HallPanel'
import OrderScreen from './OrderScreen'
import MenuAdmin from './MenuAdmin'
import { useDialog } from './Dialog'
import LangToggle from './LangToggle'
import { useI18n } from '../lib/i18n'

type Mode = 'service' | 'edit'

export default function FloorScreen({ onSignOut }: { onSignOut?: () => void }) {
  const [halls, setHalls] = useState<Hall[]>([])
  const [hallId, setHallId] = useState<string | null>(null)
  const [tables, setTables] = useState<DiningTable[]>([])
  const [mode, setMode] = useState<Mode>('service')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [orderTableId, setOrderTableId] = useState<string | null>(null)
  const [menuAdmin, setMenuAdmin] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const dialog = useDialog()
  const { t } = useI18n()

  const hall = halls.find((h) => h.id === hallId) ?? null
  const selected = tables.find((t) => t.id === selectedId) ?? null

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      setError(null)
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const reload = useCallback(async () => {
    await run(async () => {
      const hs = await repo.listHalls()
      setHalls(hs)
      const current = hs.find((h) => h.id === hallId) ?? hs[0] ?? null
      if (current?.id !== hallId) setHallId(current?.id ?? null)
      setTables(current ? await repo.listTables(current.id) : [])
    })
    setLoading(false)
  }, [hallId, run])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => repo.subscribe(() => reload()), [reload])

  useEffect(() => {
    if (mode === 'service') setSelectedId(null)
  }, [mode])

  const counts = useMemo(() => {
    const occupied = tables.filter((t) => t.status === 'occupied').length
    return { free: tables.length - occupied, occupied }
  }, [tables])

  function patchLocal(id: string, patch: TablePatch) {
    setTables((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  async function updateTable(id: string, patch: TablePatch) {
    const before = tables
    patchLocal(id, patch)
    try {
      setError(null)
      await repo.updateTable(id, patch)
    } catch (e) {
      setTables(before)
      setError(e instanceof Error ? e.message : String(e))
    }
  }


  async function addHall() {
    const name = await dialog.askText(t.newHallName)
    if (!name) return
    await run(async () => {
      const h = await repo.createHall(name)
      setHallId(h.id)
      setMode('edit')
    })
  }

  async function addTable() {
    if (!hall) return
    const used = new Set(tables.map((t) => t.label))
    let n = tables.length + 1
    while (used.has(String(n))) n++
    // Cascade new tables so they don't land exactly on top of each other.
    const offset = (tables.length % 8) * 20
    await run(async () => {
      const created = await repo.createTable({
        hall_id: hall.id, label: String(n), seats: 4, shape: 'square',
        x: 20 + offset, y: 20 + offset, width: 90, height: 90, status: 'free',
      })
      setTables((ts) => (ts.some((x) => x.id === created.id) ? ts : [...ts, created]))
      setSelectedId(created.id)
    })
  }

  async function deleteTable(table: DiningTable) {
    if (!(await dialog.confirm(t.confirmDeleteTable(table.label)))) return
    await run(async () => {
      await repo.deleteTable(table.id)
      setSelectedId(null)
      setTables((ts) => ts.filter((x) => x.id !== table.id))
    })
  }

  async function deleteHall(h: Hall) {
    if (!(await dialog.confirm(t.confirmDeleteHall(h.name)))) return
    await run(async () => {
      await repo.deleteHall(h.id)
      setHallId(null)
    })
  }

  if (menuAdmin) return <MenuAdmin onBack={() => setMenuAdmin(false)} />

  const orderTable = tables.find((t) => t.id === orderTableId)
  if (orderTable && hall) {
    return <OrderScreen key={orderTable.id} table={orderTable} hall={hall} onBack={() => { setOrderTableId(null); reload() }} />
  }

  return (
    <div className={`app mode-${mode}`}>
      <header className="topbar">
        <div className="brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span>Smile Signature</span>
        </div>
        <nav className="tabs" aria-label={t.halls}>
          {halls.map((h) => (
            <button key={h.id} className={h.id === hallId ? 'tab active' : 'tab'} onClick={() => { setHallId(h.id); setSelectedId(null) }}>
              {h.name}
            </button>
          ))}
          <button className="tab add" onClick={addHall} title={t.addHall}>{t.addHallTab}</button>
        </nav>
        <div className="spacer" />
        <div className="segmented" role="group" aria-label={t.mode}>
          <button className={mode === 'service' ? 'on' : ''} onClick={() => setMode('service')}>{t.service}</button>
          <button className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')}>{t.editPlan}</button>
        </div>
        <button className="ghost" onClick={() => setMenuAdmin(true)} title={t.menuTitle}>{t.menu}</button>
        {onSignOut && <button className="ghost" onClick={onSignOut}>{t.signOut}</button>}
        <LangToggle />
      </header>

      {repo.mode === 'local' && (
        <div className="banner">{t.demoBanner}</div>
      )}
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}

      <main className="content">
        {loading ? (
          <div className="center muted">{t.loading}</div>
        ) : !hall ? (
          <div className="center">
            <div className="card empty">
              <p>{t.noHalls}</p>
              <button className="primary" onClick={addHall}>{t.addFirstHall}</button>
            </div>
          </div>
        ) : (
          <>
            <section className="floor-area">
              <div className="floor-toolbar">
                <span className="pill free">{t.freeCount(counts.free)}</span>
                <span className="pill occupied">{t.occupiedCount(counts.occupied)}</span>
                <span className="hint">
                  {mode === 'service' ? t.hintService : t.hintEdit}
                </span>
                {mode === 'edit' && <button className="primary" onClick={addTable}>{t.addTable}</button>}
              </div>
              <FloorPlan
                hall={hall}
                tables={tables}
                editable={mode === 'edit'}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onTap={(x) => setOrderTableId(x.id)}
                onMove={(id, x, y) => updateTable(id, { x, y })}
              />
            </section>
            {mode === 'edit' && (
              <aside className="side">
                {selected ? (
                  <TablePanel
                    key={selected.id}
                    table={selected}
                    hall={hall}
                    onChange={(patch) => updateTable(selected.id, patch)}
                    onDelete={() => deleteTable(selected)}
                    onClose={() => setSelectedId(null)}
                  />
                ) : (
                  <HallPanel
                    key={hall.id}
                    hall={hall}
                    onChange={(patch) => run(() => repo.updateHall(hall.id, patch).then(reload))}
                    onDelete={() => deleteHall(hall)}
                  />
                )}
              </aside>
            )}
          </>
        )}
      </main>
      {dialog.element}
    </div>
  )
}

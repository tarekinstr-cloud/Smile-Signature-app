import { useCallback, useEffect, useState } from 'react'
import { repo } from '../../lib/repo'
import { useI18n } from '../../lib/i18n'
import type { Hall } from '../../lib/types'
import { useDialog } from '../Dialog'
import { errorText, useLoad } from './useLoad'

/**
 * Paramètres > Gestion des salles: add, rename, reorder, activate / deactivate and delete the halls, with their number
 * of tables. The tables themselves are placed in Modifier le plan de salle (button on each hall). A hall whose table has
 * an open order can be neither deleted nor deactivated.
 */
export default function HallsPage({ onOpenPlan }: { onOpenPlan?(hallId: string): void }) {
  const { t } = useI18n()
  const dialog = useDialog()
  const load = useCallback(async () => {
    const halls = await repo.listHalls()
    const counts = await Promise.all(halls.map(async (h) => {
      const [tables, open] = await Promise.all([repo.listTables(h.id), repo.listTableOrders(h.id)])
      return [h.id, { tables: tables.length, open: open.length }] as const
    }))
    return { halls, counts: Object.fromEntries(counts) }
  }, [])
  const { data, error, setError, reload } = useLoad(load)
  useEffect(() => repo.subscribe(reload), [reload])
  const [names, setNames] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      setError(null)
      await fn()
      await reload()
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  async function add() {
    const name = (await dialog.askText(t.newHallName))?.trim()
    if (name) await run(() => repo.createHall(name))
  }

  async function rename(h: Hall) {
    const name = (names[h.id] ?? h.name).trim()
    if (!name || name === h.name) return setNames(({ [h.id]: _, ...rest }) => rest)
    await run(() => repo.updateHall(h.id, { name }))
    setNames(({ [h.id]: _, ...rest }) => rest)
  }

  /** Swaps the hall with its neighbour; the order of the hall buttons in the service bar follows. */
  async function move(halls: Hall[], index: number, by: -1 | 1) {
    const other = halls[index + by]
    if (!other) return
    const list = halls.map((h, i) => ({ id: h.id, sort_order: i }))
    list[index].sort_order = index + by
    list[index + by].sort_order = index
    await run(() => Promise.all(list.filter((x, i) => halls[i].sort_order !== x.sort_order).map((x) => repo.updateHall(x.id, { sort_order: x.sort_order }))))
  }

  async function toggle(h: Hall, open: number) {
    const active = h.active === false
    if (!active && open) return setError(t.errHallHasOrders)
    await run(() => repo.updateHall(h.id, { active }))
  }

  async function remove(h: Hall, open: number) {
    if (open) return setError(t.errHallHasOrders)
    if (!(await dialog.confirm(t.confirmDeleteHall(h.name)))) return
    await run(() => repo.deleteHall(h.id))
  }

  const halls = data?.halls ?? []
  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <p className="muted small">{t.hallsHint}</p>
      {!data ? (
        !error && <div className="center muted">{t.loading}</div>
      ) : (
        <section className="panel">
          <div className="panel-head">
            <h2>{t.hallsManage}</h2>
            <button className="primary" onClick={add} disabled={busy}>{t.addHall}</button>
          </div>
          {!halls.length && <p className="muted">{t.noHalls}</p>}
          <ul className="halls-list">
            {halls.map((h, i) => {
              const c = data.counts[h.id] ?? { tables: 0, open: 0 }
              const off = h.active === false
              return (
                <li key={h.id} className={off ? 'hall-row off' : 'hall-row'}>
                  <div className="hall-order">
                    <button className="ghost" onClick={() => move(halls, i, -1)} disabled={busy || i === 0} aria-label={t.moveUpFor(h.name)}>▲</button>
                    <button className="ghost" onClick={() => move(halls, i, 1)} disabled={busy || i === halls.length - 1} aria-label={t.moveDownFor(h.name)}>▼</button>
                  </div>
                  <input className="hall-name" aria-label={t.hallNameFor(h.name)} value={names[h.id] ?? h.name} maxLength={40}
                    onChange={(e) => setNames({ ...names, [h.id]: e.target.value })} onBlur={() => rename(h)}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
                  <span className="muted small hall-count">
                    {t.tableCount(c.tables)}{c.open > 0 && <> · <span className="tag warn">{t.openOrdersCount(c.open)}</span></>}
                  </span>
                  <label className="check">
                    <input type="checkbox" checked={!off} disabled={busy} onChange={() => toggle(h, c.open)} />
                    {t.hallActive}
                  </label>
                  {onOpenPlan && <button onClick={() => onOpenPlan(h.id)} disabled={off} title={off ? t.hallInactiveHint : undefined}>{t.editPlanItem}</button>}
                  <button className="danger" onClick={() => remove(h, c.open)} disabled={busy}>{t.delete}</button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {dialog.element}
    </main>
  )
}

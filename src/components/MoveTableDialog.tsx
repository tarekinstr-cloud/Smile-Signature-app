import { useEffect, useState } from 'react'
import { repo } from '../lib/repo'
import type { DiningTable, Hall } from '../lib/types'
import { useI18n } from '../lib/i18n'

interface Props {
  /** Table the order is on now; null for a takeaway order. */
  currentTableId: string | null
  busy: boolean
  onCancel(): void
  onPick(table: DiningTable, hall: Hall): void
}

/**
 * Changement de Table: every table of every hall with its state. Occupied tables are shown in red and
 * cannot be picked (a clear "Table X déjà occupée" message instead), which keeps two orders off one table.
 */
export default function MoveTableDialog({ currentTableId, busy, onCancel, onPick }: Props) {
  const { t } = useI18n()
  const [halls, setHalls] = useState<Hall[] | null>(null)
  const [tables, setTables] = useState<DiningTable[]>([])
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    const load = () =>
      Promise.all([repo.listHalls(), repo.listAllTables()]).then(
        ([hs, ts]) => {
          setHalls(hs)
          setTables(ts)
        },
        (e) => setMessage(e instanceof Error ? e.message : String(e)),
      )
    load()
    // Another device may take a table while the list is open.
    return repo.subscribe(load)
  }, [])

  function tap(table: DiningTable, hall: Hall) {
    if (table.id === currentTableId || busy) return
    if (table.status === 'occupied') {
      setMessage(t.tableOccupied(table.label))
      return
    }
    setMessage(null)
    onPick(table, hall)
  }

  const byLabel = (a: DiningTable, b: DiningTable) => a.label.localeCompare(b.label, undefined, { numeric: true })

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="dialog move-dialog" role="dialog" aria-modal="true" aria-labelledby="move-title"
        onKeyDown={(e) => e.key === 'Escape' && !busy && onCancel()}>
        <h2 id="move-title">{t.moveTitle}</h2>
        <p className="muted small">{t.moveHint}</p>
        {message && <div className="banner error move-msg" role="alert" onClick={() => setMessage(null)}>{message}</div>}
        {!halls ? (
          <p className="muted">{t.loading}</p>
        ) : tables.length === 0 ? (
          <p className="muted">{t.noTables}</p>
        ) : (
          <div className="move-halls">
            {halls.map((h) => {
              const list = tables.filter((x) => x.hall_id === h.id).sort(byLabel)
              if (!list.length) return null
              return (
                <section key={h.id}>
                  <h3><bdi>{h.name}</bdi></h3>
                  <div className="move-grid">
                    {list.map((x) => {
                      const current = x.id === currentTableId
                      const state = current ? t.currentTable : x.status === 'occupied' ? t.occupied : t.free
                      return (
                        <button key={x.id} type="button" disabled={busy || current}
                          className={`move-table ${current ? 'current' : x.status}`}
                          aria-label={`${t.table(x.label)}, ${state}`}
                          onClick={() => tap(x, h)}>
                          <strong><bdi>{x.label}</bdi></strong>
                          <span>{state}</span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>{t.cancel}</button>
        </div>
      </div>
    </div>
  )
}

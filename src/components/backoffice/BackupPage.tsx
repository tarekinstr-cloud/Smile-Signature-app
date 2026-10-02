import { useCallback, useEffect, useState } from 'react'
import { admin, download, stamp, toCsv } from '../../lib/admin'
import { repo } from '../../lib/repo'
import { auth } from '../../lib/auth'
import { useI18n } from '../../lib/i18n'
import { errorText, locale, useLoad } from './useLoad'
import { nowIso } from '../../lib/tz'

/** "12,4 Ko" / "1,2 Mo". */
function size(bytes: number, lang: 'fr' | 'ar'): string {
  const unit = lang === 'ar' ? ['بايت', 'ك.ب', 'م.ب'] : ['o', 'Ko', 'Mo']
  const i = bytes < 1024 ? 0 : bytes < 1024 * 1024 ? 1 : 2
  const n = bytes / 1024 ** i
  return `${n.toLocaleString(locale(lang), { maximumFractionDigits: i ? 1 : 0 })} ${unit[i]}`
}

/**
 * Fichier → Sauvegarder la base de données: downloads the data on this device, all tables in one JSON file or one
 * table as CSV, and keeps a history of the exports (backups_log). Restoring is not done from the app.
 */
export default function BackupPage() {
  const { t, lang } = useI18n()
  const loadLog = useCallback(() => admin.listBackups(), [])
  const { data: log, error, setError, reload } = useLoad(loadLog)
  const [tables, setTables] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [who, setWho] = useState('')

  useEffect(() => {
    admin.backupTables().then(setTables, () => setTables([]))
    auth.current().then((u) => setWho(u?.username ?? ''), () => setWho(''))
  }, [])

  async function run(key: string, fn: () => Promise<{ rows: number; bytes: number; tables: string[]; format: 'json' | 'csv' }>) {
    setBusy(key)
    setDone(null)
    try {
      setError(null)
      const r = await fn()
      setDone(t.backupDone(r.rows, size(r.bytes, lang)))
      await admin.logBackup({ user_label: who, format: r.format, tables: r.tables, row_count: r.rows, size_bytes: r.bytes })
      await reload()
    } catch (err) {
      setError(errorText(err))
    }
    setBusy(null)
  }

  const exportJson = () => run('json', async () => {
    const data: Record<string, Record<string, unknown>[]> = {}
    let rows = 0
    for (const name of tables) {
      data[name] = await admin.readTable(name)
      rows += data[name].length
    }
    const file = { app: 'smile-signature', mode: repo.mode, exported_at: nowIso(), tables: data }
    const bytes = download(`smile-signature_${stamp()}.json`, JSON.stringify(file, null, 1), 'application/json')
    return { rows, bytes, tables, format: 'json' }
  })

  const exportCsv = (name: string) => run(`csv:${name}`, async () => {
    const rows = await admin.readTable(name)
    const bytes = download(`smile-signature_${name}_${stamp()}.csv`, toCsv(rows), 'text/csv;charset=utf-8')
    return { rows: rows.length, bytes, tables: [name], format: 'csv' }
  })

  const when = (iso: string) =>
    new Date(iso).toLocaleString(locale(lang), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <main className="content bo-content backup-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {done && <div className="banner ok" onClick={() => setDone(null)}>{done}</div>}
      <section className="panel">
        <p className="small">{t.backupIntro}</p>
        <button className="primary big backup-main" disabled={!!busy || !tables.length} onClick={exportJson}>
          💾 {busy === 'json' ? t.backupRunning : t.backupJson}
          <span className="small">{t.backupJsonHint} ({tables.length})</span>
        </button>
        <p className="muted small">{repo.mode === 'local' ? t.backupDemoNote : t.backupSupabaseNote}</p>
      </section>

      <section className="panel">
        <h2>{t.backupCsvTitle}</h2>
        <div className="backup-tables">
          {tables.map((name) => (
            <button key={name} disabled={!!busy} onClick={() => exportCsv(name)} dir="ltr">
              {busy === `csv:${name}` ? t.backupRunning : name}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>{t.backupHistory}</h2>
        {!log ? (
          !error && <p className="muted">{t.loading}</p>
        ) : log.length === 0 ? (
          <p className="muted small">{t.noBackups}</p>
        ) : (
          <table className="bo-table">
            <thead>
              <tr>
                <th>{t.colDate}</th>
                <th>{t.colFormat}</th>
                <th className="num">{t.colRows}</th>
                <th className="num hide-phone">{t.colSize}</th>
                <th className="hide-phone">{t.colBy}</th>
              </tr>
            </thead>
            <tbody>
              {log.map((b) => (
                <tr key={b.id}>
                  <td className="small">{when(b.created_at)}</td>
                  <td className="small">
                    {b.format.toUpperCase()} · <bdi>{b.format === 'json' ? t.allTables : b.tables.join(', ')}</bdi>
                  </td>
                  <td className="num">{b.row_count}</td>
                  <td className="num hide-phone">{size(b.size_bytes, lang)}</td>
                  <td className="hide-phone small"><bdi>{b.user_label || '—'}</bdi></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  )
}

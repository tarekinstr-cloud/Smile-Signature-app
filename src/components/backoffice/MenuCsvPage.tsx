import { useState, type ChangeEvent } from 'react'
import { repo } from '../../lib/repo'
import { download, stamp } from '../../lib/admin'
import { applyImport, groupsText, menuToCsv, planImport, type CsvError, type ImportPlan, type ImportResult, type PlannedChange } from '../../lib/menuCsv'
import { useI18n } from '../../lib/i18n'
import { money } from '../../lib/format'
import { errorText } from './useLoad'

/** Lines of the file that could not be imported: line number, reason, and the line's content. */
function ErrorTable({ errors }: { errors: CsvError[] }) {
  const { t } = useI18n()
  return (
    <table className="bo-table csv-errors">
      <thead>
        <tr><th className="num">{t.csvColLine}</th><th>{t.csvColError}</th><th className="hide-phone">{t.csvColContent}</th></tr>
      </thead>
      <tbody>
        {errors.map((e, i) => (
          <tr key={i}>
            <td className="num">{e.line}</td>
            <td>{e.message}</td>
            <td className="hide-phone muted small"><bdi>{e.text}</bdi></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * Édition > Importer / Exporter les articles: downloads every item as CSV, or reads a CSV in the same format and, after
 * a preview of what will be created or changed, applies it. See src/lib/menuCsv.ts for the format.
 */
export default function MenuCsvPage() {
  const { t } = useI18n()
  const [error, setError] = useState<string | null>(null)
  const [exported, setExported] = useState<number | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [progress, setProgress] = useState<[number, number] | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [inputKey, setInputKey] = useState(0)

  async function exportCsv() {
    try {
      setError(null)
      const menu = await repo.getMenu({ includeHidden: true })
      download(`smile-signature_articles_${stamp()}.csv`, menuToCsv(menu), 'text/csv;charset=utf-8')
      setExported(menu.items.length)
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    setPlan(null)
    setResult(null)
    setError(null)
    if (!f) return
    try {
      const text = await f.text()
      setFile(f.name)
      setPlan(planImport(await repo.getMenu({ includeHidden: true }), text))
    } catch (err) {
      setFile(null)
      setError(errorText(err))
    }
  }

  function reset() {
    setPlan(null)
    setFile(null)
    setInputKey((k) => k + 1)
  }

  async function apply() {
    if (!plan) return
    try {
      setError(null)
      setProgress([0, plan.creates.length + plan.updates.length])
      const r = await applyImport(repo, plan, (done, total) => setProgress([done, total]))
      setResult(r)
      reset()
    } catch (e) {
      setError(errorText(e))
    }
    setProgress(null)
  }

  const changeText = (c: PlannedChange) =>
    c.changes.map((k) =>
      k === 'price' ? t.csvChangePrice(money(c.existing!.price), money(c.item.price))
        : k === 'active' ? (c.item.active ? t.csvChangeShown : t.csvChangeHidden)
        : t.csvChangeOptions,
    ).join(' · ')

  const rows = plan ? [...plan.creates, ...plan.updates].sort((a, b) => a.line - b.line) : []
  const busy = progress !== null

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}

      <section className="panel">
        <h2>{t.csvExportTitle}</h2>
        <p className="muted small">{t.csvExportHint}</p>
        <div className="dialog-actions start">
          <button className="primary" onClick={exportCsv}>⬇ {t.csvExportBtn}</button>
        </div>
        {exported !== null && <p className="small">{t.csvExported(exported)}</p>}
      </section>

      <section className="panel">
        <h2>{t.csvImportTitle}</h2>
        <p className="muted small">{t.csvImportHint}</p>
        <details className="csv-format small">
          <summary>{t.csvFormatTitle}</summary>
          <p>{t.csvFormatColumns}</p>
          <pre dir="ltr">{'categorie;couleur;article;prix;actif;tailles;supplements\n'
            + 'Pizzas;#dc2626;Margherita;600;oui;Taille (1-1): Petite=0 | Grande=+300;Suppléments (0-3): Fromage=+100 | Olives=+50\n'
            + 'Boissons;;Coca;150;oui;;'}</pre>
          <p>{t.csvFormatOptions}</p>
        </details>
        <label className="csv-file">
          {t.csvChooseFile}
          <input key={inputKey} type="file" accept=".csv,text/csv,text/plain" onChange={pick} disabled={busy} />
        </label>

        {plan && (
          <div className="csv-preview">
            <h3>{t.csvPreviewTitle(file ?? '')}</h3>
            <div className="csv-counts">
              <span className="pill free">{t.csvCountCreate(plan.creates.length)}</span>
              <span className="pill csv-upd">{t.csvCountUpdate(plan.updates.length)}</span>
              <span className="pill">{t.csvCountSame(plan.unchanged)}</span>
              {plan.errors.length > 0 && <span className="pill error">{t.csvCountErrors(plan.errors.length)}</span>}
            </div>
            {plan.newCategories.length > 0 && (
              <p className="small">{t.csvNewCategories}: <bdi>{plan.newCategories.join(t.listSep)}</bdi></p>
            )}
            {rows.length > 0 ? (
              <table className="bo-table csv-table">
                <thead>
                  <tr>
                    <th className="num">{t.csvColLine}</th>
                    <th>{t.csvColAction}</th>
                    <th>{t.csvColItem}</th>
                    <th className="num">{t.csvColPrice}</th>
                    <th className="hide-phone">{t.csvColDetails}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.line}>
                      <td className="num">{c.line}</td>
                      <td><span className={`tag ${c.existing ? 'csv-update' : 'csv-create'}`}>{c.existing ? t.csvActionUpdate : t.csvActionCreate}</span></td>
                      <td><bdi>{c.item.name}</bdi><div className="muted small"><bdi>{c.item.category}</bdi>{!c.item.active && <> · {t.csvHidden}</>}</div></td>
                      <td className="num">{money(c.item.price)}</td>
                      <td className="hide-phone small">
                        {c.existing ? changeText(c) : <bdi className="muted">{groupsText(c.item.groups) || '—'}</bdi>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted small">{t.csvNothingToDo}</p>
            )}
            {plan.errors.length > 0 && (
              <>
                <h3>{t.csvErrorsTitle}</h3>
                <p className="muted small">{t.csvErrorsSkipped}</p>
                <ErrorTable errors={plan.errors} />
              </>
            )}
            <div className="dialog-actions">
              <button onClick={reset} disabled={busy}>{t.cancel}</button>
              <button className="primary" onClick={apply} disabled={busy || rows.length === 0}>
                {progress ? t.csvApplying(progress[0], progress[1]) : t.csvApply(rows.length)}
              </button>
            </div>
          </div>
        )}

        {result && (
          <div className="csv-result" role="status">
            <h3>{t.csvResultTitle}</h3>
            <p><strong>{t.csvResult(result.created, result.updated, result.errors.length)}</strong></p>
            {result.errors.length > 0 && <ErrorTable errors={result.errors} />}
          </div>
        )}
      </section>
    </main>
  )
}

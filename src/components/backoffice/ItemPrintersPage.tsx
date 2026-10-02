import { useCallback, useEffect, useMemo, useState } from 'react'
import { repo } from '../../lib/repo'
import { useI18n } from '../../lib/i18n'
import { itemTargets } from '../../lib/kitchen'
import { errorText, useLoad } from './useLoad'

/**
 * Paramètres > Gestion des imprimantes (par plats): each item with the printer(s) it is really sent to. Choosing a
 * printer for an item replaces those of its category; « Comme la catégorie » goes back to them.
 */
export default function ItemPrintersPage() {
  const { t } = useI18n()
  const load = useCallback(async () => {
    const [menu, printers, links] = await Promise.all([repo.getMenu({ includeHidden: true }), repo.listPrinters(), repo.getCategoryPrinters()])
    return { menu, printers, links }
  }, [])
  const { data, error, setError, reload } = useLoad(load)
  useEffect(() => repo.subscribeOrders(reload), [reload])
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const rows = useMemo(() => {
    if (!data) return []
    const known = new Set(data.printers.map((p) => p.id))
    const itemCategory = Object.fromEntries(data.menu.items.map((i) => [i.id, i.category_id]))
    const itemPrinter = Object.fromEntries(data.menu.items.map((i) => [i.id, i.printer_id ?? null]))
    const name = (id: string) => data.printers.find((p) => p.id === id)?.name ?? '?'
    return data.menu.categories
      .filter((c) => !category || c.id === category)
      .flatMap((c) => data.menu.items.filter((i) => i.category_id === c.id).sort((a, b) => a.sort_order - b.sort_order).map((item) => {
        const targets = itemTargets(item.id, itemCategory, data.links, known, itemPrinter)
        const own = !!item.printer_id && known.has(item.printer_id)
        return { item, category: c, own, effective: targets.map(name) }
      }))
  }, [data, category])

  async function choose(itemId: string, printerId: string) {
    setBusy(itemId)
    try {
      setError(null)
      await repo.setItemPrinter(itemId, printerId || null)
      await reload()
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(null)
  }

  const none = rows.filter((r) => !r.effective.length).length
  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <p className="muted small">{t.itemPrintersHint}</p>
      {!data ? (
        !error && <div className="center muted">{t.loading}</div>
      ) : (
        <section className="panel">
          <div className="bo-toolbar">
            <label>
              {t.categoryFilter}{' '}
              <select className="auto-width" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">{t.allCategories}</option>
                {data.menu.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <span className="muted small">{t.itemCount(rows.length)}</span>
          </div>
          {none > 0 && <p className="banner printer-warning" role="alert">⚠ {t.itemsNoPrinter(none)}</p>}
          {!data.printers.length && <p className="muted">{t.noPrinters}</p>}
          <div className="table-scroll">
            <table className="bo-table control-table item-printers">
              <thead>
                <tr>
                  <th>{t.itemCol}</th>
                  <th>{t.categoryCol}</th>
                  <th>{t.effectivePrinter}</th>
                  <th>{t.itemPrinterCol}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ item, category: c, own, effective }) => (
                  <tr key={item.id} className={item.active ? '' : 'muted'}>
                    <td><bdi>{item.name}</bdi></td>
                    <td><bdi>{c.name}</bdi></td>
                    <td>
                      {effective.length
                        ? <><bdi>{effective.join(t.listSep)}</bdi> {own ? <span className="tag">{t.ownPrinterTag}</span> : <span className="tag muted">{t.fromCategoryTag}</span>}</>
                        : <span className="tag warn">{t.noPrinterTag}</span>}
                    </td>
                    <td>
                      <select aria-label={t.itemPrinterFor(item.name)} value={own ? item.printer_id ?? '' : ''} disabled={busy === item.id}
                        onChange={(e) => choose(item.id, e.target.value)}>
                        <option value="">{t.sameAsCategory}</option>
                        {data.printers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && <p className="muted">{t.noItemsYet}</p>}
        </section>
      )}
    </main>
  )
}

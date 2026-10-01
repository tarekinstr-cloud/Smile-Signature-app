import { useCallback, useEffect, useMemo, useState } from 'react'
import { repo } from '../../lib/repo'
import { itemVariants, margin, missingRecipe, recipes, variantCost } from '../../lib/recipes'
import type { Menu, MenuItem, RecipeLine, RecipeStockItem } from '../../lib/types'
import { download, stamp, toCsv } from '../../lib/admin'
import { useI18n } from '../../lib/i18n'
import { csvDa, money } from '../../lib/format'
import RecipeEditor from '../RecipeEditor'
import { errorText, locale, useLoad } from './useLoad'

type Filter = 'all' | 'missing'

interface Data {
  menu: Menu
  lines: RecipeLine[]
  stock: RecipeStockItem[]
  startedAt: string | null
}

/** "12,5 %" */
const percent = (n: number | null) => (n == null ? '—' : `${n.toLocaleString('fr-FR')} %`)
const csvNum = (n: number | null) => (n == null ? '' : String(n).replace('.', ','))

/**
 * Édition > Fiches techniques: every menu item with the cost and margin of each size, and the list of the articles sans
 * fiche technique (what is left to configure). The fiche itself opens in the same editor as Gérer les articles.
 */
export default function RecipesPage() {
  const { t, lang } = useI18n()
  const load = useCallback(async (): Promise<Data> => {
    const [menu, lines, stock, startedAt] = await Promise.all([
      repo.getMenu({ includeHidden: true }), recipes.list(), recipes.stockItems(), recipes.startedAt(),
    ])
    return { menu, lines, stock, startedAt }
  }, [])
  const { data, error, setError, reload } = useLoad(load)
  // A fiche changed on another tablet, or a purchase changed a price (shared « stock » channel).
  useEffect(() => recipes.subscribe(() => { reload() }), [reload])
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<MenuItem | null>(null)

  const prices = useMemo(() => new Map((data?.stock ?? []).map((s) => [s.id, s.last_price])), [data])
  const rows = useMemo(() => {
    if (!data) return []
    const { menu, lines } = data
    const catOrder = new Map(menu.categories.map((c, i) => [c.id, i]))
    return [...menu.items]
      .sort((a, b) => (catOrder.get(a.category_id) ?? 0) - (catOrder.get(b.category_id) ?? 0) || a.sort_order - b.sort_order)
      .map((item) => {
        const groups = menu.groups[item.id] ?? []
        const mine = lines.filter((l) => l.item_id === item.id)
        const variants = itemVariants(item, groups)
        const sized = variants.some((v) => v.kind === 'size')
        const portions = variants.filter((v) => (sized ? v.kind === 'size' : v.kind === 'base')).map((v) => {
          const c = variantCost(v, mine, prices)
          return { v, ...c, ...margin(v.price, c.cost) }
        })
        return {
          item, category: menu.categories.find((c) => c.id === item.category_id), portions, missing: missingRecipe(item, groups, lines),
          supplements: variants.filter((v) => v.kind === 'option' && mine.some((l) => l.option_id === v.option_id)).length,
        }
      })
  }, [data, prices])

  const q = query.trim().toLowerCase()
  const bySearch = rows.filter((r) => !q || r.item.name.toLowerCase().includes(q) || (r.category?.name.toLowerCase().includes(q) ?? false))
  const missingCount = bySearch.filter((r) => r.missing).length
  const shown = bySearch.filter((r) => filter === 'all' || r.missing)

  function exportCsv() {
    download(`smile-signature_fiches-techniques_${stamp()}.csv`, toCsv(shown.flatMap((r) => r.portions.map((p) => ({
      [t.category]: r.category?.name ?? '',
      [t.recipeArticle]: r.item.name,
      [t.recipeVariant]: p.v.kind === 'size' ? p.v.label : '',
      [t.recipeSalePrice]: csvDa(p.v.price),
      [t.recipeCost]: p.lines ? csvDa(p.cost) : '',
      [t.recipeMargin]: p.lines ? csvDa(p.amount) : '',
      [t.recipeMarginPct]: p.lines ? csvNum(p.percent) : '',
      [t.recipeStatus]: p.lines ? '' : t.recipeNone,
    })))), 'text/csv;charset=utf-8')
  }

  const since = data?.startedAt
    ? new Date(data.startedAt).toLocaleString(locale(lang), { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <section className="panel">
        <div className="bo-toolbar pur-filters state-filters">
          <label>
            {t.search.replace('…', '')}
            <input type="search" className="bo-search" placeholder={t.search} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="segmented state-levels" role="radiogroup" aria-label={t.recipesTitle}>
            {(['all', 'missing'] as const).map((f) => (
              <button key={f} type="button" role="radio" aria-checked={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {t.recipesFilter[f]} <span className={`state-count ${f === 'missing' ? 'low' : ''}`}>{f === 'all' ? bySearch.length : missingCount}</span>
              </button>
            ))}
          </div>
          <div className="spacer" />
          <button onClick={exportCsv} disabled={!shown.length}>{t.stateExport}</button>
        </div>

        {!data ? (
          !error && <p className="muted">{t.loading}</p>
        ) : !shown.length ? (
          <p className="muted small">{filter === 'missing' && !q ? t.recipesAllDone : t.noMatch}</p>
        ) : (
          <table className="bo-table payroll-table state-table recipes-table">
            <thead>
              <tr>
                <th>{t.recipeArticle}</th>
                <th className="num">{t.recipeSalePrice}</th>
                <th className="num">{t.recipeCost}</th>
                <th className="num">{t.recipeMargin}</th>
                <th className="num">{t.recipeMarginPct}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => r.portions.map((p, i) => (
                <tr key={`${r.item.id}:${p.v.option_id ?? 'base'}`} className={i > 0 ? 'recipe-size-row' : undefined}>
                  <td className="payroll-name">
                    {i === 0 && (
                      <>
                        <bdi className="strong">{r.item.name}</bdi>
                        {!r.item.active && <span className="tag">{t.hiddenM}</span>}
                        {r.missing === 'none' && <span className="tag state-level low">{t.recipeNone}</span>}
                        {Array.isArray(r.missing) && <span className="tag warn">{t.recipeSizesMissing(r.missing.join(t.listSep))}</span>}
                        <div className="muted small">
                          <bdi>{r.category?.name}</bdi>
                          {r.supplements > 0 && ` · ${t.recipeSupplementsCount(r.supplements)}`}
                        </div>
                      </>
                    )}
                    {p.v.kind === 'size' && <div className="recipe-size"><bdi>{p.v.group} {p.v.label}</bdi></div>}
                  </td>
                  <td className="num" data-label={t.recipeSalePrice}>{money(p.v.price)}</td>
                  <td className="num" data-label={t.recipeCost}>
                    {p.lines ? money(p.cost) : '—'}
                    {p.lines > 0 && p.missing > 0 && <div className="muted small">{t.recipeMissingPrices(p.missing)}</div>}
                  </td>
                  <td className={`num strong${p.amount < 0 ? ' neg' : ''}`} data-label={t.recipeMargin}>{p.lines ? money(p.amount) : '—'}</td>
                  <td className={`num${p.amount < 0 ? ' neg' : ''}`} data-label={t.recipeMarginPct}>{p.lines ? percent(p.percent) : '—'}</td>
                  <td className="row-actions">
                    {i === 0 && <button onClick={() => setEditing(r.item)}>{t.recipeOpen}</button>}
                  </td>
                </tr>
              )))}
            </tbody>
          </table>
        )}
        <p className="muted small">{t.recipesNote}</p>
        {since && <p className="muted small">{t.recipesSince(since)}</p>}
      </section>

      {editing && data && (
        <RecipeEditor item={editing} menu={data.menu} onClose={() => setEditing(null)}
          onSaved={() => { reload().catch((e) => setError(errorText(e))) }} />
      )}
    </main>
  )
}

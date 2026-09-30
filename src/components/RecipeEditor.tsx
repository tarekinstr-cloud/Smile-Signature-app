import { useEffect, useMemo, useState } from 'react'
import type { Menu, MenuItem, RecipeLine, RecipeLineInput, RecipeStockItem } from '../lib/types'
import { copyRecipe, itemVariants, linesCost, margin, recipes, type RecipeVariant } from '../lib/recipes'
import { inputUnits, toStockUnit, unitFactor } from '../lib/units'
import { money } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { newId } from '../lib/id'
import { useDialog } from './Dialog'

interface Props {
  item: MenuItem
  menu: Menu
  onClose(): void
  /** After a save (this item, or another one by Dupliquer). */
  onSaved?(): void
}

interface DraftLine {
  key: string
  option_id: string | null
  stockId: string
  qty: string
  unit: string
}

const qtyFormat = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 6 })
/** Parses "2,5" or "2.5"; null when it is not a number. */
const parseQty = (v: string) => {
  const n = Number(v.replace(/\s/g, '').replace(',', '.'))
  return v.trim() && Number.isFinite(n) ? n : null
}
const variantKey = (optionId: string | null) => optionId ?? 'base'

/**
 * Fiche technique of a menu item: ingredients of the stock and the quantity one portion consumes, for the item itself
 * and for each size and supplement. Quantities may be typed in a sub-unit (g for a stock in kg) and are converted.
 * Shows the cost (quantities × last purchase price) and the margin on the sale price.
 */
export default function RecipeEditor({ item, menu, onClose, onSaved }: Props) {
  const { t } = useI18n()
  const groups = useMemo(() => menu.groups[item.id] ?? [], [menu, item.id])
  const variants = useMemo(() => itemVariants(item, groups), [item, groups])
  const hasSizes = variants.some((v) => v.kind === 'size')
  const [stock, setStock] = useState<RecipeStockItem[] | null>(null)
  const [allLines, setAllLines] = useState<RecipeLine[]>([])
  const [draft, setDraft] = useState<DraftLine[]>([])
  const [active, setActive] = useState<string>(hasSizes ? variantKey(variants.find((v) => v.kind === 'size')!.option_id) : 'base')
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copyTo, setCopyTo] = useState('')
  const dialog = useDialog()

  useEffect(() => {
    let live = true
    Promise.all([recipes.stockItems(), recipes.list()]).then(([s, l]) => {
      if (!live) return
      setStock(s)
      setAllLines(l)
      const byId = new Map(s.map((x) => [x.id, x]))
      setDraft(l.filter((x) => x.item_id === item.id).map((x) => ({
        key: x.id, option_id: x.option_id, stockId: x.stock_item_id,
        qty: qtyFormat.format(x.input_quantity ?? x.quantity).replace(/ |\s/g, ''),
        unit: x.input_unit || byId.get(x.stock_item_id)?.unit || '',
      })))
    }, (e) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [item.id])

  const byId = useMemo(() => new Map((stock ?? []).map((s) => [s.id, s])), [stock])
  const prices = useMemo(() => new Map((stock ?? []).map((s) => [s.id, s.last_price])), [stock])

  /** A draft line in stock units: null quantity when it is empty or cannot be converted. */
  const converted = (l: DraftLine) => {
    const s = byId.get(l.stockId)
    const n = parseQty(l.qty)
    if (!s || n === null || n <= 0) return null
    const q = toStockUnit(n, l.unit || s.unit, s.unit)
    return q == null || q <= 0 ? null : q
  }
  /** Lines of the draft as saved: complete lines only. */
  const complete = (lines: DraftLine[]) =>
    lines.flatMap((l) => {
      const q = converted(l)
      return q == null ? [] : [{ option_id: l.option_id, stock_item_id: l.stockId, quantity: q }]
    })

  const costOf = (v: RecipeVariant) => {
    const own = complete(draft.filter((l) => l.option_id === v.option_id))
    const lines = v.kind === 'size' ? [...complete(draft.filter((l) => l.option_id === null)), ...own] : own
    return { ...linesCost(lines, prices), count: lines.length }
  }

  const current = variants.find((v) => variantKey(v.option_id) === active) ?? variants[0]
  const currentLines = draft.filter((l) => l.option_id === current.option_id)
  const setLine = (key: string, patch: Partial<DraftLine>) => {
    setDirty(true)
    setDraft((d) => d.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }
  const addLine = () => {
    setDirty(true)
    setDraft((d) => [...d, { key: newId(), option_id: current.option_id, stockId: '', qty: '', unit: '' }])
  }
  const removeLine = (key: string) => {
    setDirty(true)
    setDraft((d) => d.filter((l) => l.key !== key))
  }

  /** Checks the draft; returns the lines to save or shows what is wrong. */
  function validLines(): RecipeLineInput[] | null {
    const out: RecipeLineInput[] = []
    const seen = new Set<string>()
    for (const l of draft) {
      if (!l.stockId && !l.qty.trim()) continue
      const v = variants.find((x) => x.option_id === l.option_id)
      const where = v ? variantLabel(v) : ''
      const s = byId.get(l.stockId)
      if (!s) return fail(`${where} : ${t.errRecipeIngredient}`)
      const n = parseQty(l.qty)
      if (n === null || n <= 0) return fail(`${where} · ${s.name} : ${t.errQuantity}`)
      const unit = l.unit || s.unit
      const q = toStockUnit(n, unit, s.unit)
      if (q == null || q <= 0) return fail(`${where} · ${s.name} : ${t.errQuantity}`)
      const k = `${l.option_id}:${s.id}`
      if (seen.has(k)) return fail(`${where} · ${s.name} : ${t.errRecipeDuplicate}`)
      seen.add(k)
      out.push({ option_id: l.option_id, stock_item_id: s.id, quantity: q, input_unit: unit === s.unit ? '' : unit, input_quantity: n })
    }
    return out
    function fail(message: string) {
      setError(message)
      return null
    }
  }

  async function save() {
    setError(null)
    const lines = validLines()
    if (!lines) return
    setBusy(true)
    try {
      await recipes.save(item.id, lines)
      setDirty(false)
      onSaved?.()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  async function duplicate() {
    const target = menu.items.find((i) => i.id === copyTo)
    if (!target) return
    setError(null)
    setNotice(null)
    const lines = validLines()
    if (!lines) return
    const targetGroups = menu.groups[target.id] ?? []
    const from = { lines: lines.map((l, position): RecipeLine => ({ ...l, id: '', item_id: item.id, position })), groups }
    const { lines: copied, dropped } = copyRecipe(from, { groups: targetGroups })
    const existing = allLines.filter((l) => l.item_id === target.id).length
    const ask = existing ? `${t.recipeCopyConfirmReplace(target.name)} ` : ''
    if (!(await dialog.confirm(`${ask}${t.recipeCopyConfirm(item.name, target.name, copied.length)}${dropped ? ` ${t.recipeCopyDropped(dropped)}` : ''}`, t.recipeCopy))) return
    setBusy(true)
    try {
      await recipes.save(target.id, copied)
      setAllLines(await recipes.list())
      setNotice(t.recipeCopied(target.name))
      setCopyTo('')
      onSaved?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  async function close() {
    if (dirty && !(await dialog.confirm(t.recipeLeave, t.recipeLeaveOk))) return
    onClose()
  }

  function variantLabel(v: RecipeVariant) {
    if (v.kind === 'base') return hasSizes ? t.recipeBaseShared : t.recipeBase
    if (v.kind === 'size') return `${v.group} ${v.label}`
    return `${v.label} (${v.group})`
  }

  const others = menu.items.filter((i) => i.id !== item.id).sort((a, b) => a.name.localeCompare(b.name))
  const summary = variants.filter((v) => v.kind !== 'base' || !hasSizes)
  const cur = costOf(current)
  const curMargin = margin(current.price, cur.cost)

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog item-editor recipe-editor" role="dialog" aria-modal="true" aria-labelledby="recipe-title"
        onKeyDown={(e) => e.key === 'Escape' && close()}>
        <div className="panel-head">
          <h2 id="recipe-title">{t.recipeTitle(item.name)}</h2>
          <button type="button" className="ghost" onClick={close} aria-label={t.close}>✕</button>
        </div>
        <p className="muted small">{t.recipeIntro}</p>

        {!stock ? (
          error ? <p className="error small">{error}</p> : <p className="muted">{t.loading}</p>
        ) : (
          <>
            <div className="segmented recipe-tabs" role="tablist" aria-label={t.recipeVariants}>
              {variants.map((v) => {
                const k = variantKey(v.option_id)
                const filled = draft.some((l) => l.option_id === v.option_id && l.stockId)
                return (
                  <button key={k} type="button" role="tab" aria-selected={active === k} className={active === k ? 'on' : ''} onClick={() => setActive(k)}>
                    {v.kind === 'option' && <span className="muted small">+ </span>}
                    <bdi>{v.kind === 'base' ? (hasSizes ? t.recipeBaseShared : t.recipeBase) : v.label}</bdi>
                    {filled && <span className="recipe-dot" aria-label={t.recipeFilled}>●</span>}
                  </button>
                )
              })}
            </div>
            <p className="muted small">
              {current.kind === 'base' ? (hasSizes ? t.recipeBaseSharedHint : t.recipeBaseHint)
                : current.kind === 'size' ? t.recipeSizeHint(current.label) : t.recipeOptionHint(current.label)}
            </p>

            {stock.length === 0 ? (
              <p className="muted small">{t.recipeNoStock}</p>
            ) : (
              <div className="pur-lines recipe-lines" role="table" aria-label={variantLabel(current)}>
                <div className="pur-line recipe-line pur-line-head" role="row">
                  <span role="columnheader">{t.recipeIngredient}</span>
                  <span role="columnheader">{t.recipeQtyPerPortion}</span>
                  <span role="columnheader">{t.colUnit}</span>
                  <span role="columnheader" className="num">{t.recipeCost}</span>
                  <span />
                </div>
                {currentLines.map((l) => {
                  const s = byId.get(l.stockId)
                  const q = converted(l)
                  const price = s ? prices.get(s.id) : null
                  const units = s ? inputUnits(s.unit) : []
                  const unit = l.unit || s?.unit || ''
                  const bad = !!l.qty.trim() && (parseQty(l.qty) === null || (s != null && q == null))
                  return (
                    <div key={l.key} className="pur-line recipe-line" role="row">
                      <label className="pur-item">
                        <span className="pur-label">{t.recipeIngredient}</span>
                        <select value={l.stockId} onChange={(e) => setLine(l.key, { stockId: e.target.value, unit: byId.get(e.target.value)?.unit ?? '' })}>
                          <option value="">{t.recipeChoose}</option>
                          {stock.map((x) => <option key={x.id} value={x.id}>{x.name}{x.unit ? ` (${x.unit})` : ''}</option>)}
                        </select>
                      </label>
                      <label>
                        <span className="pur-label">{t.recipeQtyPerPortion}</span>
                        <input dir="ltr" inputMode="decimal" value={l.qty} placeholder="0" aria-invalid={bad || undefined}
                          onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                      </label>
                      <label>
                        <span className="pur-label">{t.colUnit}</span>
                        {units.length > 1 ? (
                          <select value={unit} onChange={(e) => setLine(l.key, { unit: e.target.value })}>
                            {units.map((u) => <option key={u} value={u}>{u}</option>)}
                          </select>
                        ) : (
                          <input value={unit || '—'} readOnly tabIndex={-1} className="readonly" />
                        )}
                        {s && q != null && unitFactor(unit, s.unit) !== 1 && (
                          <span className="muted small" dir="ltr">= {qtyFormat.format(q)} {s.unit}</span>
                        )}
                      </label>
                      <span className="pur-amount num" title={s && price == null ? t.recipeNoPrice : undefined}>
                        <span className="pur-label">{t.recipeCost}</span>
                        {q == null || !s ? '—' : price == null ? <span className="muted">{t.recipeNoPriceShort}</span> : money(Math.round(q * price * 100) / 100)}
                      </span>
                      <button type="button" className="ghost pur-remove" aria-label={t.purRemoveLine} title={t.purRemoveLine} onClick={() => removeLine(l.key)}>✕</button>
                    </div>
                  )
                })}
                <div>
                  <button type="button" onClick={addLine}>{t.recipeAddIngredient}</button>
                </div>
              </div>
            )}

            <section className="stat-tiles recipe-tiles" aria-live="polite">
              <div className="stat-tile">
                <span className="muted small">{current.kind === 'size' ? t.recipeCostSize : t.recipeCostTotal}</span>
                <strong>{money(cur.cost)}</strong>
                {cur.missing > 0 && <span className="muted small">{t.recipeMissingPrices(cur.missing)}</span>}
              </div>
              {!(current.kind === 'base' && hasSizes) && (
                <>
                  <div className="stat-tile">
                    <span className="muted small">{current.kind === 'option' ? t.recipeOptionPrice : t.recipeSalePrice}</span>
                    <strong>{money(current.price)}</strong>
                  </div>
                  <div className="stat-tile main">
                    <span className="muted small">{t.recipeMargin}</span>
                    <strong className={curMargin.amount < 0 ? 'neg' : ''}>
                      {money(curMargin.amount)}{curMargin.percent != null && ` · ${curMargin.percent.toLocaleString('fr-FR')} %`}
                    </strong>
                  </div>
                </>
              )}
            </section>

            {summary.length > 1 && (
              <table className="bo-table recipe-summary">
                <thead>
                  <tr>
                    <th>{t.recipeVariant}</th>
                    <th className="num">{t.recipeSalePrice}</th>
                    <th className="num">{t.recipeCost}</th>
                    <th className="num">{t.recipeMargin}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((v) => {
                    const c = costOf(v)
                    const m = margin(v.price, c.cost)
                    return (
                      <tr key={variantKey(v.option_id)} className={variantKey(v.option_id) === active ? 'on' : undefined}>
                        <td><button type="button" className="ghost link" onClick={() => setActive(variantKey(v.option_id))}><bdi>{variantLabel(v)}</bdi></button></td>
                        <td className="num">{money(v.price)}</td>
                        <td className="num">{c.count ? money(c.cost) : <span className="tag warn">{t.recipeNone}</span>}</td>
                        <td className={`num${m.amount < 0 ? ' neg' : ''}`}>{c.count ? `${money(m.amount)}${m.percent != null ? ` · ${m.percent.toLocaleString('fr-FR')} %` : ''}` : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}

            {others.length > 0 && (
              <div className="row recipe-copy">
                <label>
                  {t.recipeCopyTo}
                  <select value={copyTo} onChange={(e) => setCopyTo(e.target.value)}>
                    <option value="">{t.recipeChooseItem}</option>
                    {others.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                  </select>
                </label>
                <button type="button" disabled={!copyTo || busy} onClick={duplicate}>{t.recipeCopy}</button>
              </div>
            )}
          </>
        )}

        {notice && <p className="small ok-text" role="status">{notice}</p>}
        {error && stock && <p className="error small" role="alert">{error}</p>}
        <div className="dialog-actions">
          <div className="spacer" />
          <button type="button" onClick={close}>{t.cancel}</button>
          <button type="button" className="primary" disabled={busy || !stock} onClick={save}>{busy ? t.saving : t.save}</button>
        </div>
      </div>
      {dialog.element}
    </div>
  )
}


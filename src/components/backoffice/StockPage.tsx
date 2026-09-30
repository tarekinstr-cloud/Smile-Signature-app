import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { backOffice, insufficientStock } from '../../lib/backoffice'
import type { StockItem } from '../../lib/types'
import { useI18n } from '../../lib/i18n'
import { useDialog } from '../Dialog'
import { purchaseHint } from '../../lib/units'
import { errorText, locale, useLoad } from './useLoad'

const qtyFormat = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 })
/** "12,5 kg" */
export const qtyText = (s: Pick<StockItem, 'quantity' | 'unit'>, quantity = s.quantity) => `${qtyFormat.format(quantity)}${s.unit ? ` ${s.unit}` : ''}`

/** Parses "2,5" or "2.5"; null when it is not a number. */
const parseQty = (v: string) => {
  const n = Number(v.replace(',', '.').trim())
  return v.trim() && Number.isFinite(n) ? n : null
}

type Editing = { kind: 'new' } | { kind: 'edit'; item: StockItem } | { kind: 'adjust'; item: StockItem }

/**
 * Gestion du Stock: ingredients and products with their quantity at the Dépôt and in the Cuisine. The ± adjustment
 * works on the Dépôt; the Cuisine changes through Transfert dépôt / cuisine and Charges cuisine, and the sales consume it through the fiches techniques (it may go below 0).
 */
export default function StockPage() {
  const { t, lang } = useI18n()
  const load = useCallback(() => backOffice.listStock(), [])
  const { data: items, error, setError, reload } = useLoad(load)
  // Another tablet adjusting the stock updates this list too.
  useEffect(() => backOffice.subscribeStock(() => reload()), [reload])
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)
  const [name, setName] = useState('')
  const [unit, setUnit] = useState('')
  const [qty, setQty] = useState('')
  const [minQty, setMinQty] = useState('')
  const [buyUnit, setBuyUnit] = useState('')
  const [buyFactor, setBuyFactor] = useState('')
  const [direction, setDirection] = useState<1 | -1>(1)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dialog = useDialog()

  function open(e: Editing) {
    setFormError(null)
    setName(e.kind === 'new' ? '' : e.item.name)
    setUnit(e.kind === 'new' ? '' : e.item.unit)
    setQty(e.kind === 'new' ? '0' : '')
    setMinQty(e.kind === 'edit' && e.item.min_quantity != null ? String(e.item.min_quantity) : '')
    setBuyUnit(e.kind === 'edit' ? e.item.purchase_unit : '')
    setBuyFactor(e.kind === 'edit' && e.item.purchase_factor != null ? String(e.item.purchase_factor) : '')
    setDirection(1)
    setEditing(e)
  }

  async function save(ev: FormEvent) {
    ev.preventDefault()
    if (!editing) return
    const n = parseQty(qty)
    if (editing.kind !== 'edit' && (n === null || (editing.kind === 'adjust' && n <= 0))) return setFormError(t.errQuantity)
    if (editing.kind !== 'adjust' && !name.trim()) return setFormError(t.errNameEmpty)
    if (editing.kind === 'new' && n! < 0) return setFormError(t.errQuantity)
    // Stock minimum: empty (no alert) or a quantity ≥ 0.
    const min = minQty.trim() ? parseQty(minQty) : null
    if (editing.kind !== 'adjust' && minQty.trim() && (min === null || min < 0)) return setFormError(t.errQuantity)
    // Unité d'achat: both the unit and its coefficient (> 0), or neither.
    const factor = buyFactor.trim() ? parseQty(buyFactor) : null
    if (editing.kind !== 'adjust' && (!!buyUnit.trim() !== !!buyFactor.trim() || (buyFactor.trim() && (factor === null || factor <= 0)))) {
      return setFormError(t.errPurchaseFactor)
    }
    const buy = { purchase_unit: buyUnit.trim(), purchase_factor: buyUnit.trim() ? factor : null }
    if (editing.kind === 'adjust' && direction === -1 && n! > editing.item.quantity) {
      return setFormError(insufficientStock(editing.item.name, editing.item.unit, 'depot', editing.item.quantity, n!).message)
    }
    setBusy(true)
    try {
      setFormError(null)
      if (editing.kind === 'new') {
        await backOffice.createStockItem({ name, unit, quantity: n!, ...(min !== null && { min_quantity: min }), ...(buy.purchase_unit && buy) })
      } else if (editing.kind === 'edit') {
        const buyChanged = buy.purchase_unit !== editing.item.purchase_unit || buy.purchase_factor !== editing.item.purchase_factor
        await backOffice.updateStockItem(editing.item.id, {
          name, unit, ...((min ?? null) !== editing.item.min_quantity && { min_quantity: min }), ...(buyChanged && buy),
        })
      }
      else await backOffice.adjustStock(editing.item.id, direction * n!)
      setEditing(null)
      await reload()
    } catch (e) {
      setFormError(errorText(e))
    }
    setBusy(false)
  }

  async function remove(item: StockItem) {
    if (!(await dialog.confirm(t.confirmDeleteStock(item.name)))) return
    setEditing(null)
    try {
      await backOffice.deleteStockItem(item.id)
    } catch (e) {
      setError(errorText(e))
    }
    await reload()
  }

  const q = query.trim().toLowerCase()
  const shown = items?.filter((s) => !q || s.name.toLowerCase().includes(q)) ?? []
  const adjustN = parseQty(qty)
  const when = (iso: string) => new Date(iso).toLocaleString(locale(lang), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <section className="panel">
        <div className="panel-head bo-head">
          <input type="search" className="bo-search" placeholder={t.search} aria-label={t.search} value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="primary" onClick={() => open({ kind: 'new' })}>{t.addStockItem}</button>
        </div>
        {!items ? (
          !error && <p className="muted">{t.loading}</p>
        ) : items.length === 0 ? (
          <p className="muted small">{t.noStock}</p>
        ) : shown.length === 0 ? (
          <p className="muted small">{t.noMatch}</p>
        ) : (
          <table className="bo-table stock-table">
            <thead>
              <tr>
                <th>{t.colName}</th>
                <th className="num">{t.colDepot}</th>
                <th className="num">{t.colKitchen}</th>
                <th className="num">{t.colTotal}</th>
                <th className="hide-phone">{t.colUpdated}</th>
                <th aria-label={t.adjust} />
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id}>
                  <td>
                    <button className="ghost link" onClick={() => open({ kind: 'edit', item: s })}><bdi>{s.name}</bdi></button>
                  </td>
                  <td className="num" data-label={t.colDepot}>
                    <span className={s.quantity < 0 ? 'neg' : ''} title={s.quantity < 0 ? t.negativeStock : undefined}><bdi>{qtyText(s)}</bdi></span>
                  </td>
                  <td className="num" data-label={t.colKitchen}>
                    <span className={s.kitchen_quantity < 0 ? 'neg' : ''} title={s.kitchen_quantity < 0 ? t.negativeStock : undefined}><bdi>{qtyText(s, s.kitchen_quantity)}</bdi></span>
                  </td>
                  <td className="num" data-label={t.colTotal}>
                    <strong><bdi>{qtyText(s, Math.round((s.quantity + s.kitchen_quantity) * 1000) / 1000)}</bdi></strong>
                    {purchaseHint(s.quantity + s.kitchen_quantity, s) && <div className="muted small"><bdi>≈ {purchaseHint(s.quantity + s.kitchen_quantity, s)}</bdi></div>}
                  </td>
                  <td className="hide-phone muted small">{when(s.updated_at)}</td>
                  <td className="end">
                    <button onClick={() => open({ kind: 'adjust', item: s })} aria-label={`${t.adjust} ${s.name}`}>±<span className="hide-phone"> {t.adjust}</span></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">{t.stockManualHint}</p>
      </section>

      {editing && (
        <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setEditing(null)}>
          <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="stock-title" onSubmit={save}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}>
            <h2 id="stock-title">
              {editing.kind === 'new' ? t.newStockItem : editing.kind === 'edit' ? t.editStockItem(editing.item.name) : t.adjustTitle(editing.item.name)}
            </h2>
            {formError && <p className="error small">{formError}</p>}
            {editing.kind === 'adjust' ? (
              <>
                <p className="muted small">{t.currentStock(`\u2068${t.stockLocation.depot} : ${qtyText(editing.item)}\u2069`)}</p>
                <p className="muted small">{t.adjustDepotHint}</p>
                <div className="segmented stock-dir" role="group">
                  <button type="button" className={direction === 1 ? 'on' : ''} aria-pressed={direction === 1} onClick={() => setDirection(1)}>{t.stockIn}</button>
                  <button type="button" className={direction === -1 ? 'on' : ''} aria-pressed={direction === -1} onClick={() => setDirection(-1)}>{t.stockOut}</button>
                </div>
                <label>
                  {t.adjustQty}{editing.item.unit ? ` (${editing.item.unit})` : ''}
                  <input autoFocus dir="ltr" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
                </label>
                {adjustN !== null && adjustN > 0 && (
                  <p className="small"><strong>{t.newStock(`\u2068${qtyText(editing.item, Math.round((editing.item.quantity + direction * adjustN) * 1000) / 1000)}\u2069`)}</strong></p>
                )}
              </>
            ) : (
              <>
                <label>
                  {t.colName}
                  <input autoFocus value={name} placeholder={t.stockNamePh} onChange={(e) => setName(e.target.value)} />
                </label>
                <div className="row">
                  {editing.kind === 'new' && (
                    <label>
                      {t.initialQty}
                      <input dir="ltr" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
                    </label>
                  )}
                  <label>
                    {t.colUnit}
                    <input value={unit} placeholder={t.stockUnitPh} onChange={(e) => setUnit(e.target.value)} />
                  </label>
                </div>
                <label>
                  {t.stockMinLabel}{unit.trim() ? ` (${unit.trim()})` : ''}
                  <input dir="ltr" inputMode="decimal" value={minQty} placeholder="—" onChange={(e) => setMinQty(e.target.value)} />
                </label>
                <p className="muted small">{t.stockMinHint}</p>
                <div className="row">
                  <label>
                    {t.buyUnitLabel}
                    <input value={buyUnit} placeholder={t.buyUnitPh} onChange={(e) => setBuyUnit(e.target.value)} />
                  </label>
                  <label>
                    {t.buyFactorLabel(buyUnit.trim() || t.buyUnitDefault, unit.trim() || t.buyStockUnitDefault)}
                    <input dir="ltr" inputMode="decimal" value={buyFactor} placeholder="—" onChange={(e) => setBuyFactor(e.target.value)} />
                  </label>
                </div>
                <p className="muted small">{t.buyUnitHint}</p>
              </>
            )}
            <div className="dialog-actions">
              {editing.kind === 'edit' && <button type="button" className="danger" onClick={() => remove(editing.item)}>{t.delete}</button>}
              <div className="spacer" />
              <button type="button" onClick={() => setEditing(null)}>{t.cancel}</button>
              <button type="submit" className="primary" disabled={busy}>{t.save}</button>
            </div>
          </form>
        </div>
      )}
      {dialog.element}
    </main>
  )
}

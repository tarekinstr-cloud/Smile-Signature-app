import { useState, type FormEvent } from 'react'
import type { Category, MenuItem, OptionGroup } from '../lib/types'

export interface DraftOption {
  id?: string
  key: string
  name: string
  price: string
}

export interface DraftGroup {
  id?: string
  key: string
  name: string
  required: boolean
  /** Most options a guest may pick; 1 = pick one. */
  max: number
  options: DraftOption[]
}

export interface ItemDraft {
  name: string
  price: number
  category_id: string
  active: boolean
  groups: {
    id?: string
    name: string
    min_select: number
    max_select: number
    options: { id?: string; name: string; price_delta: number }[]
  }[]
}

interface Props {
  item: MenuItem | null
  categoryId: string
  categories: Category[]
  groups: OptionGroup[]
  onCancel(): void
  onSave(draft: ItemDraft): void
  onDelete?(): void
}

/** Accepts "12", "12.5" and "12,5". */
export const parsePrice = (s: string) => {
  const t = s.trim().replace(',', '.')
  return t === '' || !/^-?\d*\.?\d*$/.test(t) ? NaN : Number(t)
}

const key = () => crypto.randomUUID()

/** Adds or edits one menu item: name, price, category, visibility and its option groups (size, extras…). */
export default function ItemEditor({ item, categoryId, categories, groups, onCancel, onSave, onDelete }: Props) {
  const [name, setName] = useState(item?.name ?? '')
  const [price, setPrice] = useState(item ? String(item.price) : '')
  const [catId, setCatId] = useState(item?.category_id ?? categoryId)
  const [active, setActive] = useState(item?.active ?? true)
  const [draftGroups, setDraftGroups] = useState<DraftGroup[]>(() =>
    groups.map((g) => ({
      id: g.id, key: g.id, name: g.name, required: g.min_select >= 1, max: g.max_select,
      options: g.options.map((o) => ({ id: o.id, key: o.id, name: o.name, price: String(o.price_delta) })),
    })),
  )
  const [error, setError] = useState<string | null>(null)

  const setGroup = (k: string, patch: Partial<DraftGroup>) =>
    setDraftGroups((gs) => gs.map((g) => (g.key === k ? { ...g, ...patch } : g)))
  const setOption = (g: DraftGroup, k: string, patch: Partial<DraftOption>) =>
    setGroup(g.key, { options: g.options.map((o) => (o.key === k ? { ...o, ...patch } : o)) })

  function addGroup() {
    setDraftGroups((gs) => [...gs, { key: key(), name: '', required: false, max: 1, options: [{ key: key(), name: '', price: '0' }] }])
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    const p = parsePrice(price)
    if (!name.trim()) return setError('اكتب اسم الصنف.')
    if (!(p >= 0)) return setError('السعر غير صحيح.')
    const out: ItemDraft['groups'] = []
    for (const g of draftGroups) {
      const opts = g.options.filter((o) => o.name.trim())
      if (!g.name.trim()) return setError('كل مجموعة خيارات تحتاج اسماً (مثلاً: الحجم).')
      if (opts.length === 0) return setError(`أضف خياراً واحداً على الأقل في "${g.name}".`)
      const bad = opts.find((o) => Number.isNaN(parsePrice(o.price)))
      if (bad) return setError(`فرق السعر لـ "${bad.name}" غير صحيح.`)
      out.push({
        id: g.id,
        name: g.name.trim(),
        min_select: g.required ? 1 : 0,
        max_select: Math.max(1, Math.min(g.max, opts.length)),
        options: opts.map((o) => ({ id: o.id, name: o.name.trim(), price_delta: parsePrice(o.price) || 0 })),
      })
    }
    onSave({ name: name.trim(), price: p, category_id: catId, active, groups: out })
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="dialog item-editor" role="dialog" aria-modal="true" aria-labelledby="item-editor-title" onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
        <h2 id="item-editor-title">{item ? `تعديل "${item.name}"` : 'صنف جديد'}</h2>

        <div className="row">
          <label>
            الاسم
            <input autoFocus={!item} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="price-field">
            السعر (DH)
            <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0" />
          </label>
        </div>
        <div className="row">
          <label>
            الفئة
            <select value={catId} onChange={(e) => setCatId(e.target.value)}>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            يظهر في شاشة الطلب
          </label>
        </div>

        <div className="groups">
          <div className="panel-head">
            <h3>الخيارات</h3>
            <button type="button" onClick={addGroup}>+ مجموعة خيارات</button>
          </div>
          {draftGroups.length === 0 && <p className="muted small">لا خيارات: الصنف يُضاف للطلب بضغطة واحدة. أضف مجموعة مثل "الحجم" أو "إضافات".</p>}
          {draftGroups.map((g) => (
            <fieldset key={g.key} className="group-edit">
              <div className="row">
                <label>
                  اسم المجموعة
                  <input value={g.name} placeholder="الحجم" onChange={(e) => setGroup(g.key, { name: e.target.value })} />
                </label>
                <button type="button" className="danger icon" aria-label="حذف المجموعة"
                  onClick={() => setDraftGroups((gs) => gs.filter((x) => x.key !== g.key))}>✕</button>
              </div>
              <div className="row group-rules">
                <label className="check">
                  <input type="checkbox" checked={g.required} onChange={(e) => setGroup(g.key, { required: e.target.checked })} />
                  إجباري
                </label>
                <label className="check">
                  <input type="checkbox" checked={g.max > 1} onChange={(e) => setGroup(g.key, { max: e.target.checked ? Math.max(2, g.options.length) : 1 })} />
                  عدة اختيارات
                </label>
                {g.max > 1 && (
                  <label className="inline">
                    حتى
                    <input type="number" min={2} max={20} value={g.max} onChange={(e) => setGroup(g.key, { max: Math.max(2, Number(e.target.value) || 2) })} />
                  </label>
                )}
              </div>
              {g.options.map((o) => (
                <div key={o.key} className="option-row">
                  <input value={o.name} placeholder="اسم الخيار" aria-label="اسم الخيار" onChange={(e) => setOption(g, o.key, { name: e.target.value })} />
                  <input className="delta" inputMode="decimal" value={o.price} aria-label="فرق السعر" title="فرق السعر (DH)"
                    onChange={(e) => setOption(g, o.key, { price: e.target.value })} />
                  <button type="button" className="ghost icon" aria-label="حذف الخيار"
                    onClick={() => setGroup(g.key, { options: g.options.filter((x) => x.key !== o.key) })}>✕</button>
                </div>
              ))}
              <button type="button" className="ghost add-option"
                onClick={() => setGroup(g.key, { options: [...g.options, { key: key(), name: '', price: '0' }] })}>+ خيار</button>
            </fieldset>
          ))}
          {draftGroups.length > 0 && <p className="muted small">الرقم بجانب كل خيار هو ما يُضاف إلى سعر الصنف (0 = بدون زيادة).</p>}
        </div>

        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          {onDelete && <button type="button" className="danger" onClick={onDelete}>حذف الصنف</button>}
          <div className="spacer" />
          <button type="button" onClick={onCancel}>إلغاء</button>
          <button type="submit" className="primary">حفظ</button>
        </div>
      </form>
    </div>
  )
}

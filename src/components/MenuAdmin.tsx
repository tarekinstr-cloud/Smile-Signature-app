import { useCallback, useEffect, useMemo, useState } from 'react'
import { repo } from '../lib/repo'
import type { Category, Menu, MenuItem } from '../lib/types'
import { money } from '../lib/format'
import { useDialog } from './Dialog'
import ItemEditor, { type ItemDraft } from './ItemEditor'

const COLORS = ['#b45309', '#f59e0b', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#4b5563']

/** Moves list[index] one step up or down and returns the rows whose position changed, with their new sort_order. */
function moved<T extends { id: string; sort_order: number }>(list: T[], index: number, dir: -1 | 1) {
  const to = index + dir
  if (to < 0 || to >= list.length) return []
  const next = [...list]
  ;[next[index], next[to]] = [next[to], next[index]]
  return next.map((x, i) => ({ id: x.id, sort_order: i, changed: x.sort_order !== i })).filter((x) => x.changed)
}

/** Admin screen: categories, items, prices and item options, edited from inside the app. */
export default function MenuAdmin({ onBack }: { onBack(): void }) {
  const [menu, setMenu] = useState<Menu | null>(null)
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [editing, setEditing] = useState<MenuItem | 'new' | null>(null)
  const [catName, setCatName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dialog = useDialog()

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      setError(null)
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }, [])

  const reload = useCallback(async () => {
    const m = await repo.getMenu({ includeHidden: true })
    setMenu(m)
    setCategoryId((id) => (id && m.categories.some((c) => c.id === id) ? id : m.categories[0]?.id ?? null))
  }, [])

  useEffect(() => {
    run(reload)
  }, [run, reload])

  const category = menu?.categories.find((c) => c.id === categoryId) ?? null
  const items = useMemo(() => menu?.items.filter((i) => i.category_id === categoryId) ?? [], [menu, categoryId])

  useEffect(() => setCatName(category?.name ?? ''), [category?.id, category?.name])

  const change = (fn: () => Promise<unknown>) => run(async () => {
    try {
      await fn()
    } finally {
      await reload()
    }
  })

  async function addCategory() {
    const name = await dialog.askText('اسم الفئة الجديدة')
    if (!name || !menu) return
    await change(async () => {
      const sort_order = menu.categories.length ? Math.max(...menu.categories.map((c) => c.sort_order)) + 1 : 0
      const c = await repo.createCategory({ name, color: COLORS[menu.categories.length % COLORS.length], sort_order, active: true })
      setCategoryId(c.id)
    })
  }

  function commitCatName() {
    const v = catName.trim()
    if (!category || !v || v === category.name) return setCatName(category?.name ?? '')
    change(() => repo.updateCategory(category.id, { name: v }))
  }

  async function deleteCategory(c: Category) {
    const n = menu?.items.filter((i) => i.category_id === c.id).length ?? 0
    const what = n ? ` و${n} صنف فيها` : ''
    if (!(await dialog.confirm(`حذف الفئة "${c.name}"${what}؟ الطلبات القديمة لا تتأثر. يمكنك بدلاً من ذلك إخفاؤها.`))) return
    await change(() => repo.deleteCategory(c.id))
  }

  function moveCategory(index: number, dir: -1 | 1) {
    if (!menu) return
    const rows = moved(menu.categories, index, dir)
    change(() => Promise.all(rows.map((r) => repo.updateCategory(r.id, { sort_order: r.sort_order }))))
  }

  function moveItem(index: number, dir: -1 | 1) {
    const rows = moved(items, index, dir)
    change(() => Promise.all(rows.map((r) => repo.updateItem(r.id, { sort_order: r.sort_order }))))
  }

  async function saveItem(draft: ItemDraft) {
    if (!menu) return
    const original = editing === 'new' ? null : editing
    setEditing(null)
    await change(async () => {
      let itemId: string
      const fields = { name: draft.name, price: draft.price, category_id: draft.category_id, active: draft.active }
      if (original) {
        itemId = original.id
        const moving = original.category_id !== draft.category_id
        const patch: Partial<MenuItem> = {}
        for (const k of Object.keys(fields) as (keyof typeof fields)[]) {
          if (original[k] !== fields[k]) (patch as Record<string, unknown>)[k] = fields[k]
        }
        // An item moved to another category goes to the end of it.
        if (moving) patch.sort_order = nextItemOrder(menu, draft.category_id)
        if (Object.keys(patch).length) await repo.updateItem(itemId, patch)
      } else {
        itemId = (await repo.createItem({ ...fields, sort_order: nextItemOrder(menu, draft.category_id) })).id
      }

      const before = original ? menu.groups[original.id] ?? [] : []
      const kept = new Set(draft.groups.map((g) => g.id).filter(Boolean))
      for (const g of before) if (!kept.has(g.id)) await repo.deleteOptionGroup(g.id)

      for (const [gi, g] of draft.groups.entries()) {
        const gFields = { name: g.name, min_select: g.min_select, max_select: g.max_select, sort_order: gi }
        const old = before.find((x) => x.id === g.id)
        let groupId = g.id
        if (!groupId || !old) {
          groupId = (await repo.createOptionGroup({ item_id: itemId, ...gFields })).id
        } else if (old.name !== g.name || old.min_select !== g.min_select || old.max_select !== g.max_select || old.sort_order !== gi) {
          await repo.updateOptionGroup(groupId, gFields)
        }

        const oldOpts = old?.options ?? []
        const keptOpts = new Set(g.options.map((o) => o.id).filter(Boolean))
        for (const o of oldOpts) if (!keptOpts.has(o.id)) await repo.deleteOption(o.id)
        for (const [oi, o] of g.options.entries()) {
          const prev = oldOpts.find((x) => x.id === o.id)
          const oFields = { name: o.name, price_delta: o.price_delta, sort_order: oi }
          if (!prev) await repo.createOption({ group_id: groupId, ...oFields })
          else if (prev.name !== o.name || prev.price_delta !== o.price_delta || prev.sort_order !== oi) await repo.updateOption(prev.id, oFields)
        }
      }
    })
  }

  async function deleteItem(item: MenuItem) {
    if (!(await dialog.confirm(`حذف الصنف "${item.name}"؟ الطلبات القديمة لا تتأثر.`))) return
    setEditing(null)
    await change(() => repo.deleteItem(item.id))
  }

  return (
    <div className="app menu-admin">
      <header className="topbar">
        <button className="ghost back" onClick={onBack} aria-label="رجوع إلى المخطط">→ رجوع</button>
        <div className="order-title">
          <strong>إدارة القائمة</strong>
          <span>الفئات، الأصناف، الأسعار والخيارات</span>
        </div>
        <div className="spacer" />
        {busy && <span className="muted small saving">جارٍ الحفظ…</span>}
      </header>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}

      {!menu ? (
        <div className="center muted">جارٍ التحميل…</div>
      ) : (
        <main className="content admin-content">
          <aside className="side">
            <div className="panel">
              <div className="panel-head">
                <h2>الفئات</h2>
                <button className="primary" onClick={addCategory}>+ فئة</button>
              </div>
              {menu.categories.length === 0 && <p className="muted small">لا توجد فئات بعد.</p>}
              <ul className="admin-list">
                {menu.categories.map((c, i) => (
                  <li key={c.id} className={c.id === categoryId ? 'on' : ''}>
                    <button className="ghost admin-row" onClick={() => setCategoryId(c.id)}>
                      <span className="dot" style={{ background: c.color }} />
                      <span className="grow">{c.name}</span>
                      {!c.active && <span className="tag">مخفية</span>}
                      <span className="muted small">{menu.items.filter((x) => x.category_id === c.id).length}</span>
                    </button>
                    <span className="order-btns">
                      <button className="ghost" disabled={i === 0 || busy} onClick={() => moveCategory(i, -1)} aria-label="للأعلى">▲</button>
                      <button className="ghost" disabled={i === menu.categories.length - 1 || busy} onClick={() => moveCategory(i, 1)} aria-label="للأسفل">▼</button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </aside>

          <section className="admin-main">
            {category ? (
              <>
                <div className="panel category-edit">
                  <div className="row">
                    <label>
                      اسم الفئة
                      <input value={catName} onChange={(e) => setCatName(e.target.value)} onBlur={commitCatName}
                        onKeyDown={(e) => e.key === 'Enter' && commitCatName()} />
                    </label>
                  </div>
                  <div className="field">
                    اللون
                    <div className="swatches">
                      {COLORS.map((col) => (
                        <button key={col} className={col === category.color ? 'swatch on' : 'swatch'} style={{ background: col }}
                          aria-label={col} onClick={() => change(() => repo.updateCategory(category.id, { color: col }))} />
                      ))}
                      <input type="color" value={category.color} aria-label="لون آخر"
                        onChange={(e) => change(() => repo.updateCategory(category.id, { color: e.target.value }))} />
                    </div>
                  </div>
                  <div className="row actions-row">
                    <label className="check">
                      <input type="checkbox" checked={category.active}
                        onChange={(e) => change(() => repo.updateCategory(category.id, { active: e.target.checked }))} />
                      تظهر في شاشة الطلب
                    </label>
                    <button className="danger" onClick={() => deleteCategory(category)}>حذف الفئة</button>
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-head">
                    <h2>أصناف "{category.name}"</h2>
                    <button className="primary" onClick={() => setEditing('new')}>+ صنف</button>
                  </div>
                  {items.length === 0 && <p className="muted small">لا توجد أصناف في هذه الفئة.</p>}
                  <ul className="admin-list items">
                    {items.map((item, i) => {
                      const groups = menu.groups[item.id] ?? []
                      return (
                        <li key={item.id}>
                          <button className="ghost admin-row" onClick={() => setEditing(item)}>
                            <span className="grow">
                              <span className="item-name">{item.name}</span>
                              {groups.length > 0 && <span className="muted small"> · {groups.map((g) => g.name).join('، ')}</span>}
                            </span>
                            {!item.active && <span className="tag">مخفي</span>}
                            <span className="price">{money(item.price)}</span>
                          </button>
                          <span className="order-btns">
                            <button className="ghost" disabled={i === 0 || busy} onClick={() => moveItem(i, -1)} aria-label="للأعلى">▲</button>
                            <button className="ghost" disabled={i === items.length - 1 || busy} onClick={() => moveItem(i, 1)} aria-label="للأسفل">▼</button>
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                  <p className="muted small">اضغط على صنف لتعديل اسمه وسعره وخياراته. تغيير السعر لا يغيّر الطلبات المفتوحة من قبل.</p>
                </div>
              </>
            ) : (
              <div className="card empty">
                <p>ابدأ بإضافة فئة (مثلاً: مشروبات ساخنة).</p>
                <button className="primary" onClick={addCategory}>+ فئة</button>
              </div>
            )}
          </section>
        </main>
      )}

      {editing && menu && category && (
        <ItemEditor
          item={editing === 'new' ? null : editing}
          categoryId={category.id}
          categories={menu.categories}
          groups={editing === 'new' ? [] : menu.groups[editing.id] ?? []}
          onCancel={() => setEditing(null)}
          onSave={saveItem}
          onDelete={editing === 'new' ? undefined : () => deleteItem(editing)}
        />
      )}
      {dialog.element}
    </div>
  )
}

function nextItemOrder(menu: Menu, categoryId: string) {
  const orders = menu.items.filter((i) => i.category_id === categoryId).map((i) => i.sort_order)
  return orders.length ? Math.max(...orders) + 1 : 0
}

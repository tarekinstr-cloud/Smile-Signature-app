import { useCallback, useState, type FormEvent } from 'react'
import { backOffice } from '../../lib/backoffice'
import type { NewSupplier, Supplier } from '../../lib/types'
import { useI18n } from '../../lib/i18n'
import { useDialog } from '../Dialog'
import { errorText, useLoad } from './useLoad'

const empty: NewSupplier = { name: '', phone: '', products: '' }

/** Fournisseurs: name, phone and products supplied, with basic add / edit / delete. */
export default function SuppliersPage() {
  const { t } = useI18n()
  const load = useCallback(() => backOffice.listSuppliers(), [])
  const { data: suppliers, error, setError, reload } = useLoad(load)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null)
  const [draft, setDraft] = useState<NewSupplier>(empty)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dialog = useDialog()

  function open(s: Supplier | 'new') {
    setFormError(null)
    setDraft(s === 'new' ? empty : { name: s.name, phone: s.phone, products: s.products })
    setEditing(s)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!editing) return
    if (!draft.name.trim()) return setFormError(t.errNameEmpty)
    setBusy(true)
    try {
      setFormError(null)
      if (editing === 'new') await backOffice.createSupplier(draft)
      else await backOffice.updateSupplier(editing.id, draft)
      setEditing(null)
      await reload()
    } catch (err) {
      setFormError(errorText(err))
    }
    setBusy(false)
  }

  async function remove(s: Supplier) {
    if (!(await dialog.confirm(t.confirmDeleteSupplier(s.name)))) return
    setEditing(null)
    try {
      await backOffice.deleteSupplier(s.id)
    } catch (err) {
      setError(errorText(err))
    }
    await reload()
  }

  const q = query.trim().toLowerCase()
  const shown = suppliers?.filter((s) => !q || `${s.name} ${s.phone} ${s.products}`.toLowerCase().includes(q)) ?? []

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <section className="panel">
        <div className="panel-head bo-head">
          <input type="search" className="bo-search" placeholder={t.search} aria-label={t.search} value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="primary" onClick={() => open('new')}>{t.addSupplier}</button>
        </div>
        {!suppliers ? (
          !error && <p className="muted">{t.loading}</p>
        ) : suppliers.length === 0 ? (
          <p className="muted small">{t.noSuppliers}</p>
        ) : shown.length === 0 ? (
          <p className="muted small">{t.noMatch}</p>
        ) : (
          <table className="bo-table">
            <thead>
              <tr>
                <th>{t.colName}</th>
                <th>{t.supplierPhone}</th>
                <th className="hide-phone">{t.supplierProducts}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id}>
                  <td>
                    <button className="ghost link" onClick={() => open(s)}><bdi>{s.name}</bdi></button>
                    {s.products && <div className="muted small show-phone"><bdi>{s.products}</bdi></div>}
                  </td>
                  <td>{s.phone ? <a href={`tel:${s.phone.replace(/[^\d+]/g, '')}`} dir="ltr" title={t.call}>{s.phone}</a> : '—'}</td>
                  <td className="hide-phone"><bdi>{s.products || '—'}</bdi></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {editing && (
        <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setEditing(null)}>
          <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="supplier-title" onSubmit={save}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}>
            <h2 id="supplier-title">{editing === 'new' ? t.newSupplier : t.editSupplier(editing.name)}</h2>
            {formError && <p className="error small">{formError}</p>}
            <label>
              {t.colName}
              <input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label>
              {t.supplierPhone}
              <input dir="ltr" type="tel" inputMode="tel" value={draft.phone} placeholder="0550 00 00 00" onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
            </label>
            <label>
              {t.supplierProducts}
              <textarea rows={3} value={draft.products} placeholder={t.supplierProductsPh} onChange={(e) => setDraft({ ...draft, products: e.target.value })} />
            </label>
            <div className="dialog-actions">
              {editing !== 'new' && <button type="button" className="danger" onClick={() => remove(editing)}>{t.delete}</button>}
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

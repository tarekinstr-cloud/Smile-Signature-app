import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { repo } from '../lib/repo'
import type { Category, CategoryPrinters, Printer } from '../lib/types'
import { useDialog } from './Dialog'
import LangToggle from './LangToggle'
import { useI18n } from '../lib/i18n'

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

interface Draft {
  name: string
  ip: string
  port: string
}

/** Settings screen: the kitchen, bar and cashier printers, and which categories each one receives. */
export default function PrinterSettings({ onBack }: { onBack(): void }) {
  const [printers, setPrinters] = useState<Printer[] | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [links, setLinks] = useState<CategoryPrinters>({})
  const [editing, setEditing] = useState<Printer | 'new' | null>(null)
  const [draft, setDraft] = useState<Draft>({ name: '', ip: '', port: '9100' })
  const [formError, setFormError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dialog = useDialog()
  const { t } = useI18n()

  const reload = useCallback(async () => {
    try {
      const [p, menu, l] = await Promise.all([repo.listPrinters(), repo.getMenu({ includeHidden: true }), repo.getCategoryPrinters()])
      setPrinters(p)
      setCategories(menu.categories)
      setLinks(l)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  function open(p: Printer | 'new') {
    setFormError(null)
    setDraft(p === 'new' ? { name: '', ip: '', port: '9100' } : { name: p.name, ip: p.ip ?? '', port: String(p.port) })
    setEditing(p)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!editing || !printers) return
    const name = draft.name.trim()
    const ip = draft.ip.trim()
    const port = Number(draft.port)
    if (!name) return setFormError(t.errPrinterNameEmpty)
    if (ip && !IPV4.test(ip)) return setFormError(t.errPrinterIp)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return setFormError(t.errPrinterPort)
    setBusy(true)
    try {
      setFormError(null)
      if (editing === 'new') {
        const sort_order = printers.length ? Math.max(...printers.map((p) => p.sort_order)) + 1 : 0
        await repo.createPrinter({ name, ip: ip || null, port, sort_order })
      } else {
        await repo.updatePrinter(editing.id, { name, ip: ip || null, port })
      }
      setEditing(null)
      await reload()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    }
    setBusy(false)
  }

  async function remove(p: Printer) {
    if (!(await dialog.confirm(t.confirmDeletePrinter(p.name)))) return
    setEditing(null)
    try {
      setError(null)
      await repo.deletePrinter(p.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    await reload()
  }

  /** Links the category to this printer, or unlinks it; the category's other printers stay. */
  async function toggleCategory(p: Printer, c: Category) {
    const current = links[c.id] ?? []
    const next = current.includes(p.id) ? current.filter((id) => id !== p.id) : [...current, p.id]
    setLinks({ ...links, [c.id]: next })
    try {
      setError(null)
      await repo.setCategoryPrinters(c.id, next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    await reload()
  }

  const categoriesOf = (p: Printer) => categories.filter((c) => links[c.id]?.includes(p.id)).map((c) => c.name)
  const unlinked = categories.filter((c) => !links[c.id]?.length)

  return (
    <div className="app menu-admin">
      <header className="topbar">
        <button className="ghost back" onClick={onBack} aria-label={t.backToFloor}>{t.back}</button>
        <div className="order-title">
          <strong>{t.printers}</strong>
          <span>{t.printersSub}</span>
        </div>
        <div className="spacer" />
        <LangToggle />
      </header>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}

      {!printers ? (
        <div className="center muted">{t.loading}</div>
      ) : (
        <main className="content admin-content printers-content">
          <section className="admin-main">
            <div className="panel">
              <div className="panel-head">
                <h2>{t.printers}</h2>
                <button className="primary" onClick={() => open('new')}>{t.addPrinter}</button>
              </div>
              {printers.length === 0 && <p className="muted small">{t.noPrinters}</p>}
              <ul className="admin-list items">
                {printers.map((p) => {
                  const cats = categoriesOf(p)
                  return (
                    <li key={p.id} className="printer-item">
                      <button className="ghost admin-row" onClick={() => open(p)}>
                        <span className="printer-icon" aria-hidden>🖨</span>
                        <span className="grow">
                          <span className="item-name"><bdi>{p.name}</bdi></span>
                          <span className="muted small printer-cats">
                            {cats.length ? t.printerCategories(cats.join(t.listSep)) : t.printerNoCategory}
                          </span>
                        </span>
                        <span className="tag" dir="ltr">{p.ip ? `${p.ip}:${p.port}` : t.noIp}</span>
                      </button>
                      <div className="printer-links">
                        <span className="muted small">{categories.length ? t.printerCategoriesEdit : t.noCategoriesYet}</span>
                        <div className="printer-chips">
                          {categories.map((c) => {
                            const on = links[c.id]?.includes(p.id) ?? false
                            return (
                              <button key={c.id} className={on ? 'supp-btn on' : 'supp-btn'} aria-pressed={on} onClick={() => toggleCategory(p, c)}>
                                {on ? '✓ ' : ''}<bdi>{c.name}</bdi>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
              {unlinked.length > 0 && printers.length > 0 && (
                <p className="muted small">
                  <span className="tag warn">{t.noPrinterTag}</span> {unlinked.map((c) => c.name).join(t.listSep)}
                </p>
              )}
              <p className="muted small">{t.printerIpHint}</p>
            </div>
          </section>
        </main>
      )}

      {editing && (
        <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setEditing(null)}>
          <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="printer-title" onSubmit={save}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}>
            <h2 id="printer-title">{editing === 'new' ? t.newPrinter : t.editPrinter(editing.name)}</h2>
            {formError && <p className="error small">{formError}</p>}
            <label>
              {t.printerName}
              <input autoFocus value={draft.name} placeholder={t.printerNamePh} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <div className="row">
              <label>
                {t.printerIp}
                <input dir="ltr" inputMode="decimal" value={draft.ip} placeholder="192.168.1.50" onChange={(e) => setDraft({ ...draft, ip: e.target.value })} />
              </label>
              <label className="port-field">
                {t.printerPort}
                <input dir="ltr" inputMode="numeric" value={draft.port} onChange={(e) => setDraft({ ...draft, port: e.target.value })} />
              </label>
            </div>
            <p className="muted small">{t.printerIpHint}</p>
            <div className="dialog-actions">
              {editing !== 'new' && <button type="button" className="danger" onClick={() => remove(editing)}>{t.deletePrinter}</button>}
              <div className="spacer" />
              <button type="button" onClick={() => setEditing(null)}>{t.cancel}</button>
              <button type="submit" className="primary" disabled={busy}>{t.save}</button>
            </div>
          </form>
        </div>
      )}
      {dialog.element}
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { expenses, localIsoDay } from '../../lib/expenses'
import { download, stamp, toCsv } from '../../lib/admin'
import { csvDa, money } from '../../lib/format'
import { useI18n } from '../../lib/i18n'
import { usePermissions } from '../../lib/permissions'
import type { Expense, ExpenseCategory, ExpenseMode } from '../../lib/types'
import { useDialog } from '../Dialog'
import PeriodFilter, { initialPeriod, isoDay, periodRange, rangeLabel, type Period } from './PeriodFilter'
import { parseAmount } from './StatsPage'
import { errorText, locale, useLoad } from './useLoad'

type Tab = 'list' | 'categories'

/** Liste des dépenses: loyer, électricité… paid from the drawer (Fond de sortie) or otherwise; their categories. */
export default function ExpensesPage({ initialPeriod: start }: { initialPeriod?: Period } = {}) {
  const { t } = useI18n()
  const { can } = usePermissions()
  const [tab, setTab] = useState<Tab>('list')
  return (
    <main className="content bo-content">
      {can('expenses') && (
        <div className="segmented bo-tabs inline-tabs" role="tablist" aria-label={t.expensesTitle}>
          {(['list', 'categories'] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {k === 'list' ? t.expensesTitle : t.expenseCategories}
            </button>
          ))}
        </div>
      )}
      {tab === 'list' ? <ExpenseList start={start} /> : <CategoryList />}
    </main>
  )
}

function ExpenseList({ start }: { start?: Period }) {
  const { t, lang } = useI18n()
  const { can } = usePermissions()
  const dialog = useDialog()
  const [period, setPeriod] = useState<Period>(() => start ?? initialPeriod('month'))
  const [categoryId, setCategoryId] = useState('')
  const range = useMemo(() => periodRange(period), [period])
  const first = isoDay(range[0])
  const last = isoDay(new Date(range[1].getTime() - 1))
  const load = useCallback(async () => {
    const [list, categories] = await Promise.all([expenses.list(first, last), expenses.categories()])
    return { list, categories }
  }, [first, last])
  const { data, error, setError, reload } = useLoad(load)
  const [editing, setEditing] = useState<Expense | 'new' | null>(null)
  useEffect(() => expenses.subscribe(reload), [reload])

  const rows = (data?.list ?? []).filter((e) => !categoryId || e.category_id === categoryId)
  const total = Math.round(rows.reduce((s, e) => s + e.amount, 0) * 100) / 100
  const byCategory = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of rows) m.set(e.category_name, (m.get(e.category_name) ?? 0) + e.amount)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])
  const day = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString(locale(lang), { day: '2-digit', month: '2-digit', year: 'numeric' })

  const exportCsv = () => download(`depenses-${stamp()}.csv`, toCsv(rows.map((e) => ({
    [t.colDate]: e.date, [t.dayCategory]: e.category_name, [t.colAmount]: csvDa(e.amount), [t.expenseMode]: t.expenseModes[e.mode],
    [t.resNote]: e.note, [t.expenseBy]: e.user_name,
  }))), 'text/csv;charset=utf-8')

  async function remove(e: Expense) {
    if (!(await dialog.confirm(e.cash_movement_id ? t.expenseDeleteCash : t.expenseDeleteConfirm))) return
    try {
      await expenses.remove(e.id)
      reload()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <>
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <div className="bo-toolbar">
        <PeriodFilter value={period} onChange={setPeriod} presets={['today', '7d', 'month', 'lastMonth', 'custom']} />
        <span className="muted small">{rangeLabel(range, locale(lang))}</span>
        <select className="auto-width" value={categoryId} aria-label={t.dayCategory} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">{t.expenseAllCategories}</option>
          {data?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="spacer" />
        <button type="button" onClick={exportCsv} disabled={!rows.length}>{t.exportCsv}</button>
        {can('expenses') && <button type="button" className="primary" onClick={() => setEditing('new')}>{t.expenseNew}</button>}
      </div>
      <div className="stat-tiles">
        <div className="stat-tile main"><span>{t.expenseTotal}</span><strong>{money(total)}</strong><small className="muted">{t.expenseCount(rows.length)}</small></div>
        {byCategory.slice(0, 4).map(([name, v]) => (
          <div key={name} className="stat-tile"><span>{name}</span><strong>{money(v)}</strong></div>
        ))}
      </div>
      <section className="panel">
        {!data ? (
          !error && <p className="muted">{t.loading}</p>
        ) : !rows.length ? (
          <p className="muted small">{t.expenseNone}</p>
        ) : (
          <div className="table-scroll">
            <table className="bo-table expenses-table">
              <thead>
                <tr>
                  <th>{t.colDate}</th>
                  <th>{t.dayCategory}</th>
                  <th>{t.resNote}</th>
                  <th>{t.expenseMode}</th>
                  <th>{t.expenseBy}</th>
                  <th className="num">{t.colAmount}</th>
                  {can('expenses') && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td>{day(e.date)}</td>
                    <td>{e.category_name}</td>
                    <td>{e.note}</td>
                    <td>{e.cash_movement_id ? <span className="tag warn">{t.expenseFromDrawer}</span> : t.expenseModes[e.mode]}</td>
                    <td className="muted">{e.user_name}</td>
                    <td className="num">{money(e.amount)}</td>
                    {can('expenses') && (
                      <td className="row-actions">
                        <button type="button" className="ghost" onClick={() => setEditing(e)}>{t.edit}</button>
                        <button type="button" className="ghost danger" onClick={() => remove(e)}>{t.delete}</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="total">
                  <td colSpan={5}>{t.total}</td>
                  <td className="num">{money(total)}</td>
                  {can('expenses') && <td />}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>
      {dialog.element}
      {editing && data && (
        <ExpenseDialog expense={editing === 'new' ? null : editing} categories={data.categories}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload() }} />
      )}
    </>
  )
}

/** New expense, or changes to one (a drawer expense follows its Fond de sortie, mode and amount, while the day is open). */
function ExpenseDialog({ expense, categories, onClose, onSaved }: {
  expense: Expense | null
  categories: ExpenseCategory[]
  onClose(): void
  onSaved(): void
}) {
  const { t } = useI18n()
  const usable = categories.filter((c) => c.active || c.id === expense?.category_id)
  const [categoryId, setCategoryId] = useState(expense?.category_id ?? usable[0]?.id ?? '')
  const [amount, setAmount] = useState(expense ? String(expense.amount) : '')
  const [date, setDate] = useState(expense?.date ?? localIsoDay())
  const [mode, setMode] = useState<ExpenseMode>(expense?.mode ?? 'other')
  const [note, setNote] = useState(expense?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cashLocked = !!expense?.cash_movement_id && mode === 'cash'

  async function submit(e: FormEvent) {
    e.preventDefault()
    const n = parseAmount(amount)
    if (n === null || n <= 0) return setError(t.errCashAmount)
    setBusy(true)
    try {
      setError(null)
      await expenses.save({ category_id: categoryId, amount: n, date: mode === 'cash' && !expense?.cash_movement_id ? localIsoDay() : date, mode, note }, expense?.id)
      onSaved()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="expense-title" onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
        <h2 id="expense-title">{expense ? t.expenseEdit : t.expenseNew}</h2>
        {error && <p className="error small" role="alert">{error}</p>}
        <label>
          {t.dayCategory}
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
            {!usable.length && <option value="">—</option>}
            {usable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <div className="res-grid">
          <label>
            {t.colAmount}
            <input autoFocus dir="ltr" inputMode="decimal" value={amount} placeholder="0" onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label>
            {t.colDate}
            <input type="date" value={mode === 'cash' && !expense?.cash_movement_id ? localIsoDay() : date} disabled={mode === 'cash'} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </label>
        </div>
        <div className="segmented" role="radiogroup" aria-label={t.expenseMode}>
          {(['other', 'cash'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''}
              onClick={() => setMode(m)}>
              {t.expenseModes[m]}
            </button>
          ))}
        </div>
        <p className="muted small">{mode === 'cash' ? (cashLocked ? t.expenseCashEditHint : t.expenseCashHint) : t.expenseOtherHint}</p>
        <label>
          {t.resNote}
          <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>{t.cancel}</button>
          <button type="submit" className="primary" disabled={busy || !categoryId}>{busy ? t.saving : t.save}</button>
        </div>
      </form>
    </div>
  )
}

/** Catégories de dépenses: add, rename, hide or delete (past expenses keep their category name). */
function CategoryList() {
  const { t } = useI18n()
  const dialog = useDialog()
  const { data, error, setError, reload } = useLoad(expenses.categories)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => expenses.subscribe(reload), [reload])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      setError(null)
      await fn()
      reload()
    } catch (err) {
      setError(errorText(err))
    }
    setBusy(false)
  }
  async function add(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    await run(() => expenses.saveCategory({ name }))
    setName('')
  }
  async function rename(c: ExpenseCategory) {
    const v = await dialog.askText(t.expenseRename(c.name), t.save)
    if (v) await run(() => expenses.saveCategory({ id: c.id, name: v }))
  }
  async function remove(c: ExpenseCategory) {
    if (await dialog.confirm(t.expenseCategoryDelete(c.name))) await run(() => expenses.deleteCategory(c.id))
  }

  return (
    <>
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <section className="panel">
        <form className="inline-form" onSubmit={add}>
          <input value={name} placeholder={t.expenseCategoryPh} maxLength={60} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="primary" disabled={busy || !name.trim()}>{t.add}</button>
        </form>
        {!data ? (
          !error && <p className="muted">{t.loading}</p>
        ) : (
          <table className="bo-table">
            <tbody>
              {data.map((c) => (
                <tr key={c.id} className={c.active ? '' : 'muted'}>
                  <td>{c.name}</td>
                  <td className="row-actions">
                    <label className="check-label">
                      <input type="checkbox" checked={c.active} disabled={busy} onChange={(e) => run(() => expenses.saveCategory({ id: c.id, name: c.name, active: e.target.checked }))} />
                      {t.expenseCategoryActive}
                    </label>
                    <button type="button" className="ghost" disabled={busy} onClick={() => rename(c)}>{t.edit}</button>
                    <button type="button" className="ghost danger" disabled={busy} onClick={() => remove(c)}>{t.delete}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">{t.expenseCategoriesHint}</p>
      </section>
      {dialog.element}
    </>
  )
}

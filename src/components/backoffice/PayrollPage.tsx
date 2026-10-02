import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { currentMonth, payroll, shiftMonth, todayIso } from '../../lib/payroll'
import type { PayrollRow, SalaryAdvance } from '../../lib/types'
import { useI18n } from '../../lib/i18n'
import { money } from '../../lib/format'
import { useDialog } from '../Dialog'
import { errorText, locale, useLoad } from './useLoad'
import { tzDate } from '../../lib/tz'

/** Parses a DA amount typed with a comma or a dot; null when it is not a number. */
const amount = (text: string) => {
  const n = Number(text.replace(/\s/g, '').replace(',', '.'))
  return text.trim() && Number.isFinite(n) ? n : null
}

const nameOf = (r: { display_name: string; username: string }) => r.display_name || r.username

/** Récapitulatif des salaires: each employee's monthly salary, the month's advances and what is left to pay. */
export default function PayrollPage() {
  const { t, lang } = useI18n()
  const [month, setMonth] = useState(currentMonth)
  const load = useCallback(() => payroll.summary(month), [month])
  const { data, error, setError, reload } = useLoad(load)
  /** Employee whose advances are unfolded under their row. */
  const [open, setOpen] = useState<string | null>(null)
  const [salaryOf, setSalaryOf] = useState<PayrollRow | null>(null)
  /** Add-advance dialog: the employee picked beforehand, or '' to choose in the dialog. */
  const [advanceFor, setAdvanceFor] = useState<string | null>(null)
  /** Bumped after each change so the unfolded history reloads too. */
  const [version, setVersion] = useState(0)
  const dialog = useDialog()

  useEffect(() => payroll.subscribe(() => { reload(); setVersion((v) => v + 1) }), [reload])

  const changed = () => {
    reload()
    setVersion((v) => v + 1)
  }

  const isCurrent = month === currentMonth()
  const [y, m] = month.split('-').map(Number)
  const monthLabel = tzDate(y, m - 1, 1).toLocaleDateString(locale(lang), { month: 'long', year: 'numeric' })
  // Inactive accounts only when something concerns them this month.
  const rows = (data ?? []).filter((r) => r.active || r.monthly_salary > 0 || r.advances > 0)
  const sum = (f: (r: PayrollRow) => number) => rows.reduce((s, r) => s + f(r), 0)

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <div className="bo-toolbar">
        <div className="segmented day-nav" role="group">
          <button onClick={() => setMonth(shiftMonth(month, -1))} aria-label={t.prevMonth} title={t.prevMonth}>{lang === 'ar' ? '›' : '‹'}</button>
          <button className={isCurrent ? 'on' : ''} onClick={() => setMonth(currentMonth())}>{t.thisMonth}</button>
          <button onClick={() => setMonth(shiftMonth(month, 1))} aria-label={t.nextMonth} title={t.nextMonth}>{lang === 'ar' ? '‹' : '›'}</button>
        </div>
        <strong className="day-label">{monthLabel}</strong>
        <div className="spacer" />
        <button className="primary" onClick={() => setAdvanceFor('')} disabled={!rows.length}>{t.advanceAdd}</button>
      </div>

      {!data ? (
        !error && <div className="center muted">{t.loading}</div>
      ) : (
        <>
          <section className="stat-tiles" aria-live="polite">
            <div className="stat-tile">
              <span className="muted small">{t.payrollTotalSalaries}</span>
              <strong>{money(sum((r) => r.monthly_salary))}</strong>
            </div>
            <div className="stat-tile">
              <span className="muted small">{t.payrollTotalAdvances}</span>
              <strong>{money(sum((r) => r.advances))}</strong>
            </div>
            <div className="stat-tile main">
              <span className="muted small">{t.payrollTotalRemaining}</span>
              <strong>{money(sum((r) => r.remaining))}</strong>
            </div>
          </section>

          <section className="panel">
            {rows.length === 0 ? (
              <p className="muted small">{t.payrollNone}</p>
            ) : (
              <table className="bo-table payroll-table">
                <thead>
                  <tr>
                    <th>{t.colEmployee}</th>
                    <th className="num">{t.colSalary}</th>
                    <th className="num">{t.colAdvances}</th>
                    <th className="num">{t.colRemaining}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <PayrollLine key={r.user_id} row={r} month={month} version={version} open={open === r.user_id}
                      onToggle={() => setOpen(open === r.user_id ? null : r.user_id)}
                      onSalary={() => setSalaryOf(r)} onAdvance={() => setAdvanceFor(r.user_id)}
                      onChanged={changed} onError={setError} confirm={dialog.confirm} />
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted small">{t.payrollNote}</p>
          </section>
        </>
      )}

      {dialog.element}
      {salaryOf && <SalaryDialog row={salaryOf} onClose={() => setSalaryOf(null)} onSaved={() => { setSalaryOf(null); changed() }} />}
      {advanceFor !== null && (
        <AdvanceDialog employees={rows.filter((r) => r.active || r.user_id === advanceFor)} userId={advanceFor} month={month}
          onClose={() => setAdvanceFor(null)}
          onSaved={(a) => { setAdvanceFor(null); setOpen(a.user_id); setMonth(a.date.slice(0, 7)); changed() }} />
      )}
    </main>
  )
}

interface LineProps {
  row: PayrollRow
  month: string
  version: number
  open: boolean
  onToggle(): void
  onSalary(): void
  onAdvance(): void
  onChanged(): void
  onError(message: string): void
  confirm(message: string): Promise<boolean>
}

/** One employee: salary, advances, remaining; unfolds into the month's advances. */
function PayrollLine({ row, month, version, open, onToggle, onSalary, onAdvance, onChanged, onError, confirm }: LineProps) {
  const { t, lang } = useI18n()
  const [history, setHistory] = useState<SalaryAdvance[] | null>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    payroll.advances(month, row.user_id).then((h) => live && setHistory(h), (e) => onError(errorText(e)))
    return () => {
      live = false
    }
  }, [open, month, row.user_id, version, onError])

  const day = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number)
    return tzDate(y, m - 1, d).toLocaleDateString(locale(lang), { weekday: 'short', day: 'numeric', month: 'short' })
  }

  async function remove(a: SalaryAdvance) {
    if (!(await confirm(t.advanceConfirmDelete(money(a.amount), nameOf(row))))) return
    try {
      await payroll.removeAdvance(a.id)
      onChanged()
    } catch (err) {
      onError(errorText(err))
    }
  }

  return (
    <>
      <tr className={row.active ? undefined : 'muted'}>
        <td className="payroll-name">
          <button className="ghost link" onClick={onToggle} aria-expanded={open}>
            <span aria-hidden>{open ? '▾' : lang === 'ar' ? '◂' : '▸'}</span> <bdi>{nameOf(row)}</bdi>
          </button>
          {!row.active && <> <span className="tag">{t.userInactive}</span></>}
        </td>
        <td className="num" data-label={t.colSalary}>
          <button className="ghost link num-link" onClick={onSalary} title={t.salaryEdit}>{row.monthly_salary ? money(row.monthly_salary) : t.salaryNotSet}</button>
        </td>
        <td className="num" data-label={t.colAdvances}>{row.advances ? <>{money(row.advances)} <span className="muted small">({row.advances_count})</span></> : '—'}</td>
        <td className={`num strong${row.remaining < 0 ? ' neg' : ''}`} data-label={t.colRemaining}>{money(row.remaining)}</td>
        <td className="row-actions">
          <button onClick={onAdvance} disabled={!row.active}>{t.advanceAddShort}</button>
        </td>
      </tr>
      {open && (
        <tr className="payroll-history">
          <td colSpan={5}>
            {!history ? (
              <p className="muted small">{t.loading}</p>
            ) : history.length === 0 ? (
              <p className="muted small">{t.advancesNone}</p>
            ) : (
              <ul className="advance-list">
                {history.map((a) => (
                  <li key={a.id}>
                    <span className="advance-date">{day(a.date)}</span>
                    <strong className="advance-amount">{money(a.amount)}</strong>
                    <span className="advance-note muted"><bdi>{a.note ?? ''}</bdi></span>
                    <button className="danger" onClick={() => remove(a)} aria-label={t.delete}>{t.delete}</button>
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

/** Salaire mensuel of one employee. */
function SalaryDialog({ row, onClose, onSaved }: { row: PayrollRow; onClose(): void; onSaved(): void }) {
  const { t } = useI18n()
  const [value, setValue] = useState(row.monthly_salary ? String(row.monthly_salary) : '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    const n = value.trim() ? amount(value) : 0
    if (n === null || n < 0) return setError(t.errSalaryAmount)
    setBusy(true)
    try {
      await payroll.setSalary(row.user_id, n)
      onSaved()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="salary-title" onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2 id="salary-title">{t.salaryTitle(nameOf(row))}</h2>
        {error && <p className="error small" role="alert">{error}</p>}
        <label>
          {t.salaryLabel}
          <input autoFocus dir="ltr" inputMode="decimal" value={value} placeholder="45000" onChange={(e) => setValue(e.target.value)} />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>{t.cancel}</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? t.saving : t.save}</button>
        </div>
      </form>
    </div>
  )
}

interface AdvanceProps {
  employees: PayrollRow[]
  /** Employee picked from their row, or '' to choose here. */
  userId: string
  month: string
  onClose(): void
  onSaved(advance: SalaryAdvance): void
}

/** Ajouter un acompte: employee, amount in DA, date (today by default), optional note. */
function AdvanceDialog({ employees, userId, month, onClose, onSaved }: AdvanceProps) {
  const { t } = useI18n()
  const [who, setWho] = useState(userId || (employees.length === 1 ? employees[0].user_id : ''))
  const [value, setValue] = useState('')
  // Today when looking at the current month, else the first day of the month on screen.
  const [date, setDate] = useState(month === currentMonth() ? todayIso() : `${month}-01`)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const employee = employees.find((e) => e.user_id === who)

  async function save(e: FormEvent) {
    e.preventDefault()
    const n = amount(value)
    if (!who) return setError(t.errAdvanceEmployee)
    if (n === null || n <= 0) return setError(t.errAdvanceAmount)
    if (!date) return setError(t.errAdvanceDate)
    setBusy(true)
    try {
      onSaved(await payroll.addAdvance({ user_id: who, amount: n, date, note }))
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="advance-title" onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2 id="advance-title">{employee && userId ? t.advanceTitleFor(nameOf(employee)) : t.advanceAdd}</h2>
        {error && <p className="error small" role="alert">{error}</p>}
        <div className="res-grid">
          {!userId && (
            <label>
              {t.colEmployee}
              <select value={who} onChange={(e) => setWho(e.target.value)} autoFocus>
                <option value="">{t.advanceChoose}</option>
                {employees.map((e) => <option key={e.user_id} value={e.user_id}>{nameOf(e)}</option>)}
              </select>
            </label>
          )}
          <label>
            {t.advanceAmount}
            <input autoFocus={!!userId} dir="ltr" inputMode="decimal" value={value} placeholder="5000" onChange={(e) => setValue(e.target.value)} />
          </label>
          <label>
            {t.advanceDate}
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            {t.advanceNote}
            <input value={note} placeholder={t.advanceNotePh} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        {employee && (
          <p className="muted small">{t.advanceRemainingHint(money(employee.remaining))}</p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>{t.cancel}</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? t.saving : t.advanceSave}</button>
        </div>
      </form>
    </div>
  )
}

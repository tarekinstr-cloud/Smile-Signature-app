import { appNow, tzAddDays, tzIsoDay } from '../../lib/tz'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { backOffice, insufficientStock } from '../../lib/backoffice'
import { HISTORY_LIMIT, movementValue, round2, stockMoves } from '../../lib/stockMoves'
import { auth } from '../../lib/auth'
import { todayIso } from '../../lib/payroll'
import {
  CHARGE_REASONS, type ChargeReason, type MovementFilter, type StockItem, type StockLocation, type StockMovement, type TransferDirection,
} from '../../lib/types'
import { useI18n } from '../../lib/i18n'
import { money } from '../../lib/format'
import { newId } from '../../lib/id'
import { qtyText } from './StockPage'
import { errorText, locale, useLoad } from './useLoad'

/** Parses "2,5" or "2.5" (spaces ignored); null when it is not a number. */
const parseNum = (v: string) => {
  const n = Number(v.replace(/\s/g, '').replace(',', '.'))
  return v.trim() && Number.isFinite(n) ? n : null
}

const held = (s: StockItem, l: StockLocation) => (l === 'depot' ? s.quantity : s.kitchen_quantity)

/** YYYY-MM-DD `days` before today. */
function daysAgo(days: number) {
  return tzIsoDay(tzAddDays(appNow(), -days))
}

type Kind = 'transfers' | 'charges'

/** Transfert dépôt / cuisine: the form, then the history. */
export function StockTransferPage() {
  return <MovesPage kind="transfers" />
}

/** Charges cuisine: the form, then the history with its estimated value. */
export function KitchenChargesPage() {
  return <MovesPage kind="charges" />
}

function MovesPage({ kind }: { kind: Kind }) {
  const load = useCallback(() => backOffice.listStock(), [])
  const { data: stock, error, setError, reload } = useLoad(load)
  const [version, setVersion] = useState(0)
  // Another tablet moving stock updates the quantities and the history (shared « stock » channel).
  useEffect(() => stockMoves.subscribe(() => { reload(); setVersion((v) => v + 1) }), [reload])
  const saved = () => {
    reload()
    setVersion((v) => v + 1)
  }
  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <MoveForm kind={kind} stock={stock} onSaved={saved} />
      <History kind={kind} stock={stock ?? []} version={version} />
    </main>
  )
}

// ───────────── Formulaire ─────────────

interface Line {
  key: string
  stockId: string
  qty: string
}

const emptyLine = (): Line => ({ key: newId(), stockId: '', qty: '' })

function MoveForm({ kind, stock, onSaved }: { kind: Kind; stock: StockItem[] | null; onSaved(): void }) {
  const { t } = useI18n()
  const [direction, setDirection] = useState<TransferDirection>('to_kitchen')
  const [reason, setReason] = useState<ChargeReason | ''>('')
  const [lines, setLines] = useState<Line[]>(() => [emptyLine()])
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [user, setUser] = useState('')
  useEffect(() => {
    auth.current().then((u) => setUser(u ? u.display_name || u.username : ''), () => {})
  }, [])

  const source: StockLocation = kind === 'charges' || direction === 'to_depot' ? 'kitchen' : 'depot'
  const byId = useMemo(() => new Map((stock ?? []).map((s) => [s.id, s])), [stock])
  const setLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  function reset() {
    setLines([emptyLine()])
    setNote('')
    setReason('')
    setError(null)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setNotice(null)
    if (kind === 'charges' && !reason) return setError(t.errChargeReason)
    const filled = lines.filter((l) => l.stockId || l.qty.trim())
    if (!filled.length) return setError(t.errMoveLines)
    const out: { stock_item_id: string; quantity: number }[] = []
    const asked = new Map<string, number>()
    for (const l of filled) {
      const q = parseNum(l.qty)
      if (!l.stockId) return setError(t.errPurchaseItem)
      if (q === null || q <= 0) return setError(t.errQuantity)
      out.push({ stock_item_id: l.stockId, quantity: q })
      asked.set(l.stockId, (asked.get(l.stockId) ?? 0) + q)
    }
    // Checked here for a clear message at once; the database checks again under lock.
    for (const [id, q] of asked) {
      const item = byId.get(id)
      if (!item) return setError(t.errStockGone)
      if (q > held(item, source) + 1e-9) return setError(insufficientStock(item.name, item.unit, source, held(item, source), q).message)
    }
    setBusy(true)
    try {
      setError(null)
      const moved = kind === 'charges'
        ? await stockMoves.charge(reason as ChargeReason, out, note)
        : await stockMoves.transfer(direction, out, note)
      reset()
      setNotice(kind === 'charges' ? t.chargeSaved(moved.length) : direction === 'to_kitchen' ? t.transferSaved(moved.length) : t.returnSaved(moved.length))
      onSaved()
    } catch (err) {
      setError(errorText(err))
    }
    setBusy(false)
  }

  const where = t.stockLocation[source]
  return (
    <section className="panel">
      <h2>{kind === 'charges' ? t.chargeNew : t.transferNew}</h2>
      {notice && <div className="banner ok" role="status" onClick={() => setNotice(null)}>{notice}</div>}
      {!stock ? (
        <p className="muted">{t.loading}</p>
      ) : !stock.length ? (
        <p className="muted small">{t.purNoStock}</p>
      ) : (
        <form className="res-form" onSubmit={save}>
          {error && <p className="error small" role="alert">{error}</p>}
          {kind === 'transfers' ? (
            <div className="pur-payment">
              <span className="pur-label-block">{t.transferDirection}</span>
              <div className="segmented" role="radiogroup" aria-label={t.transferDirection}>
                {(['to_kitchen', 'to_depot'] as const).map((d) => (
                  <button key={d} type="button" role="radio" aria-checked={direction === d} className={direction === d ? 'on' : ''}
                    onClick={() => { setDirection(d); setError(null) }}>
                    {t.transferDirections[d]}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="pur-payment">
              <span className="pur-label-block">{t.chargeReason}</span>
              <div className="segmented moves-reasons" role="radiogroup" aria-label={t.chargeReason}>
                {CHARGE_REASONS.map((r) => (
                  <button key={r} type="button" role="radio" aria-checked={reason === r} className={reason === r ? 'on' : ''} onClick={() => setReason(r)}>
                    {t.chargeReasons[r]}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="pur-lines moves-lines" role="table" aria-label={t.purLines}>
            <div className="pur-line pur-line-head" role="row">
              <span role="columnheader">{t.purColItem}</span>
              <span role="columnheader">{t.purColQty}</span>
              <span role="columnheader" className="num">{t.moveAvailable(where)}</span>
              <span />
            </div>
            {lines.map((l) => {
              const item = byId.get(l.stockId)
              const q = parseNum(l.qty)
              const over = item && q !== null && q > held(item, source) + 1e-9
              return (
                <div className="pur-line" role="row" key={l.key}>
                  <label className="pur-item">
                    <span className="pur-label">{t.purColItem}</span>
                    <select value={l.stockId} onChange={(e) => setLine(l.key, { stockId: e.target.value })}>
                      <option value="">{t.purChooseItem}</option>
                      {stock.map((s) => (
                        <option key={s.id} value={s.id} disabled={held(s, source) <= 0 && s.id !== l.stockId}>
                          {s.name} · {qtyText(s, held(s, source))}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="pur-label">{t.purColQty}{item?.unit ? ` (${item.unit})` : ''}</span>
                    <span className="moves-qty">
                      <input dir="ltr" inputMode="decimal" value={l.qty} placeholder="0" aria-invalid={over || undefined}
                        onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                      {item?.unit && <span className="muted small">{item.unit}</span>}
                    </span>
                  </label>
                  <span className={`num pur-amount${over ? ' neg' : ''}`}>
                    <span className="pur-label">{t.moveAvailable(where)}</span>
                    {item ? <bdi>{qtyText(item, held(item, source))}</bdi> : '—'}
                  </span>
                  <button type="button" className="ghost pur-remove" aria-label={t.purRemoveLine} title={t.purRemoveLine}
                    onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [emptyLine()]))}>✕</button>
                </div>
              )
            })}
          </div>
          <div>
            <button type="button" onClick={() => setLines((ls) => [...ls, emptyLine()])}>{t.purAddLine}</button>
          </div>

          <label>
            {t.moveNote}
            <input value={note} placeholder={t.moveNotePh} onChange={(e) => setNote(e.target.value)} />
          </label>
          <p className="muted small">{t.moveAuto(user)}</p>
          <div className="dialog-actions">
            <button type="button" onClick={reset}>{t.purReset}</button>
            <div className="spacer" />
            <button type="submit" className="primary" disabled={busy}>
              {busy ? t.saving : kind === 'charges' ? t.chargeValidate : direction === 'to_kitchen' ? t.transferValidate : t.returnValidate}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

// ───────────── Historique ─────────────

type DirectionFilter = '' | 'transfer' | 'return'

function History({ kind, stock, version }: { kind: Kind; stock: StockItem[]; version: number }) {
  const { t, lang } = useI18n()
  const [from, setFrom] = useState(() => daysAgo(6))
  const [to, setTo] = useState(todayIso)
  const [itemId, setItemId] = useState('')
  const [reason, setReason] = useState<ChargeReason | ''>('')
  const [dir, setDir] = useState<DirectionFilter>('')
  const [rows, setRows] = useState<StockMovement[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const filter: MovementFilter = { from: from || undefined, to: to || undefined, stock_item_id: itemId || undefined, reason: reason || undefined }
    stockMoves.list(kind, filter).then(
      (r) => { if (live) { setRows(r); setError(null) } },
      (e) => live && setError(errorText(e)),
    )
    return () => {
      live = false
    }
  }, [kind, from, to, itemId, reason, version])

  const shown = (rows ?? []).filter((m) => !dir || m.type === dir)
  const when = (iso: string) => new Date(iso).toLocaleString(locale(lang), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  const values = shown.map(movementValue)
  const total = round2(values.reduce<number>((s, v) => s + (v ?? 0), 0))
  const unpriced = values.filter((v) => v === null).length

  return (
    <section className="panel">
      <h2>{kind === 'charges' ? t.chargeHistory : t.transferHistory}</h2>
      <div className="bo-toolbar pur-filters moves-filters">
        <label>
          {t.moveFrom}
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          {t.moveTo}
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          {t.purColItem}
          <select value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">{t.moveAllItems}</option>
            {stock.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        {kind === 'charges' ? (
          <label>
            {t.chargeReason}
            <select value={reason} onChange={(e) => setReason(e.target.value as ChargeReason | '')}>
              <option value="">{t.chargeAllReasons}</option>
              {CHARGE_REASONS.map((r) => <option key={r} value={r}>{t.chargeReasons[r]}</option>)}
            </select>
          </label>
        ) : (
          <label>
            {t.transferDirection}
            <select value={dir} onChange={(e) => setDir(e.target.value as DirectionFilter)}>
              <option value="">{t.transferAllDirections}</option>
              <option value="transfer">{t.transferDirections.to_kitchen}</option>
              <option value="return">{t.transferDirections.to_depot}</option>
            </select>
          </label>
        )}
      </div>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {!rows ? (
        !error && <p className="muted">{t.loading}</p>
      ) : (
        <>
          {kind === 'charges' && (
            <section className="stat-tiles moves-tiles" aria-live="polite">
              <div className="stat-tile main">
                <span className="muted small">{t.chargeTotalValue}</span>
                <strong>{money(total)}</strong>
              </div>
              <div className="stat-tile">
                <span className="muted small">{t.chargeCount}</span>
                <strong>{shown.length}</strong>
              </div>
            </section>
          )}
          {shown.length === 0 ? (
            <p className="muted small">{t.moveNone}</p>
          ) : (
            <table className="bo-table payroll-table moves-table">
              <thead>
                <tr>
                  <th>{t.moveColDate}</th>
                  <th>{t.purColItem}</th>
                  <th className="num">{t.purColQty}</th>
                  <th>{kind === 'charges' ? t.chargeReason : t.transferDirection}</th>
                  {kind === 'charges' && <th className="num">{t.chargeColValue}</th>}
                  <th>{t.moveColUser}</th>
                  <th>{t.moveNote}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((m, i) => (
                  <tr key={m.id}>
                    <td className="moves-date">{when(m.created_at)}</td>
                    <td className="payroll-name"><bdi>{m.item_name}</bdi></td>
                    <td className="num strong" data-label={t.purColQty}><bdi>{qtyText(m)}</bdi></td>
                    <td data-label={kind === 'charges' ? t.chargeReason : t.transferDirection}>
                      {kind === 'charges'
                        ? <span className={`tag charge-reason ${m.reason}`}>{m.reason ? t.chargeReasons[m.reason] : '—'}</span>
                        : <span className={`tag move-dir ${m.type}`}>{t.transferDirections[m.type === 'return' ? 'to_depot' : 'to_kitchen']}</span>}
                    </td>
                    {kind === 'charges' && (
                      <td className="num" data-label={t.chargeColValue} title={m.unit_cost == null ? t.chargeNoPrice : `${qtyText(m)} × ${money(m.unit_cost)}`}>
                        {values[i] == null ? '—' : money(values[i]!)}
                      </td>
                    )}
                    <td data-label={t.moveColUser}><bdi>{m.user_name || '—'}</bdi></td>
                    <td className="muted small moves-note"><bdi>{m.note}</bdi></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {rows.length >= HISTORY_LIMIT && <p className="muted small">{t.moveLimit(HISTORY_LIMIT)}</p>}
          {kind === 'charges' && <p className="muted small">{unpriced ? t.chargeValueNote + ' ' + t.chargeUnpriced(unpriced) : t.chargeValueNote}</p>}
        </>
      )}
    </section>
  )
}

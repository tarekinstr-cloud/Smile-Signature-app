import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import { methodIcon } from '../../lib/billing'
import { defaultReasons, isCash, paymentLabel, settings } from '../../lib/settings'
import { admin } from '../../lib/admin'
import type { AppUser, ReasonLists } from '../../lib/types'
import { useDialog } from '../Dialog'
import { errorText, useLoad } from './useLoad'

/**
 * Configurations > Paiement: the payment modes offered at checkout, in their order. Espèces is always offered (it is
 * the only one counted in the cash drawer); a mode already used is deactivated rather than deleted.
 */
export function PaymentTab() {
  const { t } = useI18n()
  const dialog = useDialog()
  const load = useCallback(() => settings.listPaymentModes(), [])
  const { data: modes, error, setError, reload } = useLoad(load)
  useEffect(() => settings.subscribe(reload), [reload])
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      setError(null)
      await fn()
      await reload()
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  async function add() {
    const label = (await dialog.askText(t.payModeNew))?.trim()
    if (label) await run(() => settings.createPaymentMode(label))
  }

  async function rename(code: string, current: string) {
    const v = labels[code]
    setLabels(({ [code]: _, ...rest }) => rest)
    if (v === undefined || v.trim() === current) return
    // Empty for Espèces / Carte: back to the app's translated name.
    await run(() => settings.updatePaymentMode(code, { label: v.trim() || (code === 'cash' || code === 'card' || code === 'credit' ? null : current) }))
  }

  async function move(index: number, by: -1 | 1) {
    if (!modes || !modes[index + by]) return
    const list = [...modes]
    ;[list[index], list[index + by]] = [list[index + by], list[index]]
    await run(() => Promise.all(list.map((m, i) => (m.sort_order === i ? null : settings.updatePaymentMode(m.code, { sort_order: i })))))
  }

  async function remove(code: string, name: string) {
    if (!(await dialog.confirm(t.payModeDeleteConfirm(name)))) return
    await run(() => settings.deletePaymentMode(code))
  }

  return (
    <main className="content bo-content settings-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <section className="panel">
        <div className="panel-head">
          <h2>{t.payModesTitle}</h2>
          <button className="primary" onClick={add} disabled={busy || !modes}>{t.payModeAdd}</button>
        </div>
        <p className="muted small">{t.payModesHint}</p>
        {!modes ? (!error && <p className="muted">{t.loading}</p>) : (
          <ul className="halls-list">
            {modes.map((m, i) => {
              const name = paymentLabel(t, m.code, modes)
              return (
                <li key={m.code} className={m.active ? 'hall-row' : 'hall-row off'}>
                  <div className="hall-order">
                    <button className="ghost" onClick={() => move(i, -1)} disabled={busy || i === 0} aria-label={t.moveUpFor(name)}>▲</button>
                    <button className="ghost" onClick={() => move(i, 1)} disabled={busy || i === modes.length - 1} aria-label={t.moveDownFor(name)}>▼</button>
                  </div>
                  <span aria-hidden>{methodIcon(m.code)}</span>
                  <input className="hall-name" aria-label={t.payModeNameFor(name)} value={labels[m.code] ?? name} maxLength={40}
                    onChange={(e) => setLabels({ ...labels, [m.code]: e.target.value })} onBlur={() => rename(m.code, name)}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
                  <span className="muted small hall-count">{isCash(m.code) ? t.inDrawer : t.notInDrawer}</span>
                  <label className="check">
                    <input type="checkbox" checked={m.active} disabled={busy || isCash(m.code)}
                      onChange={(e) => run(() => settings.updatePaymentMode(m.code, { active: e.target.checked }))} />
                    {t.payModeActive}
                  </label>
                  {m.code !== 'cash' && m.code !== 'card' && m.code !== 'credit' && (
                    <button className="danger" onClick={() => remove(m.code, name)} disabled={busy} aria-label={t.payModeDeleteFor(name)}>{t.delete}</button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
      {dialog.element}
    </main>
  )
}

type ReasonKind = keyof ReasonLists

/** Configurations > Motifs: the reasons offered when an order is cancelled, offered or discounted. */
export function ReasonsTab() {
  const { t } = useI18n()
  const load = useCallback(() => settings.getReasons(), [])
  const { data, error, setError, reload } = useLoad(load)
  useEffect(() => settings.subscribe(reload), [reload])
  const [lists, setLists] = useState<Record<ReasonKind, string[]> | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!data) return
    const d = defaultReasons(t)
    setLists({ cancel: data.cancel ?? d.cancel, offer: data.offer ?? d.offer, discount: data.discount ?? d.discount })
  }, [data, t])

  const edit = (kind: ReasonKind, list: string[]) => {
    setSaved(false)
    setLists((l) => l && { ...l, [kind]: list })
  }

  async function save() {
    if (!lists) return
    setBusy(true)
    try {
      setError(null)
      await settings.saveReasons({ cancel: lists.cancel, offer: lists.offer, discount: lists.discount })
      setSaved(true)
      await reload()
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  const kinds: [ReasonKind, string, string][] = [
    ['cancel', t.reasonsCancel, t.reasonsCancelHint],
    ['offer', t.reasonsOffer, t.reasonsOfferHint],
    ['discount', t.reasonsDiscount, t.reasonsDiscountHint],
  ]
  return (
    <main className="content bo-content settings-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {!lists ? (!error && <div className="center muted">{t.loading}</div>) : (
        <>
          {kinds.map(([kind, title, hint]) => (
            <section key={kind} className="panel">
              <h2>{title}</h2>
              <p className="muted small">{hint}</p>
              <ul className="reason-list">
                {lists[kind].map((r, i) => (
                  <li key={i}>
                    <input value={r} maxLength={kind === 'cancel' ? 40 : 60} aria-label={t.reasonN(i + 1)} onChange={(e) => edit(kind, lists[kind].map((x, k) => (k === i ? e.target.value : x)))} />
                    <button className="ghost" onClick={() => edit(kind, lists[kind].filter((_, k) => k !== i))} aria-label={t.reasonRemove(r)}>✕</button>
                  </li>
                ))}
              </ul>
              <div className="row-actions">
                <button onClick={() => edit(kind, [...lists[kind], ''])} disabled={lists[kind].length >= 30}>{t.reasonAdd}</button>
                <button className="ghost" onClick={() => edit(kind, defaultReasons(t)[kind])}>{t.reasonsDefaults}</button>
              </div>
            </section>
          ))}
          <div className="row-actions">
            <button className="primary" onClick={save} disabled={busy}>{busy ? t.saving : t.save}</button>
            {saved && <span className="banner ok small">{t.saved}</span>}
          </div>
        </>
      )}
    </main>
  )
}

/**
 * Configurations > Sécurité: quick login with a 4-digit PIN (in addition to the password) and automatic sign-out after
 * some minutes without a touch. The Admin gives each employee their PIN here.
 */
export function SecurityTab() {
  const { t } = useI18n()
  const dialog = useDialog()
  const load = useCallback(async () => {
    const [sec, isAdmin] = await Promise.all([settings.getSecurity(), admin.isAdmin()])
    const [users, withPin] = isAdmin ? await Promise.all([admin.listUsers(), settings.usersWithPin()]) : [[] as AppUser[], [] as string[]]
    return { sec, isAdmin, users: users.filter((u) => u.active), withPin: new Set(withPin) }
  }, [])
  const { data, error, setError, reload } = useLoad(load)
  useEffect(() => settings.subscribe(reload), [reload])
  const [pinOn, setPinOn] = useState(false)
  const [autoOn, setAutoOn] = useState(false)
  const [minutes, setMinutes] = useState('10')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!data) return
    setPinOn(data.sec.pin_login_enabled)
    setAutoOn(data.sec.auto_logout_min !== null)
    setMinutes(String(data.sec.auto_logout_min ?? 10))
  }, [data])

  async function save() {
    setBusy(true)
    try {
      setError(null)
      await settings.saveSecurity({ pin_login_enabled: pinOn, auto_logout_min: autoOn ? Number(minutes) : null })
      setSaved(true)
      await reload()
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  async function setPin(u: AppUser) {
    const pin = await dialog.askText(t.pinAskFor(u.display_name || u.username), t.save)
    if (pin === null) return
    try {
      setError(null)
      await settings.setUserPin(u.id, pin.trim())
      await reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function clearPin(u: AppUser) {
    if (!(await dialog.confirm(t.pinRemoveConfirm(u.display_name || u.username), t.pinRemove))) return
    try {
      setError(null)
      await settings.setUserPin(u.id, null)
      await reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  const dirty = () => setSaved(false)
  return (
    <main className="content bo-content settings-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {!data ? (!error && <div className="center muted">{t.loading}</div>) : (
        <>
          <section className="panel">
            <h2>{t.secPinTitle}</h2>
            <label className="check">
              <input type="checkbox" checked={pinOn} onChange={(e) => { setPinOn(e.target.checked); dirty() }} />
              {t.secPinLabel}
            </label>
            <p className="muted small">{t.secPinHint}</p>
          </section>
          <section className="panel">
            <h2>{t.secAutoTitle}</h2>
            <div className="config-row">
              <label className="check">
                <input type="checkbox" checked={autoOn} onChange={(e) => { setAutoOn(e.target.checked); dirty() }} />
                {t.secAutoLabel}
              </label>
              <label>
                {t.secAutoMinutes}
                <input type="number" inputMode="numeric" min={1} max={480} value={minutes} disabled={!autoOn}
                  onChange={(e) => { setMinutes(e.target.value); dirty() }} />
              </label>
            </div>
            <p className="muted small">{t.secAutoHint}</p>
          </section>
          <div className="row-actions">
            <button className="primary" onClick={save} disabled={busy}>{busy ? t.saving : t.save}</button>
            {saved && <span className="banner ok small">{t.saved}</span>}
          </div>
          {data.isAdmin && (
            <section className="panel">
              <h2>{t.secPinUsers}</h2>
              <p className="muted small">{t.secPinUsersHint}</p>
              <table className="bo-table control-table">
                <tbody>
                  {data.users.map((u) => {
                    const has = data.withPin.has(u.id)
                    return (
                      <tr key={u.id}>
                        <td><strong dir="ltr">{u.username}</strong> {u.display_name && <span className="muted small"><bdi>{u.display_name}</bdi></span>}</td>
                        <td>{has ? <span className="tag">{t.pinSet}</span> : <span className="muted small">{t.pinNone}</span>}</td>
                        <td className="row-actions">
                          <button onClick={() => setPin(u)}>{has ? t.pinChange : t.pinDefine}</button>
                          {has && <button className="danger" onClick={() => clearPin(u)}>{t.pinRemove}</button>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
      {dialog.element}
    </main>
  )
}

/** Configurations > Service: the cancellations amount that puts the dashboard tile « Annulations » in alert. */
export function CancelAlertPanel() {
  const { t } = useI18n()
  const load = useCallback(() => settings.getCancelAlert(), [])
  const { data, error, setError, reload } = useLoad(load)
  useEffect(() => settings.subscribe(reload), [reload])
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => setValue(data == null ? '' : String(data)), [data])

  async function save() {
    try {
      setError(null)
      await settings.saveCancelAlert(value.trim() === '' ? null : Number(value))
      setSaved(true)
      await reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <main className="content bo-content settings-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <section className="panel">
        <h2>{t.cfgCancelAlertTitle}</h2>
        <p className="muted small">{t.cfgCancelAlertHint}</p>
        <div className="config-row">
          <label>
            {t.cfgCancelAlertAmount}
            <input type="number" inputMode="numeric" min={0} step={100} value={value} placeholder={t.cfgCancelAlertNone}
              onChange={(e) => { setValue(e.target.value); setSaved(false) }} />
          </label>
          <button className="primary" onClick={save}>{t.save}</button>
          {saved && <span className="banner ok small">{t.saved}</span>}
        </div>
      </section>
    </main>
  )
}

import { useCallback, useEffect } from 'react'
import { describeAgent, devices, ONLINE_SECONDS, thisDevice } from '../../lib/devices'
import type { DeviceSession } from '../../lib/types'
import { useI18n } from '../../lib/i18n'
import { useDialog } from '../Dialog'
import { errorText, locale, useLoad } from './useLoad'

type Status = 'online' | 'idle' | 'ended'

const statusOf = (d: DeviceSession): Status => (d.ended_at ? 'ended' : d.idle_seconds <= ONLINE_SECONDS ? 'online' : 'idle')
const ORDER: Record<Status, number> = { online: 0, idle: 1, ended: 2 }

/** Appareils connectés: which tablet or PC is used by whom, and when it was last active. Visibility only. */
export default function DevicesPage() {
  const { t, lang } = useI18n()
  const load = useCallback(() => devices.list(), [])
  const { data, error, setError, reload } = useLoad(load)
  const dialog = useDialog()
  const mine = thisDevice().id

  useEffect(() => devices.subscribe(() => reload()), [reload])
  // Idle times move on even when nothing changes in the table.
  useEffect(() => {
    const timer = window.setInterval(reload, 30_000)
    return () => window.clearInterval(timer)
  }, [reload])

  const ago = (seconds: number) =>
    seconds < 60 ? t.agoNow : seconds < 3600 ? t.agoMinutes(Math.floor(seconds / 60)) : seconds < 86400 ? t.agoHours(Math.floor(seconds / 3600)) : null
  const when = (iso: string) =>
    new Date(iso).toLocaleString(locale(lang), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

  async function remove(d: DeviceSession) {
    if (!(await dialog.confirm(t.deviceConfirmRemove(d.device_name || t.deviceUnnamed), t.deviceRemove))) return
    try {
      await devices.remove(d.id)
      await reload()
    } catch (err) {
      setError(errorText(err))
    }
  }

  const rows = [...(data ?? [])].sort((a, b) => ORDER[statusOf(a)] - ORDER[statusOf(b)] || a.idle_seconds - b.idle_seconds)
  const online = rows.filter((d) => statusOf(d) === 'online').length

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {data && (
        <section className="stat-tiles" aria-live="polite">
          <div className="stat-tile main">
            <span className="muted small">{t.devicesOnline}</span>
            <strong>{online}</strong>
          </div>
          <div className="stat-tile">
            <span className="muted small">{t.devicesKnown}</span>
            <strong>{rows.length}</strong>
          </div>
        </section>
      )}
      <section className="panel">
        {!data ? (
          !error && <p className="muted">{t.loading}</p>
        ) : rows.length === 0 ? (
          <p className="muted small">{t.devicesNone}</p>
        ) : (
          <table className="bo-table devices-table">
            <thead>
              <tr>
                <th>{t.colDevice}</th>
                <th>{t.colUser}</th>
                <th>{t.colStatus}</th>
                <th className="hide-phone">{t.colSince}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const status = statusOf(d)
                const agent = describeAgent(d.user_agent)
                return (
                  <tr key={d.id} className={status === 'ended' ? 'muted' : undefined}>
                    <td>
                      <strong><bdi>{d.device_name || t.deviceUnnamed}</bdi></strong>
                      {d.id === mine && <> <span className="tag">{t.deviceThis}</span></>}
                      {agent && <div className="muted small" dir="ltr">{agent}</div>}
                    </td>
                    <td>
                      <bdi>{d.display_name || d.username}</bdi>
                      {d.display_name && <div className="muted small" dir="ltr">{d.username}</div>}
                    </td>
                    <td>
                      <span className={`device-status ${status}`}>
                        <span className="dot" aria-hidden />
                        {status === 'online' ? t.deviceOnline : status === 'idle' ? t.deviceIdle : t.deviceEnded}
                      </span>
                      <div className="muted small">{ago(d.idle_seconds) ?? when(d.last_seen_at)}</div>
                    </td>
                    <td className="hide-phone muted small">{when(d.started_at)}</td>
                    <td className="row-actions">
                      {d.id !== mine && status !== 'online' && <button onClick={() => remove(d)}>{t.deviceRemove}</button>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <p className="muted small">{t.devicesNote}</p>
      </section>
      {dialog.element}
    </main>
  )
}

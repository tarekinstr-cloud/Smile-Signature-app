import { useCallback, useEffect, useState } from 'react'
import { backOffice } from '../../lib/backoffice'
import { repo, supabase } from '../../lib/repo'
import { useI18n } from '../../lib/i18n'
import { errorText, locale, useLoad } from './useLoad'
import type { StaffDriver } from '../../lib/types'

/** Gestion des employés: the accounts that sign in, read-only (roles do not exist yet). */
export default function StaffPage() {
  const { t, lang } = useI18n()
  const load = useCallback(() => backOffice.listStaff(), [])
  const { data: staff, error, setError } = useLoad(load)
  const [me, setMe] = useState<string | null>(null)

  useEffect(() => {
    supabase?.auth.getUser().then(({ data }) => setMe(data.user?.id ?? null), () => setMe(null))
  }, [])

  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(locale(lang), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : t.never

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <section className="panel">
        {!staff ? (
          !error && <p className="muted">{t.loading}</p>
        ) : (
          <table className="bo-table">
            <thead>
              <tr>
                <th>{t.colEmail}</th>
                <th>{t.colRole}</th>
                <th className="hide-phone">{t.colCreated}</th>
                <th className="hide-phone">{t.colLastSignIn}</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.id}>
                  <td>
                    <bdi>{s.email}</bdi> {s.id === me && <span className="tag">{t.youTag}</span>}
                  </td>
                  <td><span className="tag">{t.roleStaff}</span></td>
                  <td className="hide-phone muted small">{s.created_at ? when(s.created_at) : '—'}</td>
                  <td className="hide-phone muted small">{s.created_at ? when(s.last_sign_in_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">{repo.mode === 'local' ? t.staffDemo : t.staffNote}</p>
      </section>
      <DriversPanel />
    </main>
  )
}

/** Livreurs: which accounts deliver, and their phone (shown under the scooter and given to the customer). */
function DriversPanel() {
  const { t } = useI18n()
  const load = useCallback(() => repo.listStaffDrivers(), [])
  const { data, error, setError, reload } = useLoad(load)
  const [phones, setPhones] = useState<Record<string, string>>({})

  async function save(d: StaffDriver, isDriver: boolean, phone: string) {
    try {
      await repo.setStaffDriver(d.user_id, isDriver, phone)
      reload()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <section className="panel">
      <h2>{t.driversTitle}</h2>
      <p className="muted small">{t.driversHint}</p>
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {!data ? (
        !error && <p className="muted">{t.loading}</p>
      ) : (
        <table className="bo-table drivers-table">
          <thead>
            <tr><th>{t.driverCol}</th><th>{t.driverBox}</th><th>{t.customerPhone}</th></tr>
          </thead>
          <tbody>
            {data.map((d) => {
              const phone = phones[d.user_id] ?? d.phone ?? ''
              return (
                <tr key={d.user_id}>
                  <td><bdi>{d.name}</bdi> <span className="muted small">({d.username})</span></td>
                  <td>
                    <label className="check">
                      <input type="checkbox" checked={d.is_driver} onChange={(e) => save(d, e.target.checked, phone)} />
                      {t.driverBox}
                    </label>
                  </td>
                  <td>
                    <input type="tel" inputMode="tel" dir="ltr" value={phone} maxLength={30} placeholder="0550 00 00 00"
                      onChange={(e) => setPhones((p) => ({ ...p, [d.user_id]: e.target.value }))}
                      onBlur={() => phone !== (d.phone ?? '') && save(d, d.is_driver, phone)} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}

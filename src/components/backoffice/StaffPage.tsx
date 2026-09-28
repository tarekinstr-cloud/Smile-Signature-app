import { useCallback, useEffect, useState } from 'react'
import { backOffice } from '../../lib/backoffice'
import { repo, supabase } from '../../lib/repo'
import { useI18n } from '../../lib/i18n'
import { locale, useLoad } from './useLoad'

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
    </main>
  )
}

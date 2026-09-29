import { useCallback, useEffect, useMemo, useState } from 'react'
import { admin } from '../../lib/admin'
import {
  ACTION_PERMISSIONS, SECTION_PERMISSIONS, permissions, reloadMyPermissions,
  type Permission, type PermissionTable,
} from '../../lib/permissions'
import { USER_ROLES, type AppUser, type UserRole } from '../../lib/types'
import { useI18n } from '../../lib/i18n'
import { errorText } from './useLoad'

/** Value of one permission for one user: follow the role, or an exception (allowed / refused). */
type Choice = 'role' | 'allow' | 'deny'
const CHOICES: Choice[] = ['role', 'allow', 'deny']

/**
 * Fichier → Permissions: what each role, and each user on top of their role, may open (sections) or do (actions).
 * The service screen is always open. Only the Admin role sees this page.
 */
export default function PermissionsPage() {
  const { t } = useI18n()
  const [table, setTable] = useState<PermissionTable | null>(null)
  const [users, setUsers] = useState<AppUser[]>([])
  const [userId, setUserId] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [tbl, us] = await Promise.all([permissions.load(), admin.listUsers()])
      setTable(tbl)
      setUsers(us.filter((u) => u.role))
      setUserId((id) => id || us.find((u) => u.role === 'employe')?.id || us[0]?.id || '')
    } catch (e) {
      setError(errorText(e))
    }
  }, [])
  useEffect(() => {
    load()
  }, [load])

  /** Saves one change, then reloads the table (and the rights of the signed-in account, which may have changed). */
  async function save(fn: () => Promise<void>) {
    setBusy(true)
    try {
      setError(null)
      await fn()
      setTable(await permissions.load())
      await reloadMyPermissions()
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  const user = users.find((u) => u.id === userId) ?? null
  const role: UserRole | null = user?.role ?? null
  const overrides = useMemo(
    () => new Map((table?.users ?? []).filter((o) => o.user_id === userId).map((o) => [o.permission, o.allowed])),
    [table, userId],
  )
  const choiceOf = (p: Permission): Choice => (!overrides.has(p) ? 'role' : overrides.get(p) ? 'allow' : 'deny')

  const groups: [string, readonly Permission[]][] = [
    [t.permSections, SECTION_PERMISSIONS],
    [t.permActions, ACTION_PERMISSIONS],
  ]
  const yesNo = (v: boolean) => <span className={v ? 'perm-yes' : 'perm-no'}>{v ? '✓' : '✕'}</span>

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {!table ? (
        !error && <p className="muted">{t.loading}</p>
      ) : (
        <>
          <section className="panel">
            <h2>{t.permByRole}</h2>
            <p className="muted small">{t.permServiceNote}</p>
            <table className="bo-table perm-table">
              <thead>
                <tr>
                  <th>{t.permColPermission}</th>
                  {USER_ROLES.map((r) => <th key={r} className="perm-cell">{t.roles[r]}</th>)}
                </tr>
              </thead>
              {groups.map(([title, keys]) => (
                <tbody key={title}>
                  <tr className="perm-group"><th colSpan={1 + USER_ROLES.length}>{title}</th></tr>
                  {keys.map((p) => (
                    <tr key={p}>
                      <td>{t.permLabels[p]}</td>
                      {USER_ROLES.map((r) => (
                        <td key={r} className="perm-cell">
                          <input type="checkbox" aria-label={`${t.permLabels[p]} · ${t.roles[r]}`} checked={table.roles[r][p]} disabled={busy}
                            onChange={(e) => save(() => permissions.setRole(r, p, e.target.checked))} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
            <p className="muted small">{t.permAdminNote}</p>
          </section>

          <section className="panel">
            <h2>{t.permByUser}</h2>
            <p className="muted small">{t.permUserNote}</p>
            {users.length === 0 ? (
              <p className="muted">{t.permNoUsers}</p>
            ) : (
              <>
                <label className="perm-user">
                  {t.colUsername}
                  <select value={userId} onChange={(e) => setUserId(e.target.value)}>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.username}{u.display_name ? ` (${u.display_name})` : ''} · {t.roles[u.role!]}
                      </option>
                    ))}
                  </select>
                </label>
                {user && role && (
                  <table className="bo-table perm-table">
                    <thead>
                      <tr>
                        <th>{t.permColPermission}</th>
                        <th>{t.permColChoice}</th>
                        <th className="perm-cell">{t.permColResult}</th>
                      </tr>
                    </thead>
                    {groups.map(([title, keys]) => (
                      <tbody key={title}>
                        <tr className="perm-group"><th colSpan={3}>{title}</th></tr>
                        {keys.map((p) => {
                          const choice = choiceOf(p)
                          const result = choice === 'role' ? table.roles[role][p] : choice === 'allow'
                          return (
                            <tr key={p} className={choice === 'role' ? '' : 'perm-override'}>
                              <td>{t.permLabels[p]}</td>
                              <td>
                                <div className="segmented perm-choice" role="radiogroup" aria-label={t.permLabels[p]}>
                                  {CHOICES.map((c) => (
                                    <button key={c} type="button" role="radio" aria-checked={choice === c} className={choice === c ? 'on' : ''} disabled={busy}
                                      onClick={() => choice !== c && save(() => permissions.setUser(user.id, p, c === 'role' ? null : c === 'allow'))}>
                                      {c === 'role' ? t.permFollowRole(t.roles[role], table.roles[role][p]) : c === 'allow' ? t.permAllow : t.permDeny}
                                    </button>
                                  ))}
                                </div>
                              </td>
                              <td className="perm-cell">{yesNo(result)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    ))}
                  </table>
                )}
              </>
            )}
          </section>
        </>
      )}
    </main>
  )
}

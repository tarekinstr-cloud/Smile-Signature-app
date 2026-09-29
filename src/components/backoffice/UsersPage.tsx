import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { admin, MIN_PASSWORD } from '../../lib/admin'
import { repo } from '../../lib/repo'
import { USER_ROLES, type AppUser, type UserInput } from '../../lib/types'
import { useI18n } from '../../lib/i18n'
import { errorText, locale, useLoad } from './useLoad'

const empty: UserInput = { username: '', display_name: '', role: 'cashier', password: '', active: true }

/** Fichier → Utilisateurs: the accounts, their role and password. Only administrators can change them. */
export default function UsersPage() {
  const { t, lang } = useI18n()
  const load = useCallback(() => admin.listUsers(), [])
  const { data: users, error, setError, reload } = useLoad(load)
  const [me, setMe] = useState<string | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [editing, setEditing] = useState<AppUser | 'new' | null>(null)
  const [draft, setDraft] = useState<UserInput>(empty)
  const [confirm, setConfirm] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    admin.currentUserId().then(setMe, () => setMe(null))
    admin.isAdmin().then(setCanEdit, () => setCanEdit(false))
  }, [])

  function open(u: AppUser | 'new') {
    setFormError(null)
    setConfirm('')
    setDraft(u === 'new' ? empty : {
      id: u.id, username: u.username, display_name: u.display_name, role: u.role ?? 'cashier', password: '', active: u.active,
    })
    setEditing(u)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!editing) return
    if (draft.password !== confirm) return setFormError(t.errPasswordMismatch)
    setBusy(true)
    try {
      setFormError(null)
      await admin.saveUser(draft)
      setEditing(null)
      await reload()
    } catch (err) {
      setFormError(errorText(err))
    }
    setBusy(false)
  }

  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(locale(lang), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : t.never
  const isNew = editing === 'new'
  const self = editing !== 'new' && editing?.id === me

  return (
    <main className="content bo-content">
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <section className="panel">
        <div className="panel-head bo-head">
          <p className="muted small">{canEdit ? t.usersNote : t.usersReadOnly}</p>
          {canEdit && <button className="primary" onClick={() => open('new')}>{t.addUser}</button>}
        </div>
        {!users ? (
          !error && <p className="muted">{t.loading}</p>
        ) : (
          <table className="bo-table users-table">
            <thead>
              <tr>
                <th>{t.colUsername}</th>
                <th>{t.colRole}</th>
                <th>{t.colStatus}</th>
                <th className="hide-phone">{t.colLastSignIn}</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.active ? '' : 'inactive'}>
                  <td>
                    <strong dir="ltr">{u.username}</strong> {u.id === me && <span className="tag">{t.youTag}</span>}
                    {u.display_name && <div className="muted small"><bdi>{u.display_name}</bdi></div>}
                  </td>
                  <td>
                    <span className={`tag role-${u.role ?? 'none'}`}>{u.role ? t.roles[u.role] : t.noProfile}</span>
                  </td>
                  <td>{u.active ? t.userActive : <span className="neg">{t.userInactive}</span>}</td>
                  <td className="hide-phone muted small">{when(u.last_sign_in_at)}</td>
                  {canEdit && (
                    <td className="end"><button onClick={() => open(u)}>{t.editBtn}</button></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {repo.mode === 'local' && <p className="muted small">{t.usersDemo}</p>}
      </section>

      {editing && (
        <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setEditing(null)}>
          <form className="dialog user-dialog" role="dialog" aria-modal="true" aria-labelledby="user-title" onSubmit={save}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}>
            <h2 id="user-title">{isNew ? t.newUser : t.editUser(editing.username)}</h2>
            {formError && <p className="error small">{formError}</p>}
            <label>
              {t.colUsername}
              <input autoFocus={isNew} dir="ltr" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off"
                value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value.toLowerCase() })} />
              <span className="small">{t.usernameHint}</span>
            </label>
            <label>
              {t.colDisplayName}
              <input value={draft.display_name} placeholder={t.displayNamePh} onChange={(e) => setDraft({ ...draft, display_name: e.target.value })} />
            </label>
            <div className="field">
              {t.colRole}
              <div className="segmented role-picker" role="radiogroup" aria-label={t.colRole}>
                {USER_ROLES.map((r) => (
                  <button key={r} type="button" role="radio" aria-checked={draft.role === r} className={draft.role === r ? 'on' : ''}
                    disabled={self && r !== 'admin'} onClick={() => setDraft({ ...draft, role: r })}>
                    {t.roles[r]}
                  </button>
                ))}
              </div>
            </div>
            <label>
              {isNew ? t.passwordLabel : t.passwordKeep}
              <input type="password" dir="ltr" autoComplete="new-password" minLength={draft.password ? MIN_PASSWORD : undefined}
                required={isNew} value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
            </label>
            {(isNew || draft.password) && (
              <label>
                {t.passwordConfirm}
                <input type="password" dir="ltr" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </label>
            )}
            <label className="check">
              <input type="checkbox" checked={draft.active} disabled={self} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
              {t.activeLabel}
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={() => setEditing(null)}>{t.cancel}</button>
              <button type="submit" className="primary" disabled={busy}>{t.save}</button>
            </div>
          </form>
        </div>
      )}
    </main>
  )
}

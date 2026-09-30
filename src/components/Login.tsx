import { useEffect, useRef, useState, type FormEvent } from 'react'
import { auth, type LoginUser } from '../lib/auth'
import { DEMO_ADMIN } from '../lib/admin'
import { repo } from '../lib/repo'
import { useI18n } from '../lib/i18n'
import LangToggle from './LangToggle'
import TouchKeyboard from './TouchKeyboard'
import { setDeviceName, thisDevice } from '../lib/devices'

/**
 * Écran de connexion, before the service screen: user name (drop-down list of the users, or typed), password and
 * Login. Touching a field opens the on-screen AZERTY keyboard; a physical keyboard works as well.
 */
export default function Login() {
  const { t } = useI18n()
  const [users, setUsers] = useState<LoginUser[]>([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  /** Optional name of this tablet or PC, remembered on the device (page Appareils connectés). */
  const [deviceName, setDeviceNameText] = useState(() => thisDevice().name)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [list, setList] = useState(false)
  /** The field the on-screen keyboard types into; null when it is hidden. */
  const [target, setTarget] = useState<HTMLInputElement | null>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    auth.loginUsers().then(setUsers, () => setUsers([]))
  }, [])

  useEffect(() => {
    if (!list) return
    const close = (e: PointerEvent) => !pickerRef.current?.contains(e.target as Node) && setList(false)
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [list])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!username.trim() || !password) return setError(t.loginMissing)
    setBusy(true)
    setError(null)
    try {
      setDeviceName(deviceName)
      await auth.signIn(username, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPassword('')
      setBusy(false)
    }
  }

  function pick(u: LoginUser) {
    setUsername(u.username)
    setList(false)
    setError(null)
    passwordRef.current?.focus()
  }

  // While the on-screen keyboard is open, the device's own keyboard stays closed (inputMode none).
  const fieldProps = {
    inputMode: target ? ('none' as const) : undefined,
    // Touching a field opens the keyboard; moving to the other field (Tab) keeps it open if it is.
    onPointerDown: (e: { currentTarget: HTMLInputElement }) => setTarget(e.currentTarget),
    onFocus: (e: { currentTarget: HTMLInputElement }) => {
      const el = e.currentTarget
      setTarget((cur) => (cur ? el : null))
    },
  }
  const shown = users.find((u) => u.username === username.trim().toLowerCase())

  return (
    <div className={`login-screen${target ? ' kb-open' : ''}`}>
      <form className="card login" onSubmit={submit} autoComplete="off">
        <img src="/icon.svg" alt="" width={64} height={64} />
        <h1>Smile Signature</h1>
        <p className="muted small">{t.loginTitle}</p>

        <div className="field">
          <label htmlFor="login-user">{t.username}</label>
          <div className="user-picker" ref={pickerRef}>
            <input id="login-user" dir="ltr" value={username} autoCapitalize="none" autoCorrect="off" spellCheck={false}
              autoComplete="username" placeholder={users.length ? t.usernamePickPh : t.usernamePh}
              onChange={(e) => { setUsername(e.target.value); setError(null) }} {...fieldProps} />
            {users.length > 0 && (
              <button type="button" className="picker-btn" tabIndex={-1} aria-haspopup="listbox" aria-expanded={list} aria-label={t.userList}
                onClick={() => setList(!list)}>▾</button>
            )}
            {list && (
              <div className="user-list" role="listbox" aria-label={t.userList}>
                {users.map((u) => (
                  <button key={u.username} type="button" role="option" aria-selected={u.username === shown?.username} onClick={() => pick(u)}>
                    <strong dir="ltr">{u.username}</strong>
                    {u.display_name && <span className="muted small"><bdi>{u.display_name}</bdi></span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          {shown?.display_name && <span className="small login-who"><bdi>{shown.display_name}</bdi></span>}
        </div>

        <label>
          {t.password}
          <input ref={passwordRef} type="password" dir="ltr" value={password} autoComplete="current-password"
            onChange={(e) => { setPassword(e.target.value); setError(null) }} {...fieldProps} />
        </label>

        <label>
          {t.deviceNameLabel}
          <input value={deviceName} maxLength={40} placeholder={t.deviceNamePh} autoComplete="off"
            onChange={(e) => setDeviceNameText(e.target.value)} {...fieldProps} />
        </label>

        {error && <p className="error">{error}</p>}
        <button className="primary big" disabled={busy}>{busy ? t.loading : t.loginBtn}</button>
        {repo.mode === 'local' && <p className="muted small">{t.loginDemo(DEMO_ADMIN.username, DEMO_ADMIN.password)}</p>}
        <div className="login-foot">
          {!target && <button type="button" className="ghost" onClick={() => {
            const el = document.getElementById('login-user') as HTMLInputElement
            setTarget(el)
            el.focus()
          }}>⌨ {t.kbShow}</button>}
          <LangToggle />
        </div>
      </form>
      {target && <TouchKeyboard target={target} onHide={() => setTarget(null)} />}
    </div>
  )
}

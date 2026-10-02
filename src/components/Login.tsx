import { useEffect, useRef, useState, type FormEvent } from 'react'
import { auth, type LoginOptions, type LoginUser } from '../lib/auth'
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
  /** Connexion rapide (Paramètres > Sécurité): PIN login is on, and who has a PIN. */
  const [options, setOptions] = useState<LoginOptions>({ pinLogin: false, pinUsers: [] })
  /** The PIN pad is shown instead of the password (for a user who has a PIN). */
  const [usePin, setUsePin] = useState(true)
  const [pin, setPin] = useState('')

  useEffect(() => {
    auth.loginUsers().then(setUsers, () => setUsers([]))
    auth.loginOptions().then(setOptions, () => {})
  }, [])

  const pinUser = options.pinLogin && options.pinUsers.includes(username.trim().toLowerCase())
  const pinMode = pinUser && usePin

  async function submitPin(code: string) {
    setBusy(true)
    setError(null)
    try {
      setDeviceName(deviceName)
      await auth.signInWithPin(username, code)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPin('')
      setBusy(false)
    }
  }

  function typePin(d: string) {
    if (busy) return
    setError(null)
    const next = (pin + d).slice(0, 4)
    setPin(next)
    if (next.length === 4) submitPin(next)
  }

  useEffect(() => {
    if (!list) return
    const close = (e: PointerEvent) => !pickerRef.current?.contains(e.target as Node) && setList(false)
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [list])

  // A physical keyboard types the PIN too (outside the text fields).
  useEffect(() => {
    if (!pinMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (/^\d$/.test(e.key)) typePin(e.key)
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (pinMode) return
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
    setPin('')
    setUsePin(true)
    if (!(options.pinLogin && options.pinUsers.includes(u.username))) passwordRef.current?.focus()
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

        {pinMode ? (
          <div className="pin-login">
            <span className="small">{t.pinLabel}</span>
            <div className="pin-dots" aria-label={t.pinTyped(pin.length)} role="status">
              {[0, 1, 2, 3].map((i) => <span key={i} className={i < pin.length ? 'on' : ''} />)}
            </div>
            <div className="pin-pad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button key={d} type="button" onClick={() => typePin(d)} disabled={busy}>{d}</button>
              ))}
              <button type="button" className="ghost" onClick={() => setPin('')} disabled={busy} aria-label={t.pinClear}>C</button>
              <button type="button" onClick={() => typePin('0')} disabled={busy}>0</button>
              <button type="button" className="ghost" onClick={() => setPin((p) => p.slice(0, -1))} disabled={busy} aria-label={t.pinBackspace}>⌫</button>
            </div>
            <button type="button" className="link" onClick={() => { setUsePin(false); setError(null) }}>{t.pinUsePassword}</button>
          </div>
        ) : (
          <label>
            {t.password}
            <input ref={passwordRef} type="password" dir="ltr" value={password} autoComplete="current-password"
              onChange={(e) => { setPassword(e.target.value); setError(null) }} {...fieldProps} />
            {pinUser && <button type="button" className="link" onClick={() => { setUsePin(true); setPin(''); setError(null) }}>{t.pinUsePin}</button>}
          </label>
        )}

        <label>
          {t.deviceNameLabel}
          <input value={deviceName} maxLength={40} placeholder={t.deviceNamePh} autoComplete="off"
            onChange={(e) => setDeviceNameText(e.target.value)} {...fieldProps} />
        </label>

        {error && <p className="error">{error}</p>}
        {!pinMode && <button className="primary big" disabled={busy}>{busy ? t.loading : t.loginBtn}</button>}
        {pinMode && busy && <p className="muted small">{t.loading}</p>}
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

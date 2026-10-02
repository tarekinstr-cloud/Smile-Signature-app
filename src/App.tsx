import { useCallback, useEffect, useState } from 'react'
import { auth, type SessionUser } from './lib/auth'
import Login from './components/Login'
import FloorScreen from './components/FloorScreen'
import { useI18n } from './lib/i18n'
import { loadMyPermissions } from './lib/permissions'
import { devices, startPresence } from './lib/devices'
import { setDemoUserName } from './lib/repo'
import { settings } from './lib/settings'

/** Écran de connexion until a user signs in, then the service screen. */
export default function App() {
  const { t } = useI18n()
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined)

  const refresh = useCallback(() => {
    // The permissions are read before the screen opens, so its menus and buttons show the right rights at once.
    auth.current().then(
      async (u) => {
        await loadMyPermissions(u)
        setDemoUserName(u ? u.display_name || u.username : null)
        setUser(u)
      },
      () => setUser(null),
    )
  }, [])
  useEffect(() => {
    refresh()
    return auth.subscribe(refresh)
  }, [refresh])

  // Appareils connectés: this device signals its activity while someone is signed in.
  const userId = user?.id
  useEffect(() => (userId ? startPresence() : undefined), [userId])

  const signOut = useCallback(async () => {
    await devices.signOut().catch(() => {})
    await auth.signOut()
  }, [])

  // Déconnexion automatique (Paramètres > Configurations > Sécurité): after X minutes without a touch, a key or a scroll.
  const [autoLogout, setAutoLogout] = useState<number | null>(null)
  useEffect(() => {
    if (!userId) return setAutoLogout(null)
    const load = () => settings.getSecurity().then((s) => setAutoLogout(s.auto_logout_min), () => {})
    load()
    return settings.subscribe(load)
  }, [userId])
  useEffect(() => {
    if (!userId || !autoLogout) return
    let timer = 0
    const arm = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => signOut(), autoLogout * 60_000)
    }
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }))
    arm()
    return () => {
      window.clearTimeout(timer)
      events.forEach((e) => window.removeEventListener(e, arm))
    }
  }, [userId, autoLogout, signOut])

  if (user === undefined) return <div className="center muted">{t.loading}</div>
  if (!user) return <Login />
  return <FloorScreen key={user.id} user={user} onSignOut={signOut} />
}

import { useCallback, useEffect, useState } from 'react'
import { auth, type SessionUser } from './lib/auth'
import Login from './components/Login'
import FloorScreen from './components/FloorScreen'
import { useI18n } from './lib/i18n'
import { loadMyPermissions } from './lib/permissions'

/** Écran de connexion until a user signs in, then the service screen. */
export default function App() {
  const { t } = useI18n()
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined)

  const refresh = useCallback(() => {
    // The permissions are read before the screen opens, so its menus and buttons show the right rights at once.
    auth.current().then(
      async (u) => {
        await loadMyPermissions(u)
        setUser(u)
      },
      () => setUser(null),
    )
  }, [])
  useEffect(() => {
    refresh()
    return auth.subscribe(refresh)
  }, [refresh])

  if (user === undefined) return <div className="center muted">{t.loading}</div>
  if (!user) return <Login />
  return <FloorScreen key={user.id} user={user} onSignOut={() => auth.signOut()} />
}

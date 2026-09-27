import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/repo'
import Login from './components/Login'
import FloorScreen from './components/FloorScreen'

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(supabase ? undefined : null)

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  if (supabase && session === undefined) return <div className="center muted">جارٍ التحميل…</div>
  if (supabase && !session) return <Login />
  return <FloorScreen onSignOut={supabase ? () => supabase!.auth.signOut() : undefined} />
}

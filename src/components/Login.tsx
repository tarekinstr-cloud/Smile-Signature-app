import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/repo'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase!.auth.signInWithPassword({ email, password })
    if (error) setError('البريد أو كلمة السر غير صحيحة')
    setBusy(false)
  }

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <img src="/icon.svg" alt="" width={64} height={64} />
        <h1>Smile Signature</h1>
        <label>
          البريد الإلكتروني
          <input type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        </label>
        <label>
          كلمة السر
          <input type="password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>دخول</button>
      </form>
    </div>
  )
}

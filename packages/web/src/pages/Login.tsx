import { useState, type FormEvent } from 'react'
import { api, ApiError } from '../api.js'

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login(password)
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Anmeldung fehlgeschlagen')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit} className="login-form">
        <h1>deployer</h1>
        <label htmlFor="pw">Passwort</label>
        <input
          id="pw"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit" disabled={busy || password.length === 0}>
          {busy ? 'Prüfe…' : 'Anmelden'}
        </button>
      </form>
    </main>
  )
}

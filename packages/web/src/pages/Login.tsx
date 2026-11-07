import { useState, type FormEvent } from 'react'
import { api, ApiError } from '../api.js'
import { loginSchema } from '@deployer/shared'
import { useFormErrors } from '../lib/form.js'
import { Field } from '../components/Field.js'

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const form = useFormErrors({ schema: loginSchema, values: () => ({ password }) })

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.validateAll()) return
    setBusy(true)
    setError(null)
    try {
      await api.login(password)
      onDone()
    } catch (err) {
      // Falsches Passwort: Meldung direkt am Feld, mit dem Weg zurück.
      if (err instanceof ApiError && err.status === 401) {
        form.setErrors({ password: 'Das Passwort stimmt nicht. Vergessen? ADMIN_PASSWORD in .env ändern und deployer neu starten.' })
        requestAnimationFrame(() => document.getElementById(form.idFor('password'))?.focus())
      } else setError(err instanceof ApiError ? err.message : 'Anmeldung fehlgeschlagen')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit} className="login-form" noValidate ref={form.formRef}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
          </span>
          deployer
        </div>
        <h1 className="visually-hidden">Anmelden bei deployer</h1>
        <Field id={form.idFor('password')} label="Passwort" error={form.errors.password}>
          <input
            {...form.field('password')}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit" className="button-primary" disabled={busy}>
          {busy ? 'Prüfe…' : 'Anmelden'}
        </button>
      </form>
    </main>
  )
}

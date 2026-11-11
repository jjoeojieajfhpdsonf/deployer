import { useState, type FormEvent } from 'react'
import { api, ApiError } from '../api.js'
import { loginSchema } from '@airlock/shared'
import { useFormErrors } from '../lib/form.js'
import { Field } from '../components/Field.js'
import { Logo } from '../components/Logo.js'
import { markLoggedOut } from '../lib/session.js'

/** Anmeldeseite (ohne Sitzung beim Öffnen) */
export function Login({ onDone }: { onDone: () => void }) {
  return (
    <main className="login">
      <LoginForm onDone={onDone} />
    </main>
  )
}

/**
 * Formular der Anmeldung – als Seite oder (UI-Qualität 8) im Dialog über der
 * Seite, wenn die Sitzung unterwegs abläuft.
 */
export function LoginForm({ onDone, inDialog = false, headingId, failed = [] }: {
  onDone: () => void
  inDialog?: boolean
  headingId?: string
  /** Aktionen, die am Ablauf der Sitzung gescheitert sind («Variablen nicht gespeichert») */
  failed?: readonly string[]
}) {
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
        form.setErrors({ password: 'Das Passwort stimmt nicht. Vergessen? ADMIN_PASSWORD in .env ändern und Airlock neu starten.' })
        requestAnimationFrame(() => document.getElementById(form.idFor('password'))?.focus())
      } else setError(err instanceof ApiError ? err.message : 'Anmeldung fehlgeschlagen')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className={inDialog ? 'login-form login-form-dialog' : 'login-form'} noValidate ref={form.formRef}>
      {!inDialog && (
        <div className="brand">
          {/* Bildmarke (provisorisch Variante 1, Wahl offen) */}
          <Logo size={28} className="brand-logo" />
          <span className="brand-name">Airlock</span>
        </div>
      )}
      {/* Im Dialog über der Seite: h2 (die Seite darunter hat ihre eigene h1) */}
      {inDialog
        ? <h2 id={headingId} className="dialog-title">Sitzung abgelaufen</h2>
        : <h1 id={headingId}>Anmelden</h1>}
      <p className="muted login-lede">
        {inDialog
          ? 'Melde dich wieder an – die Seite und deine Eingaben bleiben, wie sie sind.'
          : 'Mit dem Admin-Passwort dieses Servers.'}
      </p>
      {failed.length > 0 && (
        <div className="banner banner-warn session-failed" role="status">
          <p>Wegen der abgelaufenen Sitzung: {failed.join(', ')}. Nach der Anmeldung lässt es sich erneut ausführen.</p>
        </div>
      )}
      <Field id={form.idFor('password')} label="Passwort" error={form.errors.password}>
        <input
          {...form.field('password')}
          type="password"
          autoComplete="current-password"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- einziges Feld, die Anmeldung ist der nächste Schritt
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      {error && <p role="alert" className="error">{error}</p>}
      <button type="submit" className="button-primary" disabled={busy} aria-busy={busy || undefined}>
        Anmelden
      </button>
      {/* Antwort 15: Ausweg aus dem Dialog – zur Anmeldeseite, mit ehrlichem Hinweis */}
      {inDialog && (
        <p className="hint session-escape">
          <button type="button" className="link-button" onClick={() => markLoggedOut()}>Zur Anmeldeseite</button>
          {' '}– ungespeicherte Eingaben auf dieser Seite gehen dabei verloren.
        </p>
      )}
    </form>
  )
}

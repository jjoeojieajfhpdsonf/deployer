import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from '../api.js'
import { loginSchema, totpCodeFormSchema, recoveryCodeFormSchema, type SecondFactorDto, type LoginOptionsDto, type LoginResultDto } from '@airlock/shared'
import { useFormErrors } from '../lib/form.js'
import { Field } from '../components/Field.js'
import { Logo } from '../components/Logo.js'
import { IconKey } from '../components/Icons.js'
import { markLoggedOut } from '../lib/session.js'
import { notifyWarn } from '../lib/feedback.js'
import { getPasskey, passkeysSupported, PasskeyError } from '../lib/webauthn.js'

const codeForm = totpCodeFormSchema
const recoveryForm = recoveryCodeFormSchema

/** Anmeldeseite (ohne Sitzung beim Öffnen) */
export function Login({ onDone }: { onDone: () => void }) {
  return (
    <main className="login">
      <LoginForm onDone={onDone} />
    </main>
  )
}

/** Was die Anmeldeseite anbieten kann (GET /auth/me ohne Sitzung) */
function useLoginOptions(): LoginOptionsDto | null {
  const q = useQuery({ queryKey: ['login-options'], queryFn: api.me, staleTime: 0, retry: false })
  return q.data && !q.data.loggedIn ? q.data.login ?? null : null
}

/** Nach einem Wiederherstellungscode: rechtzeitig an neue Codes erinnern */
function afterLogin(r: LoginResultDto): void {
  if (r.ok && r.recoveryRemaining !== undefined && r.recoveryRemaining <= 3) {
    notifyWarn(r.recoveryRemaining === 0 ? 'Keine Wiederherstellungscodes mehr übrig' : `Nur noch ${r.recoveryRemaining} Wiederherstellungscodes übrig`, {
      description: 'Unter Konto › Sicherheit lassen sich neue erzeugen.',
    })
  }
}

/**
 * Formular der Anmeldung – als Seite oder (UI-Qualität 8) im Dialog über der
 * Seite, wenn die Sitzung unterwegs abläuft.
 *
 * Nacht 3: Passkey zuerst (wenn hier möglich und einer eingerichtet ist),
 * sonst bzw. daneben das Passwort; danach, wenn verlangt, der zweite Schritt
 * mit dem Code aus der Authenticator-App oder einem Wiederherstellungscode.
 */
export function LoginForm({ onDone, inDialog = false, headingId, failed = [] }: {
  onDone: () => void
  inDialog?: boolean
  headingId?: string
  /** Aktionen, die am Ablauf der Sitzung gescheitert sind («Variablen nicht gespeichert») */
  failed?: readonly string[]
}) {
  const options = useLoginOptions()
  const [second, setSecond] = useState<SecondFactorDto | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const passkeyHere = Boolean(options?.passkeyHost.available && options.passkeys && passkeysSupported())
  // Passkey eingerichtet, aber diese Adresse ist nicht die Hauptadresse (nip.io)
  const passkeyElsewhere = Boolean(options?.passkeys && options.passkeyHost.reason === 'other_host' && options.passkeyHost.mainUrl)

  const shell = (body: React.ReactNode) => (
    <div className={inDialog ? 'login-form login-form-dialog' : 'login-form'}>
      {!inDialog && (
        <div className="brand">
          {/* Bildmarke (provisorisch Variante 1, Wahl offen) */}
          <Logo size={28} className="brand-logo" />
          <span className="brand-name">Airlock</span>
        </div>
      )}
      {body}
    </div>
  )

  if (second) {
    return shell(
      <SecondStep
        factors={second}
        inDialog={inDialog}
        headingId={headingId}
        mainUrl={options?.passkeyHost.mainUrl ?? null}
        onDone={(r) => { afterLogin(r); onDone() }}
        onRestart={(msg) => { setSecond(null); setNotice(msg) }}
      />,
    )
  }

  return shell(
    <>
      {/* Im Dialog über der Seite: h2 (die Seite darunter hat ihre eigene h1) */}
      {inDialog
        ? <h2 id={headingId} className="dialog-title">Sitzung abgelaufen</h2>
        : <h1 id={headingId}>Anmelden</h1>}
      <p className="muted login-lede">
        {inDialog
          ? 'Melde dich wieder an – die Seite und deine Eingaben bleiben, wie sie sind.'
          : passkeyHere ? 'Mit deinem Passkey oder dem Admin-Passwort dieses Servers.' : 'Mit dem Admin-Passwort dieses Servers.'}
      </p>
      {failed.length > 0 && (
        <div className="banner banner-warn session-failed" role="status">
          <p>Wegen der abgelaufenen Sitzung: {failed.join(', ')}. Nach der Anmeldung lässt es sich erneut ausführen.</p>
        </div>
      )}
      {passkeyHere && <PasskeyButton onDone={onDone} />}
      {passkeyElsewhere && (
        <p className="hint login-note">
          Passkeys gelten nur unter <a href={options!.passkeyHost.mainUrl!}>{options!.passkeyHost.rpId}</a>. Hier mit
          Passwort und Code aus der Authenticator-App anmelden.
        </p>
      )}
      <PasswordStep
        primary={!passkeyHere}
        notice={notice}
        onSecond={(f) => { setNotice(null); setSecond(f) }}
        onDone={onDone}
      />
      {/* Antwort 15: Ausweg aus dem Dialog – zur Anmeldeseite, mit ehrlichem Hinweis */}
      {inDialog && (
        <p className="hint session-escape">
          <button type="button" className="link-button" onClick={() => markLoggedOut()}>Zur Anmeldeseite</button>
          {' '}– ungespeicherte Eingaben auf dieser Seite gehen dabei verloren.
        </p>
      )}
    </>,
  )
}

function PasskeyButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function go() {
    setBusy(true)
    setError(null)
    try {
      const { options } = await api.passkeyLoginOptions()
      const response = await getPasskey(options)
      await api.passkeyLogin(response)
      onDone()
    } catch (err) {
      if (err instanceof PasskeyError && err.cancelled) setError(null)
      else setError(err instanceof Error ? err.message : 'Anmeldung mit Passkey fehlgeschlagen')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-passkey">
      <button
        type="button"
        className="button-primary login-passkey-button"
        onClick={() => void go()}
        disabled={busy}
        aria-busy={busy || undefined}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- erste Wahl der Anmeldung
        autoFocus
      >
        <IconKey size={16} /> Mit Passkey anmelden
      </button>
      {error && <p role="alert" className="error">{error}</p>}
      <p className="login-or" aria-hidden="true"><span>oder mit Passwort</span></p>
    </div>
  )
}

function PasswordStep({ primary, notice, onSecond, onDone }: {
  primary: boolean
  notice: string | null
  onSecond: (f: SecondFactorDto) => void
  onDone: () => void
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
    try {
      const r = await api.login(password)
      if (r.ok === false && r.secondFactor) onSecond(r.secondFactor)
      else onDone()
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
    <form onSubmit={submit} noValidate ref={form.formRef}>
      {notice && <p role="alert" className="error">{notice}</p>}
      <Field id={form.idFor('password')} label="Passwort" error={form.errors.password}>
        <input
          {...form.field('password')}
          type="password"
          autoComplete="current-password"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- einziges Feld, die Anmeldung ist der nächste Schritt
          autoFocus={primary}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      {error && <p role="alert" className="error">{error}</p>}
      <button type="submit" className={primary ? 'button-primary' : undefined} disabled={busy} aria-busy={busy || undefined}>
        {primary ? 'Anmelden' : 'Mit Passwort anmelden'}
      </button>
    </form>
  )
}

/** Zweiter Schritt: Code aus der App oder Wiederherstellungscode */
function SecondStep({ factors, inDialog, headingId, mainUrl, onDone, onRestart }: {
  factors: SecondFactorDto
  inDialog: boolean
  headingId?: string
  mainUrl: string | null
  onDone: (r: LoginResultDto) => void
  onRestart: (message: string) => void
}) {
  const [useRecovery, setUseRecovery] = useState(!factors.totp)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const form = useFormErrors({
    schema: useRecovery ? recoveryForm : codeForm,
    values: () => (useRecovery ? { recoveryCode: code } : { code }),
  })
  const name = useRecovery ? 'recoveryCode' : 'code'

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.validateAll()) return
    setBusy(true)
    try {
      const r = await api.loginSecondFactor(useRecovery ? { recoveryCode: code } : { code: code.replace(/\s/g, '') })
      onDone(r)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_code') {
        form.setErrors({ [name]: err.message })
        requestAnimationFrame(() => document.getElementById(form.idFor(name))?.focus())
      } else if (err instanceof ApiError && err.code === 'second_factor_expired') {
        onRestart(err.message)
      } else setError(err instanceof ApiError ? err.message : 'Anmeldung fehlgeschlagen')
    } finally {
      setBusy(false)
    }
  }

  const switchTo = (recovery: boolean) => {
    setUseRecovery(recovery)
    setCode('')
    form.reset()
    requestAnimationFrame(() => document.getElementById(form.idFor(recovery ? 'recoveryCode' : 'code'))?.focus())
  }

  const Heading = inDialog ? 'h2' : 'h1'
  return (
    <form onSubmit={submit} noValidate ref={form.formRef}>
      <Heading id={headingId} className={inDialog ? 'dialog-title' : undefined}>Zweiter Schritt</Heading>
      <p className="muted login-lede">
        {useRecovery
          ? 'Gib einen deiner Wiederherstellungscodes ein. Jeder gilt genau einmal.'
          : 'Gib den Code aus deiner Authenticator-App ein.'}
      </p>
      {!factors.totp && mainUrl && (
        <p className="hint login-note">Mit dem Passkey geht es ohne Code unter <a href={mainUrl}>{mainUrl.replace(/^https:\/\//, '')}</a>.</p>
      )}
      {useRecovery ? (
        <Field id={form.idFor('recoveryCode')} label="Wiederherstellungscode" error={form.errors.recoveryCode}>
          <input
            {...form.field('recoveryCode')}
            className="otp-input"
            autoComplete="off"
            spellCheck={false}
            placeholder="xxxx-xxxx-xxxx"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- einziges Feld dieses Schritts
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
      ) : (
        <Field id={form.idFor('code')} label="Code aus der Authenticator-App" error={form.errors.code}>
          <input
            {...form.field('code')}
            className="otp-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- einziges Feld dieses Schritts
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      <button type="submit" className="button-primary" disabled={busy} aria-busy={busy || undefined}>Bestätigen</button>
      <p className="hint login-alt">
        {factors.totp && (
          <button type="button" className="link-button" onClick={() => switchTo(!useRecovery)}>
            {useRecovery ? 'Code aus der App verwenden' : 'Wiederherstellungscode verwenden'}
          </button>
        )}
        <button type="button" className="link-button" onClick={() => onRestart('')}>Zurück zum Passwort</button>
      </p>
    </form>
  )
}

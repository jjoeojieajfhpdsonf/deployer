import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation } from 'react-router-dom'
import { api, ApiError } from '../api.js'
import { PageHead } from '../components/PageHead.js'
import { relativeTime } from '../lib/format.js'
import { fmtDateTime } from '../lib/dates.js'
import { Sk } from '../components/States.js'
import { passwordChangeFormSchema, PASSWORD_MIN } from '@airlock/shared'
import { useFormErrors } from '../lib/form.js'
import { Field } from '../components/Field.js'

/**
 * Konto: Airlock kennt genau eine Person (SPEC). Hier stehen Name,
 * Sitzung und Passwort; das Passwort lässt sich ändern.
 */
export function Account() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: api.listTokens })
  const location = useLocation()
  const formRef = useRef<HTMLFormElement>(null)

  // «Passwort ändern» im Profil-Menü springt hierher und setzt den Fokus.
  useEffect(() => {
    if (location.hash === '#passwort') {
      formRef.current?.scrollIntoView({ block: 'start' })
      formRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    }
  }, [location.hash, me.isSuccess])

  const m = me.data
  const activeTokens = (tokens.data?.tokens ?? []).filter((t) => !t.revokedAt).length

  return (
    <section className="page page-narrow">
      <PageHead crumbs={[{ label: 'Konto' }]} title="Konto" />

      <div className="panel panel-pad">
        <dl className="facts">
          <dt>Name</dt>
          <dd>{m?.name ?? <Sk w={80} h={12} className="sk-inline" />} <span className="muted">· Administrator</span></dd>
          <dt>Anmeldung</dt>
          <dd>Passwort, Sitzung im Browser{m?.viaHttps ? ' über HTTPS' : ' über HTTP (ohne TLS)'}</dd>
          <dt>Sitzung</dt>
          <dd>{m?.sessionSince ? <>angemeldet {relativeTime(m.sessionSince)} <span className="muted">({fmtDateTime(m.sessionSince)})</span>, gilt 7 Tage</> : '–'}</dd>
          <dt>Passwort</dt>
          <dd>
            {m?.passwordChangedAt
              ? <>{m.passwordSource === 'ui' ? 'hier geändert' : 'aus der Konfiguration (.env)'} {relativeTime(m.passwordChangedAt)}</>
              : 'aus der Konfiguration (.env)'}
          </dd>
          <dt>API-Tokens</dt>
          <dd>{tokens.data ? `${activeTokens} gültig` : tokens.isError ? 'nicht abrufbar' : <Sk w={56} h={12} className="sk-inline" />} · <Link to="/tokens">verwalten</Link></dd>
        </dl>
        <p className="hint" style={{ marginTop: 14 }}>
          Name im Profil: <code>ADMIN_NAME</code> in <code>.env</code>.
        </p>
      </div>

      <PasswordForm formRef={formRef} />
    </section>
  )
}

function PasswordForm({ formRef }: { formRef: React.RefObject<HTMLFormElement | null> }) {
  const qc = useQueryClient()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [done, setDone] = useState(false)
  const form = useFormErrors({ schema: passwordChangeFormSchema, values: () => ({ current, next, repeat }) })

  const change = useMutation({
    // Das Formular zeigt den Fehler selbst (falsches Passwort am Feld)
    meta: { quiet: true },
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setCurrent('')
      setNext('')
      setRepeat('')
      setDone(true)
      form.reset()
      void qc.invalidateQueries({ queryKey: ['me'] })
    },
    onError: (err) => {
      // «Bisheriges Passwort stimmt nicht» gehört ans erste Feld
      if (err instanceof ApiError && err.code === 'invalid_credentials') {
        form.setErrors({ current: 'Das bisherige Passwort stimmt nicht. Prüfe die Eingabe (Gross-/Kleinschreibung).' })
        requestAnimationFrame(() => document.getElementById(form.idFor('current'))?.focus())
      } else form.setServerErrors(err)
    },
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setDone(false)
    if (form.validateAll()) change.mutate()
  }

  const ref = (el: HTMLFormElement | null) => {
    form.formRef.current = el
    formRef.current = el
  }

  return (
    <form ref={ref} id="passwort" className="panel panel-pad section form-panel" onSubmit={submit} noValidate>
      <h2>Passwort ändern</h2>
      <p className="hint">Danach sind alle anderen Sitzungen abgemeldet. Diese bleibt angemeldet.</p>

      <Field id={form.idFor('current')} label="Bisheriges Passwort" error={form.errors.current}>
        <input {...form.field('current')} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field id={form.idFor('next')} label="Neues Passwort" error={form.errors.next} hint={`Mindestens ${PASSWORD_MIN} Zeichen – ein Satz aus vier Wörtern ist leicht zu merken.`}>
        <input {...form.field('next', `${form.idFor('next')}-hint`)} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field id={form.idFor('repeat')} label="Neues Passwort wiederholen" error={form.errors.repeat}>
        <input {...form.field('repeat')} type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
      </Field>

      {change.isError && !Object.keys(form.errors).length && <p role="alert" className="error">{change.error instanceof ApiError ? change.error.message : 'Nicht geändert'}</p>}
      {done && <p role="status" className="hint ok">✓ Passwort geändert. Andere Sitzungen sind abgemeldet.</p>}

      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={change.isPending} aria-busy={change.isPending || undefined}>
          Passwort ändern
        </button>
      </div>
      <p className="hint">
        Vergessen? <code>ADMIN_PASSWORD</code> in <code>.env</code> ändern und Airlock neu starten – ein geändertes
        Passwort in <code>.env</code> setzt sich beim Start durch.
      </p>
    </form>
  )
}

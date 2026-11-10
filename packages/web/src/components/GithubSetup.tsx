import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { githubManifestRequestSchema } from '@airlock/shared'
import { api, ApiError } from '../api.js'
import { ErrorState, Loading, SkCard } from './States.js'
import { useFormErrors } from '../lib/form.js'
import { relativeTime } from '../lib/format.js'
import { Field } from './Field.js'
import { IconWarn } from './Security.js'

/**
 * M8, Etappe 3: GitHub App über ein Manifest. Drei Schritte, alle per Klick:
 * App anlegen (Formular geht an GitHub), App installieren (Repos wählen),
 * fertig. Die Rückleitungen landen wieder hier (?ok=… bzw. ?fehler=… als
 * feste Codes, nie Freitext aus der URL).
 */

const PERM_LABEL: Record<string, string> = { contents: 'Inhalte (Contents)', pull_requests: 'Pull Requests', metadata: 'Metadaten (Metadata)' }
const permText = (v: string) => (v.startsWith('write') ? 'lesen und schreiben' : v.startsWith('read') ? `nur lesen${v.includes('immer') ? ', von GitHub immer dabei' : ''}` : v)

const OK_TEXT: Record<string, string> = {
  angelegt: 'App angelegt. Jetzt installieren und die Repos wählen.',
  installiert: 'App installiert; die freigegebenen Repos stehen unten.',
  aktualisiert: 'Repo-Auswahl übernommen.',
}
const ERR_TEXT: Record<string, string> = {
  state: 'Die Rückleitung passt nicht zu einem eben gestarteten Anlegen (älter als eine Stunde oder schon benutzt). Bitte neu starten.',
  vorhanden: 'Es gibt schon eine GitHub App. Zuerst die Verbindung trennen.',
  github: 'GitHub hat die Anfrage abgelehnt. Einzelheiten stehen im Log von Airlock.',
  unbekannt: 'Der Schritt wurde nicht abgeschlossen. Einzelheiten stehen im Log von Airlock.',
}

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)

export function GithubSetup() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['github'], queryFn: api.github })
  const [params, setParams] = useSearchParams()
  const [name, setName] = useState('')
  const [org, setOrg] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [notice, setNotice] = useState('')
  const disconnectRef = useRef<HTMLButtonElement>(null)
  const step1Ref = useRef<HTMLHeadingElement>(null)
  const okCode = params.get('ok')
  const errCode = params.get('fehler')
  const ok = okCode ? OK_TEXT[okCode] ?? null : null
  const err = errCode ? ERR_TEXT[errCode] ?? ERR_TEXT.unbekannt : null

  useEffect(() => {
    if (q.data && !name) setName(q.data.suggestedName)
  }, [q.data, name])

  const v = useFormErrors({ schema: githubManifestRequestSchema, values: () => ({ name, org }), idFor: (n) => `gh-${n}` })

  // Formular an GitHub: ein echtes POST des Browsers (GitHub verlangt das Manifest als Formularfeld)
  const start = useMutation({
    mutationFn: () => api.githubManifest(name.trim(), org.trim() || undefined),
    onSuccess: (r) => {
      const form = document.createElement('form')
      form.method = 'post'
      form.action = r.action
      const input = document.createElement('input')
      input.type = 'hidden'
      input.name = 'manifest'
      input.value = r.manifest
      form.appendChild(input)
      document.body.appendChild(form)
      form.submit()
    },
    onError: (e) => void v.setServerErrors(e),
  })
  const refresh = useMutation({
    mutationFn: api.githubRefresh,
    onSuccess: (r) => {
      setNotice(`Repos neu geladen: ${r.repos.length}.`)
      void qc.invalidateQueries({ queryKey: ['github'] })
    },
  })
  const disconnect = useMutation({
    mutationFn: api.githubDisconnect,
    onSuccess: () => {
      setConfirmDisconnect(false)
      setNotice('Verbindung getrennt. Die App bei GitHub kannst du jetzt löschen.')
      void qc.invalidateQueries({ queryKey: ['github'] }).then(() => step1Ref.current?.focus())
    },
  })

  if (!q.data && q.isError) return <ErrorState what="Der GitHub-Status" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
  if (!q.data) return <Loading label="GitHub-Status wird geladen"><SkCard lines={4} /></Loading>
  const s = q.data
  const closeBanner = () => {
    params.delete('ok')
    params.delete('fehler')
    setParams(params, { replace: true })
  }

  return (
    <>
      <p className="lede lede-tight">
        Mit einer eigenen GitHub App legt Airlock Fixes zu Befunden als Pull Request an – auf einem eigenen Branch, nie direkt auf dem Standard-Branch –
        und kann nach dem Merge selbst deployen (pro Projekt unter Einstellungen einschalten). Kein Webhook: Airlock bleibt intern und fragt alle 5 Minuten nach.
      </p>

      {ok && <div role="status" className="banner banner-info"><strong>Erledigt.</strong> {ok} <button type="button" className="link-button" onClick={closeBanner}>Ausblenden</button></div>}
      {err && <div role="alert" className="banner banner-warn"><strong>Nicht geklappt.</strong> {err} <button type="button" className="link-button" onClick={closeBanner}>Ausblenden</button></div>}
      <div role="status" aria-live="polite" className="fix-live">{notice && <p className="fix-notice">{notice}</p>}</div>

      <ol className="gh-steps">
        <li className={s.connected ? 'gh-step gh-step-done' : 'gh-step'}>
          <h2 ref={step1Ref} tabIndex={-1}>1. App anlegen <span className="gh-step-state">{s.connected ? '– erledigt' : '– offen'}</span></h2>
          {s.connected && s.app ? (
            <p>
              <a href={s.app.htmlUrl} target="_blank" rel="noreferrer">{s.app.name}<span className="visually-hidden"> (öffnet neues Fenster)</span></a>
              {s.app.owner && <> · Konto {s.app.owner}</>} · angelegt {relativeTime(s.app.createdAt)}
            </p>
          ) : (
            <form
              className="form"
              noValidate
              ref={v.formRef}
              onSubmit={(e) => {
                e.preventDefault()
                if (v.validateAll()) start.mutate()
              }}
            >
              <p id="gh-perms-title">Diese Rechte bekommt die App, nur für die Repos, die du bei der Installation wählst:</p>
              <dl className="gh-perms" aria-labelledby="gh-perms-title">
                {Object.entries(s.permissions).map(([k, val]) => (
                  <div key={k}><dt>{PERM_LABEL[k] ?? k}</dt><dd>{permText(val)}</dd></div>
                ))}
              </dl>
              <Field id={v.idFor('name')} label="Name der App" error={v.errors.name} hint="Muss bei GitHub einmalig sein; die Ziffern am Ende helfen dabei.">
                <input {...v.field('name', `${v.idFor('name')}-hint`)} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} />
              </Field>
              <Field id={v.idFor('org')} label="Organisation" optional error={v.errors.org} hint="Leer: die App gehört deinem eigenen GitHub-Konto.">
                <input {...v.field('org', `${v.idFor('org')}-hint`)} value={org} onChange={(e) => setOrg(e.target.value)} autoComplete="off" spellCheck={false} />
              </Field>
              <p className="hint">
                Du wechselst zu GitHub und bestätigst dort mit «Create GitHub App». GitHub schickt dich danach hierher zurück
                (<code>{s.callbackUrl}</code>); Airlock speichert den Schlüssel der App verschlüsselt.
              </p>
              <div className="form-actions">
                <button type="submit" className="button-primary" disabled={start.isPending}>
                  {start.isPending ? 'Wird vorbereitet …' : 'Weiter zu GitHub'}
                  <span className="visually-hidden"> (wechselt zu GitHub und legt die App an)</span>
                </button>
              </div>
              {start.isError && !v.errors.name && !v.errors.org && <p role="alert" className="error">{errText(start.error, 'Nicht gestartet')}</p>}
            </form>
          )}
        </li>

        <li className={s.installed ? 'gh-step gh-step-done' : 'gh-step'}>
          <h2>2. App installieren <span className="gh-step-state">{s.installed ? '– erledigt' : s.connected ? '– offen' : '– nach Schritt 1'}</span></h2>
          {!s.connected && <p className="muted">Zuerst die App anlegen.</p>}
          {s.connected && s.installUrl && (
            <>
              <p>Bei GitHub «Only select repositories» wählen und die Repos der Projekte anhaken. Danach leitet GitHub hierher zurück.</p>
              <div className="form-actions">
                <a className={s.installed ? 'button' : 'button button-primary'} href={s.installUrl}>{s.installed ? 'Repo-Auswahl ändern' : 'App installieren'}<span className="visually-hidden"> (wechselt zu GitHub)</span></a>
              </div>
            </>
          )}
          {s.connected && !s.installUrl && <p className="muted">Der Link zum Installieren fehlt. Verbindung trennen und die App neu anlegen.</p>}
        </li>

        <li className="gh-step">
          <h2>3. Repos <span className="gh-step-state">{s.installed ? `– ${s.repos.length}` : ''}</span></h2>
          {!s.installed ? <p className="muted">Erscheinen nach der Installation.</p> : (
            <>
              {s.repos.length === 0 ? <p className="muted">Keine Repos freigegeben.</p> : (
                <ul className="gh-repos">{s.repos.map((r) => <li key={r}><code>{r}</code></li>)}</ul>
              )}
              <p className="hint">Projekte aus diesen Repos bekommen Fixes als Pull Request; Auto-Deploy schaltest du am Projekt unter «Einstellungen» ein.</p>
              <div className="form-actions">
                <button type="button" className="button-small" aria-disabled={refresh.isPending || undefined} onClick={() => !refresh.isPending && refresh.mutate()}>
                  {refresh.isPending ? 'Lädt …' : 'Repos neu laden'}
                </button>
              </div>
              {refresh.isError && <p role="alert" className="error">{errText(refresh.error, 'Repos nicht geladen')}</p>}
            </>
          )}
        </li>
      </ol>

      {s.connected && (
        <div className="danger-zone">
          <h2>Verbindung trennen</h2>
          <p>Löscht Schlüssel und Secrets der App in Airlock. Die App selbst entfernst du danach bei GitHub (Settings → Developer settings → GitHub Apps).</p>
          {!confirmDisconnect ? (
            <button ref={disconnectRef} type="button" className="button-danger" onClick={() => setConfirmDisconnect(true)}>Verbindung trennen</button>
          ) : (
            <span className="confirm-inline" role="group" aria-label="Verbindung trennen bestätigen">
              <span className="confirm-note"><IconWarn />Offene Pull Requests bleiben bei GitHub, Airlock verfolgt sie nicht mehr.</span>
              <button type="button" onClick={() => { setConfirmDisconnect(false); requestAnimationFrame(() => disconnectRef.current?.focus()) }} autoFocus>Abbrechen</button>
              <button type="button" className="button-danger-solid" aria-disabled={disconnect.isPending || undefined} onClick={() => !disconnect.isPending && disconnect.mutate()}>
                {disconnect.isPending ? 'Wird getrennt …' : 'Ja, trennen'}
              </button>
            </span>
          )}
          {disconnect.isError && <p role="alert" className="error">{errText(disconnect.error, 'Nicht getrennt')}</p>}
        </div>
      )}
    </>
  )
}

/** Am Projekt (Einstellungen): Auto-Deploy nach Merge. Nur bei Git-Quellen. */
export function AutoDeploySetting({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['auto-deploy', projectId], queryFn: () => api.autoDeploy(projectId) })
  const set = useMutation({
    mutationFn: (enabled: boolean) => api.setAutoDeploy(projectId, enabled),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['auto-deploy', projectId] }),
  })
  if (q.isError) return <p className="state state-error" role="alert">Einstellung «Automatisch deployen» nicht abrufbar.</p>
  const d = q.data
  if (!d?.available) return null
  const on = set.isPending ? Boolean(set.variables) : d.autoDeploy
  return (
    <fieldset className="field-group">
      <legend>Automatisch deployen</legend>
      <label className="choice">
        {/* Während des Speicherns nicht disabled: sonst verliert die Checkbox den Fokus */}
        <input type="checkbox" checked={on} aria-disabled={set.isPending || undefined} onChange={(e) => !set.isPending && set.mutate(e.target.checked)} />
        <span>
          Nach einem Merge neu deployen{' '}
          <small>
            Airlock prüft alle 5 Minuten, ob der Deploy-Branch einen neuen Commit hat{d.viaGithubApp ? ' (über die GitHub App)' : ' (öffentliches Repo, ohne Anmeldung)'}; der Scan danach bestätigt Fixes.
            {d.autoDeploy && d.checkedAt && <> Zuletzt geprüft {relativeTime(d.checkedAt).replace(/\.$/, '')}.</>}
          </small>
        </span>
      </label>
      <p className="hint" role="status">{on ? 'Auto-Deploy ist an.' : 'Auto-Deploy ist aus.'}</p>
      {set.isError && <p role="alert" className="error">{errText(set.error, 'Nicht gespeichert')}</p>}
    </fieldset>
  )
}

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom'
import { api, ApiError, subscribeLogs, type ProjectDto } from '../api.js'
import { StatusBadge, relativeTime, duration } from '../components/Status.js'
import { DeployProgress } from '../components/DeployProgress.js'
import { EnvEditor, type EnvRow } from '../components/EnvEditor.js'
import { ProjectSecurity } from '../components/Security.js'
import { Reachability } from '../components/Reachability.js'
import { PageHead } from '../components/PageHead.js'
import { useFormErrors } from '../lib/form.js'
import { Field } from '../components/Field.js'
import { putEnvSchema } from '@deployer/shared'
import { KIND_LABEL, shortVersion } from '../lib/format.js'
import { runtimeStatus, isPublic } from '../lib/projects.js'

type Tab = 'uebersicht' | 'deployments' | 'logs' | 'security' | 'einstellungen'

export function ProjectDetail() {
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const TABS: Tab[] = ['uebersicht', 'deployments', 'logs', 'security', 'einstellungen']
  const fromUrl = params.get('tab') as Tab | null
  const tab: Tab = fromUrl && TABS.includes(fromUrl) ? fromUrl : 'uebersicht'
  // Der Reiter steht in der Adresse: Links aus der Übersicht («Log ansehen»)
  // landen direkt richtig, und Zurück im Browser wechselt den Reiter.
  const setTab = (t: Tab) => setParams(t === 'uebersicht' ? {} : { tab: t }, { replace: false })
  const [watching, setWatching] = useState<string | null>(null)
  const [confirmStop, setConfirmStop] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const q = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.getProject(id),
    refetchInterval: watching ? false : 5_000,
  })

  const act = useMutation({
    mutationFn: async (what: 'deploy' | 'start' | 'stop') => {
      if (what === 'deploy') return api.deploy(id)
      if (what === 'start') return api.start(id)
      return api.stop(id)
    },
    onSuccess: (res, what) => {
      const dep = (res as { deployment?: { id: string } } | undefined)?.deployment
      setConfirmStop(false)
      setNotice(what === 'stop' ? 'Gestoppt. Die Adresse antwortet nicht mehr, bis du das Projekt wieder startest.' : what === 'start' && !dep ? 'Gestartet.' : null)
      if (dep) {
        setWatching(dep.id)
        setTab('uebersicht')
      }
      void qc.invalidateQueries({ queryKey: ['project', id] })
    },
  })

  const keep = useMutation({
    mutationFn: (value: boolean) => api.updateProject(id, { keep: value }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['project', id] }),
  })

  if (q.isLoading) return <section className="page"><PageHead crumbs={[{ label: 'projekte', to: '/projekte' }, { label: '…' }]} title="Projekt" /><p className="state state-loading">Wird geladen…</p></section>
  if (q.isError) {
    return (
      <section className="page">
        <PageHead crumbs={[{ label: 'projekte', to: '/projekte' }]} title="Projekt nicht gefunden" />
        <div className="state state-empty">
          <p>Vielleicht wurde es gelöscht, oder die Adresse ist veraltet.</p>
          <Link className="button" to="/projekte">Zu den Projekten</Link>
        </div>
      </section>
    )
  }

  const p = q.data!.project
  const env = q.data!.env
  const url = p.routes.find((r) => r.target !== 'public')?.urls[0] ?? p.routes[0]?.urls[0]
  const rt = runtimeStatus(p)

  return (
    <section className="page page-project">
      <PageHead
        crumbs={[{ label: 'projekte', to: '/projekte' }, { label: p.slug }]}
        title={<><h1>{p.name}</h1><StatusBadge status={rt.status} />{rt.deployFailed && <span className="deploy-failed">✕ letzter Deploy fehlgeschlagen</span>}</>}
        actions={
          <>
            {url && <a className="button button-ghost" href={url} target="_blank" rel="noreferrer">Öffnen ↗</a>}
            {p.desiredState === 'running' ? (
              confirmStop ? (
                <span className="confirm-inline" role="group" aria-label="Stoppen bestätigen">
                  <span className="warn">! {isPublic(p) ? 'Öffentlich erreichbar – ' : ''}danach offline.</span>
                  <button className="button-danger" onClick={() => act.mutate('stop')} disabled={act.isPending} autoFocus>Ja, stoppen</button>
                  <button onClick={() => setConfirmStop(false)}>Abbrechen</button>
                </span>
              ) : (
                <button onClick={() => setConfirmStop(true)} disabled={act.isPending}>Stoppen …</button>
              )
            ) : (
              <button onClick={() => act.mutate('start')} disabled={act.isPending}>Starten</button>
            )}
            <button className="button-primary" onClick={() => act.mutate('deploy')} disabled={act.isPending || p.status === 'deploying'}>
              Neu deployen
            </button>
          </>
        }
      >
        <p className="lede mono">{KIND_LABEL[p.sourceType] ?? p.sourceType} · {shortVersion(p.activeDeployment?.version)}{p.activeDeployment ? '' : ' · noch nichts aktiv'}</p>
      </PageHead>

      {notice && <p role="status" className="notice notice-ok">{notice}</p>}
      {act.isError && (
        <p role="alert" className="error">
          {act.error instanceof ApiError && act.error.status === 409
            ? 'Für dieses Projekt läuft bereits ein Deploy.'
            : (act.error as Error).message}
        </p>
      )}

      <nav
        className="tabs"
        role="tablist"
        aria-label="Bereiche des Projekts"
        onKeyDown={(e) => {
          // Pfeiltasten wechseln den Reiter (Tablist-Muster)
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
          const i = TABS.indexOf(tab)
          const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!
          setTab(next)
          requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus())
        }}
      >
        {([
          ['uebersicht', 'Übersicht'],
          ['deployments', 'Deployments'],
          ['logs', 'Logs'],
          ['security', 'Security'],
          ['einstellungen', 'Einstellungen'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            id={`tab-${key}`}
            aria-selected={tab === key}
            aria-controls="tab-panel"
            tabIndex={tab === key ? 0 : -1}
            className={tab === key ? 'tab tab-active' : 'tab'}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div id="tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>

      {tab === 'uebersicht' && (
        <div className="tab-panel">
          {watching && (
            <DeployProgress
              deploymentId={watching}
              onFinished={() => {
                setWatching(null)
                void qc.invalidateQueries({ queryKey: ['project', id] })
              }}
            />
          )}

          <div className="panel panel-pad">
          <dl className="facts">
            <dt>Adressen</dt>
            <dd>
              {p.routes.length === 0 ? (
                <span className="muted">keine</span>
              ) : (
                <ul className="url-list">
                  {p.routes.flatMap((r) => r.urls).map((u) => (
                    <li key={u}><a href={u} target="_blank" rel="noreferrer">{u}</a></li>
                  ))}
                </ul>
              )}
            </dd>

            <dt>Erreichbar</dt>
            <dd>
              {p.routes.length === 0 ? <span className="muted">nirgends – unter Einstellungen festlegen</span> : (
                <div className="chips">
                  {isPublic(p) && <span className="chip chip-public">Öffentlich</span>}
                  {p.routes.some((r) => (r.targets ?? [r.target]).includes('lan')) && <span className="chip">LAN</span>}
                  {p.routes.some((r) => (r.targets ?? [r.target]).includes('tailnet')) && <span className="chip">Tailnet</span>}
                </div>
              )}
            </dd>

            <dt>Security</dt>
            <dd>
              {p.security?.grade ? (
                <button className="link-button grade-link" onClick={() => setTab('security')}>
                  <span className={`grade grade-${p.security.grade}`}>{p.security.grade}</span>
                  {' '}{p.security.score} / 100 · {p.security.open.critical} kritisch, {p.security.open.high} hoch
                </button>
              ) : <span className="muted">{p.security?.status === 'running' || p.security?.status === 'queued' ? 'Scan läuft' : 'noch kein Scan'}</span>}
            </dd>

            <dt>Quelle</dt>
            <dd><SourceLine p={p} /></dd>

            {p.sourceType === 'files' && (
              <>
                <dt>Ablauf</dt>
                <dd>
                  {p.expiresAt
                    ? <>wird am {new Date(p.expiresAt).toLocaleDateString('de-CH')} gestoppt, wenn sich bis dahin nichts ändert{' '}</>
                    : <>läuft nicht ab{' '}</>}
                  <button onClick={() => keep.mutate(!p.keep)} disabled={keep.isPending}>
                    {p.keep ? 'Ablauf wieder einschalten' : 'Behalten'}
                  </button>
                </dd>
              </>
            )}

            <dt>Aktive Fassung</dt>
            <dd>
              {p.activeDeployment
                ? <><code className="version" title={p.activeDeployment.version ?? undefined}>{shortVersion(p.activeDeployment.version)}</code>{' '}
                   <span className="muted">({relativeTime(p.activeDeployment.startedAt)})</span></>
                : <span className="muted">keine</span>}
            </dd>

            <dt>Grenzen</dt>
            <dd>{p.cpuLimit} CPU, {p.memoryLimitMb} MB</dd>

            {p.runsAsRoot && (
              <>
                <dt>Hinweis</dt>
                <dd className="warn">Der Container läuft als root. Erlaubt, aber vermeidbar.</dd>
              </>
            )}
          </dl>
          </div>
        </div>
      )}

      {tab === 'deployments' && (
        <Deployments
          projectId={id}
          onRollback={(depId) => {
            setWatching(depId)
            setTab('uebersicht')
          }}
        />
      )}
      {tab === 'logs' && <LiveLogs projectId={id} />}
      {tab === 'security' && <ProjectSecurity projectId={p.id} />}
      {tab === 'einstellungen' && <Reachability p={p} />}
      {tab === 'einstellungen' && (
        <Settings
          projectId={id}
          slug={p.slug}
          env={env}
          onDeleted={() => navigate('/projekte')}
        />
      )}
      </div>
    </section>
  )
}

const FILES_KIND: Record<string, string> = {
  compose: 'Docker Compose',
  dockerfile: 'Dockerfile',
  'static-build': 'statische Seite mit Build',
  static: 'statische Seite',
}

function SourceLine({ p }: { p: ProjectDto }) {
  const s = (p.source ?? {}) as Record<string, string | undefined>
  switch (p.sourceType) {
    case 'image':
      return <code>{s.image ?? '–'}</code>
    case 'dockerfile':
      return <>Dockerfile aus <code>{s.repoUrl}</code>{s.ref ? <> ({s.ref})</> : null}</>
    case 'compose':
      return s.repoUrl
        ? <>Compose aus <code>{s.repoUrl}</code>, Web-Dienst <code>{s.webService}</code></>
        : <>hochgeladene compose.yaml, Web-Dienst <code>{s.webService}</code></>
    case 'static':
      return s.repoUrl
        ? <>statische Seite aus <code>{s.repoUrl}</code>{s.buildCommand ? <>, Build <code>{s.buildCommand}</code></> : null}</>
        : <>statische Seite (ZIP)</>
    case 'files':
      return <>Chat-Projekt{p.filesKind ? <>, erkannt als {FILES_KIND[p.filesKind]}</> : null}</>
    default:
      return <>{p.sourceType}</>
  }
}

/* --- Deployments ----------------------------------------------------------- */

const DEPLOY_STATUS: Record<string, string> = {
  pending: 'wartet',
  pulling: 'holt Quelle',
  starting: 'startet',
  healthchecking: 'Healthcheck',
  active: 'aktiv',
  superseded: 'abgelöst',
  failed: 'fehlgeschlagen',
  rolled_back: 'zurückgerollt',
}

function Deployments({ projectId, onRollback }: { projectId: string; onRollback: (deploymentId: string) => void }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const list = useQuery({ queryKey: ['deployments', projectId], queryFn: () => api.listDeployments(projectId) })
  const detail = useQuery({
    queryKey: ['deployment', open],
    queryFn: () => api.getDeployment(open!),
    enabled: open !== null,
  })
  const rollback = useMutation({
    mutationFn: (deploymentId: string) => api.rollback(projectId, deploymentId),
    onSuccess: (r) => {
      setConfirming(null)
      void qc.invalidateQueries({ queryKey: ['deployments', projectId] })
      onRollback(r.deployment.id)
    },
  })

  if (list.isLoading) return <p className="state state-loading">Wird geladen…</p>
  const rows = list.data?.deployments ?? []
  if (rows.length === 0) return <p className="state state-empty">Noch kein Deployment.</p>

  return (
    <div className="tab-panel">
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr><th>Start</th><th>Version</th><th>Dauer</th><th>Ergebnis</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className={d.status === 'failed' ? 'row-error' : undefined}>
                <td>
                  {new Date(d.startedAt).toLocaleString('de-CH')}
                  {d.trigger === 'rollback' && <span className="muted"> · Rollback</span>}
                </td>
                <td><code className="version" title={d.version ?? undefined}>{shortVersion(d.version)}</code></td>
                <td>{duration(d.durationMs)}</td>
                <td>{DEPLOY_STATUS[d.status] ?? d.status}</td>
                <td className="row-actions">
                  <button onClick={() => setOpen(open === d.id ? null : d.id)}>
                    {open === d.id ? 'Log schliessen' : 'Log'}
                  </button>
                  {d.canRollback && confirming !== d.id && (
                    <button onClick={() => setConfirming(d.id)}>Zurückrollen</button>
                  )}
                  {confirming === d.id && (
                    <>
                      <button
                        className="button-primary"
                        disabled={rollback.isPending}
                        onClick={() => rollback.mutate(d.id)}
                      >
                        {rollback.isPending ? 'Startet…' : 'Ja, diese Fassung'}
                      </button>
                      <button onClick={() => setConfirming(null)}>Abbrechen</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rollback.isError && (
        <p role="alert" className="error">
          {rollback.error instanceof ApiError && rollback.error.status === 409
            ? 'Für dieses Projekt läuft bereits ein Deploy.'
            : (rollback.error as Error).message}
        </p>
      )}
      <p className="hint">
        Ein Rollback startet die frühere Fassung mit den heutigen Umgebungsvariablen.
        Aufbewahrt werden die letzten fünf erfolgreichen Fassungen.
      </p>

      {open && (
        <pre className="log" aria-label="Deployment-Log">
          {detail.isLoading ? 'Log wird geladen…' : detail.data?.log || 'Kein Log vorhanden.'}
        </pre>
      )}
    </div>
  )
}

/* --- Live-Logs --------------------------------------------------------------- */

function LiveLogs({ projectId }: { projectId: string }) {
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLPreElement>(null)

  useEffect(() => {
    setLines([])
    setError(null)
    void api
      .getLogs(projectId, 200)
      .then((r) => setLines(r.logs ? r.logs.split('\n') : r.hint ? [r.hint] : []))
      .catch((e: Error) => setError(e.message))
    return subscribeLogs(projectId, (line) => setLines((l) => [...l.slice(-1000), line]))
  }, [projectId])

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [lines])

  if (error) return <p className="state state-error" role="alert">{error}</p>

  return (
    <div className="tab-panel">
      <pre className="log log-tall" ref={ref} aria-label="Container-Log">
        {lines.join('\n') || 'Noch keine Ausgabe…'}
      </pre>
    </div>
  )
}

/* --- Einstellungen ----------------------------------------------------------- */

function Settings({
  projectId, slug, env, onDeleted,
}: {
  projectId: string
  slug: string
  env: { key: string; value: string | null; isSecret: boolean }[]
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const [rows, setRows] = useState<EnvRow[]>(
    env.map((e) => ({ key: e.key, value: e.value ?? '', isSecret: e.isSecret, stored: true })),
  )
  const [confirm, setConfirm] = useState('')
  const [purge, setPurge] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const entries = () => rows.map((r) => ({ key: r.key, value: r.value, isSecret: r.isSecret }))
  const envForm = useFormErrors({ schema: putEnvSchema, values: () => ({ entries: entries() }) })
  const save = useMutation({
    mutationFn: () => api.putEnv(projectId, entries()),
    onSuccess: () => {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      void qc.invalidateQueries({ queryKey: ['project', projectId] })
    },
    onError: (err) => void envForm.setServerErrors(err),
  })

  const remove = useMutation({
    mutationFn: () => api.deleteProject(projectId, purge),
    onSuccess: onDeleted,
  })

  return (
    <div className="tab-panel">
      <form noValidate ref={envForm.formRef} onSubmit={(ev) => { ev.preventDefault(); if (envForm.validateAll()) save.mutate() }}>
      <EnvEditor rows={rows} onChange={setRows} prefix="entries" errors={envForm.errors} field={envForm.field} />
      <div className="form-actions">
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Wird gespeichert…' : saved ? 'Gespeichert' : 'Variablen speichern'}
        </button>
        <span className="hint">Wirksam beim nächsten Deploy.</span>
      </div>
      </form>
      {save.isError && <p role="alert" className="error">{(save.error as Error).message}</p>}

      <section className="danger-zone">
        <h2>Projekt löschen</h2>
        <p>
          Entfernt Container, Netz, Route und Dateien. Lässt sich nicht rückgängig machen.
        </p>
        <form
          noValidate
          onSubmit={(ev) => {
            ev.preventDefault()
            if (confirm.trim() !== slug) {
              setConfirmError(confirm.trim() ? `Das ist nicht «${slug}». Tippe den Kurznamen genau so ein, um das Löschen zu bestätigen.` : `Tippe «${slug}» ein, um das Löschen zu bestätigen.`)
              requestAnimationFrame(() => document.getElementById('f-delete-confirm')?.focus())
              return
            }
            setConfirmError(null)
            remove.mutate()
          }}
        >
          <Field id="f-delete-confirm" label="Kurzname zur Bestätigung" error={confirmError ?? undefined}>
            <input
              id="f-delete-confirm"
              aria-invalid={confirmError ? true : undefined}
              aria-describedby={confirmError ? 'f-delete-confirm-error' : undefined}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onBlur={() => { if (confirmError && confirm.trim() === slug) setConfirmError(null) }}
              placeholder={slug}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <label className="choice">
            <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
            <span>
              Auch die Daten-Volumes löschen
              <small>Ohne Haken bleiben benannte Volumes (z.B. einer Datenbank) erhalten.</small>
            </span>
          </label>
          <button type="submit" className="button-danger" disabled={remove.isPending}>
            {remove.isPending ? 'Wird gelöscht…' : 'Endgültig löschen'}
          </button>
        </form>
        {remove.isError && <p role="alert" className="error">{(remove.error as Error).message}</p>}
      </section>
    </div>
  )
}

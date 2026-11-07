import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, subscribeLogs, type ProjectDto } from '../api.js'
import { StatusBadge, relativeTime, duration } from '../components/Status.js'
import { DeployProgress } from '../components/DeployProgress.js'
import { EnvEditor, type EnvRow } from '../components/EnvEditor.js'
import { ProjectSecurity } from '../components/Security.js'
import { Reachability } from '../components/Reachability.js'

type Tab = 'uebersicht' | 'deployments' | 'logs' | 'security' | 'einstellungen'

export function ProjectDetail() {
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('uebersicht')
  const [watching, setWatching] = useState<string | null>(null)

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
    onSuccess: (res) => {
      const dep = (res as { deployment?: { id: string } } | undefined)?.deployment
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

  if (q.isLoading) return <p className="state state-loading">Projekt wird geladen…</p>
  if (q.isError) return <p className="state state-error" role="alert">Projekt nicht gefunden.</p>

  const p = q.data!.project
  const env = q.data!.env

  return (
    <section className="page page-project">
      <header className="page-header">
        <div>
          <h1>{p.name}</h1>
          <StatusBadge status={p.status} />
        </div>
        <div className="project-actions">
          <button onClick={() => act.mutate('deploy')} disabled={act.isPending || p.status === 'deploying'}>
            Neu deployen
          </button>
          {p.desiredState === 'running' ? (
            <button onClick={() => act.mutate('stop')} disabled={act.isPending}>Stoppen</button>
          ) : (
            <button onClick={() => act.mutate('start')} disabled={act.isPending}>Starten</button>
          )}
        </div>
      </header>

      {act.isError && (
        <p role="alert" className="error">
          {act.error instanceof ApiError && act.error.status === 409
            ? 'Für dieses Projekt läuft bereits ein Deploy.'
            : (act.error as Error).message}
        </p>
      )}

      <nav className="tabs" role="tablist">
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
            aria-selected={tab === key}
            className={tab === key ? 'tab tab-active' : 'tab'}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

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
                ? <><code className="version">{p.activeDeployment.version ?? '–'}</code>{' '}
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
                <td><code className="version">{d.version ?? '–'}</code></td>
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
  const [saved, setSaved] = useState(false)

  const save = useMutation({
    mutationFn: () =>
      api.putEnv(projectId, rows.filter((r) => r.key).map((r) => ({ key: r.key, value: r.value, isSecret: r.isSecret }))),
    onSuccess: () => {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      void qc.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })

  const remove = useMutation({
    mutationFn: () => api.deleteProject(projectId, purge),
    onSuccess: onDeleted,
  })

  return (
    <div className="tab-panel">
      <EnvEditor rows={rows} onChange={setRows} />
      <div className="form-actions">
        <button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? 'Wird gespeichert…' : saved ? 'Gespeichert' : 'Variablen speichern'}
        </button>
        <span className="hint">Wirksam beim nächsten Deploy.</span>
      </div>
      {save.isError && <p role="alert" className="error">{(save.error as Error).message}</p>}

      <section className="danger-zone">
        <h2>Projekt löschen</h2>
        <p>
          Entfernt Container, Netz, Route und Dateien. Lässt sich nicht rückgängig machen.
          Tippe zur Bestätigung <code>{slug}</code> ein.
        </p>
        <input
          aria-label="Slug zur Bestätigung"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={slug}
        />
        <label className="choice">
          <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
          <span>
            Auch die Daten-Volumes löschen
            <small>Ohne Haken bleiben benannte Volumes (z.B. einer Datenbank) erhalten.</small>
          </span>
        </label>
        <button
          className="button-danger"
          disabled={confirm !== slug || remove.isPending}
          onClick={() => remove.mutate()}
        >
          {remove.isPending ? 'Wird gelöscht…' : 'Endgültig löschen'}
        </button>
        {remove.isError && <p role="alert" className="error">{(remove.error as Error).message}</p>}
      </section>
    </div>
  )
}

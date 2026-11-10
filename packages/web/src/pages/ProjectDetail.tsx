import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom'
import { api, ApiError, subscribeLogs, type ProjectDto } from '../api.js'
import { StatusBadge, relativeTime, duration } from '../components/Status.js'
import { DeployProgress } from '../components/DeployProgress.js'
import { EnvEditor, type EnvRow } from '../components/EnvEditor.js'
import { ProjectSecurity } from '../components/Security.js'
import { AutoDeploySetting } from '../components/GithubSetup.js'
import { Reachability } from '../components/Reachability.js'
import { Publication, PublicPillFor } from '../components/Publication.js'
import { ProjectOverview, useProjectHealth } from '../components/ProjectOverview.js'
import { PageHead } from '../components/PageHead.js'
import { IconWarn } from '../components/Icons.js'
import { useFormErrors } from '../lib/form.js'
import { Field } from '../components/Field.js'
import { putEnvSchema } from '@airlock/shared'
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
    mutationFn: async (what: 'deploy' | 'start' | 'stop' | 'recreate') => {
      if (what === 'deploy') return api.deploy(id)
      if (what === 'recreate') return api.recreate(id)
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

  const health = useProjectHealth(q.data?.project ?? ({ id, activeDeployment: null, desiredState: 'stopped' } as unknown as ProjectDto))
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
  const dbRt = runtimeStatus(p)
  // Der Container fehlt oder ist beendet, obwohl er laufen sollte: dann zählt das, nicht die Datenbank
  const down = Boolean(health.data?.container && !health.data.container.running)
  const rt = down && dbRt.status === 'running' ? { status: 'failed' as const, deployFailed: dbRt.deployFailed } : dbRt

  return (
    <section className="page page-project">
      <PageHead
        crumbs={[{ label: 'projekte', to: '/projekte' }, { label: p.slug }]}
        title={<><h1>{p.name}</h1><StatusBadge status={rt.status} /><PublicPillFor p={p} />{rt.deployFailed && rt.status !== 'failed' && <span className="deploy-failed">letzter Deploy fehlgeschlagen</span>}</>}
        actions={
          <>
            {url && rt.status === 'running' && <a className="button button-ghost" href={url} target="_blank" rel="noreferrer">Öffnen ↗</a>}
            {p.desiredState === 'running' ? (
              confirmStop ? (
                <span className="confirm-inline" role="group" aria-label="Stoppen bestätigen">
                  <span className="confirm-note"><IconWarn /> {isPublic(p) ? 'Öffentlich erreichbar – ' : ''}danach offline.</span>
                  <button onClick={() => setConfirmStop(false)}>Abbrechen</button>
                  {/* Während der Bestätigung ist «Ja, stoppen» der eine gefüllte Knopf */}
                  <button className="button-danger-solid" onClick={() => act.mutate('stop')} disabled={act.isPending} autoFocus>Ja, stoppen</button>
                </span>
              ) : (
                <button onClick={() => setConfirmStop(true)} disabled={act.isPending}>Stoppen …</button>
              )
            ) : (
              <button onClick={() => act.mutate('start')} disabled={act.isPending}>Starten</button>
            )}
            <button className={confirmStop ? undefined : 'button-primary'} onClick={() => act.mutate('deploy')} disabled={act.isPending || p.status === 'deploying'}>
              Neu deployen
            </button>
          </>
        }
      >
        <p className="lede">{KIND_LABEL[p.sourceType] ?? p.sourceType} · <span className="version">{shortVersion(p.activeDeployment?.version)}</span>{p.activeDeployment ? '' : ' · noch nichts aktiv'}</p>
      </PageHead>

      {notice && <p role="status" className="notice notice-ok">{notice}</p>}
      {p.legacyContainers && p.status !== 'deploying' && (
        <div className="notice notice-info legacy-notice" role="status">
          <span>
            <strong>Läuft noch mit Containern aus der deployer-Zeit.</strong>{' '}
            «Neu erstellen» legt dieselbe Fassung mit den Namen von Airlock neu an; Daten in Volumes werden übernommen.
            {p.runtimeKind === 'compose' ? ' Die Dienste sind dabei kurz offline.' : ''}
          </span>
          <button onClick={() => act.mutate('recreate')} disabled={act.isPending}>Neu erstellen</button>
        </div>
      )}
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

          <ProjectOverview
            p={p}
            env={env}
            onTab={setTab}
            onDeploy={() => act.mutate('deploy')}
            deploying={act.isPending || p.status === 'deploying'}
            onRollback={(depId) => setWatching(depId)}
            onToggleKeep={() => keep.mutate(!p.keep)}
          />
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
      {tab === 'security' && <ProjectSecurity projectId={p.id} sourceType={p.sourceType} />}
      {tab === 'einstellungen' && <Publication p={p} />}
      {tab === 'einstellungen' && <Reachability p={p} />}
      {tab === 'einstellungen' && <AutoDeploySetting projectId={p.id} />}
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
              <tr key={d.id}>
                <td>
                  {new Date(d.startedAt).toLocaleString('de-CH')}
                  {d.trigger === 'rollback' && <span className="muted"> · Rollback</span>}
                </td>
                <td><code className="version" title={d.version ?? undefined}>{shortVersion(d.version)}</code></td>
                <td>{duration(d.durationMs)}</td>
                <td>
                  {/* Ergebnis als Pille: Punkt + Wort, Farbe nur für aktiv und fehlgeschlagen */}
                  <span className={`status ${d.status === 'active' ? 'status-running' : d.status === 'failed' ? 'status-failed' : ['pending', 'pulling', 'starting', 'healthchecking'].includes(d.status) ? 'status-deploying' : 'status-stopped'}`}>
                    <span className="status-dot" aria-hidden="true" />{DEPLOY_STATUS[d.status] ?? d.status}
                  </span>
                </td>
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
          <button type="submit" className="button-danger-solid" disabled={remove.isPending}>
            {remove.isPending ? 'Wird gelöscht…' : 'Endgültig löschen'}
          </button>
        </form>
        {remove.isError && <p role="alert" className="error">{(remove.error as Error).message}</p>}
      </section>
    </div>
  )
}

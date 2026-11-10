import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom'
import { api, ApiError, subscribeLogs, type ProjectDto } from '../api.js'
import { StatusBadge } from '../components/Status.js'
import { DeployProgress } from '../components/DeployProgress.js'
import { ProjectSecurity } from '../components/Security.js'
import { PublicPillFor } from '../components/Publication.js'
import { ProjectSettings, useKeepToggle } from '../components/ProjectSettings.js'
import { notifyOk } from '../lib/feedback.js'
import { ProjectOverview, useProjectHealth } from '../components/ProjectOverview.js'
import { PageHead } from '../components/PageHead.js'
import { IconWarn } from '../components/Icons.js'
import { RowMenu } from '../components/RowMenu.js'
import { DeployList, useDeployments } from '../components/DeployList.js'
import { SiteAccess } from '../components/SiteAccess.js'
import { OfflineMenuItems, StopStartMenuItems, type MenuConfirm } from '../components/ProjectMenuItems.js'
import { KIND_LABEL, shortVersion } from '../lib/format.js'
import { runtimeStatus, isPublic } from '../lib/projects.js'
import { EmptyState, ErrorState, Loading, SkLog, SkProjectDetail, SkRows } from '../components/States.js'

const IconGear = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="8" r="2" />
    <path d="M6.9 1.8h2.2l.4 1.6 1.1.5 1.4-.9 1.6 1.6-.9 1.4.5 1.1 1.6.4v2.2l-1.6.4-.5 1.1.9 1.4-1.6 1.6-1.4-.9-1.1.5-.4 1.6H6.9l-.4-1.6-1.1-.5-1.4.9-1.6-1.6.9-1.4-.5-1.1-1.6-.4V6.9l1.6-.4.5-1.1-.9-1.4 1.6-1.6 1.4.9 1.1-.5Z" />
  </svg>
)

type Tab = 'uebersicht' | 'deployments' | 'logs' | 'security' | 'einstellungen'

export function ProjectDetail() {
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  // Reihenfolge nach Wichtigkeit; Einstellungen rechts abgesetzt
  const TABS: Tab[] = ['uebersicht', 'security', 'deployments', 'logs', 'einstellungen']
  const fromUrl = params.get('tab') as Tab | null
  const tab: Tab = fromUrl && TABS.includes(fromUrl) ? fromUrl : 'uebersicht'
  // Der Reiter steht in der Adresse: Links aus der Übersicht («Log ansehen»)
  // landen direkt richtig, und Zurück im Browser wechselt den Reiter.
  const setTab = (t: Tab) => setParams(t === 'uebersicht' ? {} : { tab: t }, { replace: false })
  const [watching, setWatching] = useState<string | null>(null)
  // «Löschen …» aus dem Menü: zur Rückfrage (Kurzname eintippen) in der Gefahrenzone der Einstellungen
  const [deleteRequested, setDeleteRequested] = useState(false)
  const goToDelete = () => {
    setTab('einstellungen')
    setDeleteRequested(true)
  }

  const q = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.getProject(id),
    refetchInterval: watching ? false : 5_000,
  })

  const act = useMutation({
    meta: { errorTitle: 'Aktion nicht ausgeführt' },
    mutationFn: async (what: HeadAction | 'recreate') => {
      if (what === 'deploy') return api.deploy(id)
      if (what === 'recreate') return api.recreate(id)
      if (what === 'restart') return api.restart(id)
      if (what === 'start') return api.start(id)
      return api.stop(id)
    },
    onSuccess: (res, what) => {
      const dep = (res as { deployment?: { id: string } } | undefined)?.deployment
      const name = q.data?.project.name ?? 'Projekt'
      // Ergebnis als Toast; Stoppen lässt sich mit Starten rückgängig machen
      if (what === 'stop') notifyOk(`«${name}» ist gestoppt`, { id: `act-${id}`, description: 'Die Adresse antwortet nicht mehr, bis du das Projekt wieder startest.', undo: () => act.mutate('start') })
      else if (what === 'restart' && !dep) notifyOk(`«${name}» ist neu gestartet`, { id: `act-${id}` })
      else if (what === 'start' && !dep) notifyOk(`«${name}» läuft wieder`, { id: `act-${id}` })
      if (dep) {
        setWatching(dep.id)
        setTab('uebersicht')
      }
      void qc.invalidateQueries({ queryKey: ['project', id] })
    },
  })

  const health = useProjectHealth(q.data?.project ?? ({ id, activeDeployment: null, desiredState: 'stopped' } as unknown as ProjectDto))
  // Zähler im Reiter «Deployments» (dieselbe Abfrage wie die Liste)
  const deployList = useDeployments(id)
  const keep = useKeepToggle({ id, name: q.data?.project.name ?? 'Projekt' })

  // Daten gehen vor: scheitert nur ein späteres Nachladen, bleibt die Seite stehen (Zustand «Veraltet»)
  if (!q.data && q.isError && !(q.error instanceof ApiError && q.error.status === 404)) {
    return (
      <section className="page">
        <PageHead crumbs={[{ label: 'projekte', to: '/projekte' }]} title="Projekt" />
        <ErrorState what="Das Projekt" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
      </section>
    )
  }
  if (!q.data && !q.isError) return <section className="page"><Loading label="Projekt wird geladen"><SkProjectDetail /></Loading></section>
  if (!q.data) {
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
  const isStatic = p.runtimeKind === 'static'
  const openFindings = p.security ? Object.values(p.security.open).reduce((a, b) => a + b, 0) : 0
  const deployCount = deployList.data?.deployments[0]?.seq ?? deployList.data?.deployments.length
  const tabInfo: Record<Tab, { label: string; count?: number; tone?: 'warn'; countLabel?: string; live?: boolean }> = {
    uebersicht: { label: 'Übersicht' },
    security: { label: 'Security', count: openFindings, tone: 'warn', countLabel: `${openFindings} offene Befunde` },
    deployments: { label: 'Deployments', count: deployCount, countLabel: `${deployCount} Deployments` },
    // Statische Seiten haben keinen Container: dort das Zugriffs-Log von Caddy
    logs: { label: isStatic ? 'Zugriffe' : 'Logs', live: !isStatic && Boolean(health.data?.container?.running) },
    einstellungen: { label: 'Einstellungen' },
  }

  return (
    <section className="page page-project">
      <PageHead
        crumbs={[{ label: 'projekte', to: '/projekte' }, { label: p.slug }]}
        title={<><h1>{p.name}</h1><StatusBadge status={rt.status} /><PublicPillFor p={p} />{rt.deployFailed && rt.status !== 'failed' && <span className="deploy-failed">letzter Deploy fehlgeschlagen</span>}</>}
        actions={
          <>
            {/* Sichtbar nur das Häufige; alles Weitere im «⋯»-Menü (Rückfragen dort, wie in der Projektkarte) */}
            {url && rt.status === 'running' && <a className="button" href={url} target="_blank" rel="noreferrer">Öffnen ↗</a>}
            <button className="button-primary" onClick={() => act.mutate('deploy')} disabled={act.isPending || p.status === 'deploying'}>
              Neu deployen
            </button>
            <ProjectHeadMenu p={p} busy={act.isPending} onAct={(w) => act.mutate(w)} onDelete={goToDelete} />
          </>
        }
      >
        <p className="lede">{KIND_LABEL[p.sourceType] ?? p.sourceType} · <span className="version">{shortVersion(p.activeDeployment?.version)}</span>{p.activeDeployment ? '' : ' · noch nichts aktiv'}</p>
      </PageHead>

      {p.legacyContainers && p.status !== 'deploying' && (
        <div className="notice notice-info legacy-notice" role="status">
          <span>
            <strong>Läuft noch mit Containern aus der deployer-Zeit.</strong>{' '}
            «Neu erstellen» legt dieselbe Fassung mit den Namen von Airlock neu an; Daten in Volumes werden übernommen.
            {p.runtimeKind === 'compose' ? ' Die Dienste sind dabei kurz offline.' : ''}
          </span>
          <button onClick={() => act.mutate('recreate')} disabled={act.isPending} aria-busy={(act.isPending && act.variables === 'recreate') || undefined}>Neu erstellen</button>
        </div>
      )}

      <nav
        className="tabs"
        role="tablist"
        aria-label="Bereiche des Projekts"
        onKeyDown={(e) => {
          // Pfeiltasten wechseln den Reiter (Tablist-Muster), Pos1/Ende springen
          const i = TABS.indexOf(tab)
          const next = e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length]
            : e.key === 'ArrowLeft' ? TABS[(i + TABS.length - 1) % TABS.length]
            : e.key === 'Home' ? TABS[0] : e.key === 'End' ? TABS.at(-1) : null
          if (!next) return
          e.preventDefault()
          setTab(next)
          requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus())
        }}
      >
        {TABS.map((key) => {
          const t = tabInfo[key]
          return (
            <button
              key={key}
              type="button"
              role="tab"
              id={`tab-${key}`}
              aria-selected={tab === key}
              aria-controls="tab-panel"
              tabIndex={tab === key ? 0 : -1}
              className={`tab${tab === key ? ' tab-active' : ''}${key === 'einstellungen' ? ' tab-end' : ''}`}
              onClick={() => setTab(key)}
            >
              {key === 'einstellungen' && <IconGear />}
              {t.label}
              {t.count !== undefined && t.count > 0 && <span className={`tab-count${t.tone ? ` tab-count-${t.tone}` : ''}`} aria-label={t.countLabel}>{t.count}</span>}
              {t.live && <span className="tab-live" role="img" aria-label="Container läuft" title="Container läuft" />}
            </button>
          )
        })}
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
            onToggleKeep={() => keep.mutate({ keep: !p.keep })}
            keepBusy={keep.isPending}
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
      {tab === 'logs' && (isStatic ? <SiteAccess projectId={id} /> : <LiveLogs projectId={id} />)}
      {tab === 'security' && <ProjectSecurity projectId={p.id} sourceType={p.sourceType} />}
      {tab === 'einstellungen' && (
        <ProjectSettings
          p={p}
          env={env}
          onDeleted={() => navigate('/projekte')}
          deleteRequested={deleteRequested}
          onDeleteShown={() => setDeleteRequested(false)}
          onManageHeaders={() => {
            setTab('security')
            // Zur Liste «Header über Caddy» (erscheint, sobald der Reiter geladen ist)
            const go = (tries: number) => {
              const el = document.getElementById('header-caddy')
              if (el) el.scrollIntoView({ block: 'start' })
              else if (tries > 0) setTimeout(() => go(tries - 1), 100)
            }
            go(20)
          }}
        />
      )}
      </div>
    </section>
  )
}

/* --- Kopf: «⋯»-Menü ------------------------------------------------------- */

type HeadAction = 'deploy' | 'start' | 'stop' | 'restart'

/**
 * «Weitere Aktionen» im Projektkopf: dieselbe Komponente und Animation wie
 * das «…»-Menü der Projektkarte (RowMenu), dieselben Einträge für Offline
 * und Stoppen (ProjectMenuItems). «Löschen …» führt zur Rückfrage mit
 * Kurzname in den Einstellungen.
 */
function ProjectHeadMenu({ p, busy, onAct, onDelete }: { p: ProjectDto; busy: boolean; onAct: (w: HeadAction) => void; onDelete: () => void }) {
  const [confirm, setConfirm] = useState<MenuConfirm>(null)
  // Statische Seiten haben keinen Container: nichts neu zu starten
  const restartable = p.desiredState === 'running' && p.runtimeKind !== 'static' && Boolean(p.activeDeployment)
  return (
    <RowMenu label="Weitere Aktionen">
      {(close) => (
        <>
          {restartable && (confirm === 'restart' ? (
            <>
              <div className="menu-confirm"><IconWarn /> {isPublic(p) ? 'Öffentlich erreichbar – ' : ''}kurz offline, dann dieselbe Fassung wieder.</div>
              <button role="menuitem" className="menu-danger-solid" disabled={busy} onClick={() => { close(); setConfirm(null); onAct('restart') }}>Ja, neu starten</button>
              <button role="menuitem" onClick={() => setConfirm(null)}>Abbrechen</button>
            </>
          ) : (
            <button role="menuitem" disabled={busy} onClick={() => setConfirm('restart')}>Neu starten …</button>
          ))}
          <StopStartMenuItems p={p} close={close} busy={busy} confirm={confirm} setConfirm={setConfirm} onStop={() => onAct('stop')} onStart={() => onAct('start')} />
          <OfflineMenuItems p={p} close={close} confirm={confirm} setConfirm={setConfirm} />
          <div className="menu-sep" />
          <button role="menuitem" className="menu-danger" onClick={() => { close(); setConfirm(null); onDelete() }}>Löschen …</button>
        </>
      )}
    </RowMenu>
  )
}

/* --- Deployments ----------------------------------------------------------- */

function Deployments({ projectId, onRollback }: { projectId: string; onRollback: (deploymentId: string) => void }) {
  const list = useDeployments(projectId)
  if (!list.data && list.isError) return <ErrorState plural what="Die Deployments" error={list.error} retrying={list.isFetching} onRetry={() => void list.refetch()} />
  if (!list.data) return <Loading label="Deployments werden geladen"><SkRows n={6} /></Loading>
  const rows = list.data.deployments
  if (rows.length === 0) {
    return (
      <EmptyState title="Noch kein Deployment">
        Das erste Deployment startet, sobald das Projekt angelegt ist; danach mit «Neu deployen» oben rechts.
      </EmptyState>
    )
  }

  return (
    <div className="tab-panel">
      <section className="panel panel-pad ov-section" aria-labelledby="dl-all">
        <div className="ov-head">
          <h2 className="ov-title" id="dl-all">Deployments</h2>
          <span className="muted num">{rows[0]?.seq ?? rows.length} insgesamt</span>
        </div>
        <DeployList projectId={projectId} rows={rows} withLog onRollback={onRollback} />
      </section>
      <p className="hint dl-hint">
        Ein Rollback startet die frühere Fassung mit den heutigen Umgebungsvariablen.
        Aufbewahrt werden die letzten fünf erfolgreichen Fassungen.
      </p>
    </div>
  )
}

/* --- Live-Logs --------------------------------------------------------------- */

function LiveLogs({ projectId }: { projectId: string }) {
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<unknown>(null)
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const ref = useRef<HTMLPreElement>(null)

  useEffect(() => {
    setLines([])
    setError(null)
    setLoaded(false)
    void api
      .getLogs(projectId, 200)
      .then((r) => { setLines(r.logs ? r.logs.split('\n') : r.hint ? [r.hint] : []); setLoaded(true) })
      .catch((e: unknown) => setError(e))
    return subscribeLogs(projectId, (line) => setLines((l) => [...l.slice(-1000), line]))
  }, [projectId, attempt])

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [lines])

  if (error) return <ErrorState what="Das Log" error={error} onRetry={() => setAttempt((n) => n + 1)} />
  if (!loaded && lines.length === 0) return <Loading label="Log wird geladen"><SkLog n={12} /></Loading>

  return (
    <div className="tab-panel">
      {lines.length === 0 ? (
        <EmptyState title="Noch keine Ausgabe">
          Neue Zeilen erscheinen hier live, sobald der Container etwas schreibt. Läuft er nicht, starte ihn über «⋯» oben rechts.
        </EmptyState>
      ) : (
        <pre className="log log-tall" ref={ref} aria-label="Container-Log">{lines.join('\n')}</pre>
      )}
    </div>
  )
}


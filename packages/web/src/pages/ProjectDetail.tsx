import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, useParams, useSearchParams, Link } from 'react-router-dom'
import { useEnvPath } from '../lib/env.js'
import { api, ApiError, type ProjectDto } from '../api.js'
import { LogsTab } from '../components/LogsTab.js'
import { Topology } from '../components/Topology.js'
import { confirmLeave, hasUnsaved, leaveWithoutAsking } from '../lib/unsaved.js'
import { StatusBadge } from '../components/Status.js'
import { DeployProgress } from '../components/DeployProgress.js'
import { ProjectSecurity } from '../components/Security.js'
import { PublicPillFor } from '../components/Publication.js'
import { ProjectSettings, useKeepToggle, type ContainerPatch, type ContainerRequest } from '../components/ProjectSettings.js'
import { notifyOk } from '../lib/feedback.js'
import { ProjectOverview, useProjectHealth } from '../components/ProjectOverview.js'
import { PageHead } from '../components/PageHead.js'
import { IconWarn } from '../components/Icons.js'
import { RowMenu } from '../components/RowMenu.js'
import { DeployList, useDeployments } from '../components/DeployList.js'
import { PreviewsSection } from '../components/Previews.js'
import { SiteAccess } from '../components/SiteAccess.js'
import { TrafficTab } from '../components/Traffic.js'
import { OfflineMenuItems, StopStartMenuItems, type MenuConfirm } from '../components/ProjectMenuItems.js'
import { KIND_LABEL, shortVersion } from '../lib/format.js'
import { poll } from '../lib/live.js'
import { isLive, isPublic } from '../lib/projects.js'
import { openTotal } from '@airlock/shared'
import { EmptyState, ErrorState, Loading, SkLog, SkProjectDetail, SkRows } from '../components/States.js'

const IconGear = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="8" r="2" />
    <path d="M6.9 1.8h2.2l.4 1.6 1.1.5 1.4-.9 1.6 1.6-.9 1.4.5 1.1 1.6.4v2.2l-1.6.4-.5 1.1.9 1.4-1.6 1.6-1.4-.9-1.1.5-.4 1.6H6.9l-.4-1.6-1.1-.5-1.4.9-1.6-1.6.9-1.4-.5-1.1-1.6-.4V6.9l1.6-.4.5-1.1-.9-1.4 1.6-1.6 1.4.9 1.1-.5Z" />
  </svg>
)

type Tab = 'uebersicht' | 'aufbau' | 'deployments' | 'logs' | 'besucher' | 'security' | 'einstellungen'

export function ProjectDetail() {
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const ep = useEnvPath()
  const [params, setParams] = useSearchParams()
  // Reihenfolge laut Auftrag «Aufbau»; Einstellungen rechts abgesetzt.
  // Etappe 3: «Besucher» (Auswertung) gleich nach «Logs»/«Zugriffe» (einzelne Einträge)
  const TABS: Tab[] = ['uebersicht', 'aufbau', 'deployments', 'logs', 'besucher', 'security', 'einstellungen']
  const fromUrl = params.get('tab') as Tab | null
  const tab: Tab = fromUrl && TABS.includes(fromUrl) ? fromUrl : 'uebersicht'
  // Der Reiter steht in der Adresse: Links aus der Übersicht («Log ansehen»)
  // landen direkt richtig, und Zurück im Browser wechselt den Reiter.
  // UI-Qualität 8: Reiterwechsel mit ungespeicherten Eingaben (z.B. Variablen) erst nach Rückfrage
  // Gibt zurück, ob gewechselt wurde: Folgeschritte (Fokus, Löschen vormerken) nur dann
  const showTab = (t: Tab) => setParams(t === 'uebersicht' ? {} : { tab: t }, { replace: false })
  const setTab = async (t: Tab): Promise<boolean> => {
    if (t === tab) return true
    const ok = await confirmLeave()
    if (ok) showTab(t)
    return ok
  }
  // Wechsel, den die Oberfläche selbst auslöst (Deploy/Rollback gestartet → Fortschritt in der
  // Übersicht): nie mit Rückfrage aus dem Nichts und nie still verwerfen – mit offenen Eingaben
  // bleibt der Reiter, der Vorgang läuft trotzdem (Anzeige oben rechts)
  const showOverviewIfFree = () => { if (!hasUnsaved()) showTab('uebersicht') }
  // UI-Qualität 5: direkt nach «Anlegen und deployen» läuft der Fortschritt des ersten Deploys
  const location = useLocation()
  const [watching, setWatching] = useState<string | null>(() => (location.state as { watch?: string } | null)?.watch ?? null)
  // Einmal gelesen, dann aus dem Verlauf entfernen: sonst käme der Fortschritt nach Neuladen oder
  // «Zurück» wieder (mit falscher Ansage für einen längst ersetzten Deploy)
  useEffect(() => {
    if ((location.state as { watch?: string } | null)?.watch) navigate(`${location.pathname}${location.search}`, { replace: true, state: null })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [announce, setAnnounce] = useState('')
  // «Löschen …» aus dem Menü: zur Rückfrage (Kurzname eintippen) in der Gefahrenzone der Einstellungen
  const [deleteRequested, setDeleteRequested] = useState(false)
  const goToDelete = () => {
    void setTab('einstellungen').then((ok) => { if (ok) setDeleteRequested(true) })
  }
  // Fehlerbox «Variable X fehlt» → «Hinzufügen»: Umgebung in den Einstellungen, Name vorbelegt
  const [envRequest, setEnvRequest] = useState<string | null>(null)
  const goToEnv = (name: string) => {
    void setTab('einstellungen').then((ok) => { if (ok) setEnvRequest(name) })
  }
  // Antwort 8: Fehlerbox «Port ändern», «Grenze erhöhen» … → Abschnitt Container, Feld vorbelegt
  const [containerRequest, setContainerRequest] = useState<ContainerRequest | null>(null)
  const goToContainer = (r: ContainerRequest) => {
    void setTab('einstellungen').then((ok) => { if (ok) setContainerRequest(r) })
  }
  // Seit dem letzten Deploy dort gespeichert: die Fehlerbox sagt dann «… ist jetzt …» statt erneut zu fragen
  const [containerSaved, setContainerSaved] = useState<ContainerPatch>({})
  // Aufbau «Veröffentlichen →»: Einstellungen › Veröffentlichung, Ablauf offen
  const [publishRequested, setPublishRequested] = useState(false)
  const goToPublish = () => {
    void setTab('einstellungen').then((ok) => { if (ok) setPublishRequested(true) })
  }
  // «Verwalten» bei den Security-Headern (Einstellungen, Aufbau): Security › Liste «Header über Caddy»
  const manageHeaders = () => {
    void setTab('security').then((ok) => {
      if (!ok) return
      // Die Liste erscheint, sobald der Reiter geladen ist
      const go = (tries: number) => {
        const el = document.getElementById('header-caddy')
        if (el) el.scrollIntoView({ block: 'start' })
        else if (tries > 0) setTimeout(() => go(tries - 1), 100)
      }
      go(20)
    })
  }
  // Etappe 6: «In den Einstellungen einschalten» (Deployments › Vorschauen) → Einstellungen › Vorschauen
  const goToPreviewSettings = () => {
    void setTab('einstellungen').then((ok) => {
      if (!ok) return
      const go = (tries: number) => {
        const el = document.getElementById('set-vorschauen')
        if (!el) { if (tries > 0) setTimeout(() => go(tries - 1), 100); return }
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
        el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
      }
      go(20)
    })
  }
  // Logs: Dienst steht in der Adresse (?tab=logs&dienst=web), damit «Alle Logs» im Aufbau gefiltert landet
  const logService = params.get('dienst')
  const goToLogs = async (service: string | null) => {
    if (tab !== 'logs' && !(await confirmLeave())) return
    setParams(service ? { tab: 'logs', dienst: service } : { tab: 'logs' }, { replace: false })
  }

  const q = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.getProject(id),
    // Ereignisstrom statt Polling (UI-Qualität 3); während DeployProgress läuft, meldet der eigene Strom
    refetchInterval: watching ? false : poll,
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
        showOverviewIfFree()
      }
      void qc.invalidateQueries({ queryKey: ['project', id] })
    },
  })

  // Neuer Deploy (auch per MCP oder Auto-Deploy): die gespeicherten Änderungen sind darin enthalten
  const lastDeployId = q.data?.project.lastDeployment?.id
  useEffect(() => { setContainerSaved({}) }, [lastDeployId])

  const health = useProjectHealth(q.data?.project ?? ({ id, activeDeployment: null, desiredState: 'stopped' } as unknown as ProjectDto))
  // Zähler im Reiter «Deployments» (dieselbe Abfrage wie die Liste)
  const deployList = useDeployments(id)
  const keep = useKeepToggle({ id, name: q.data?.project.name ?? 'Projekt' })

  // Daten gehen vor: scheitert nur ein späteres Nachladen, bleibt die Seite stehen (Zustand «Veraltet»)
  if (!q.data && q.isError && !(q.error instanceof ApiError && q.error.status === 404)) {
    return (
      <section className="page">
        <PageHead crumbs={[{ label: 'Projekte', to: ep('/projekte') }, { label: 'Projekt' }]} title="Projekt" />
        <ErrorState what="Das Projekt" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
      </section>
    )
  }
  if (!q.data && !q.isError) return <section className="page"><Loading label="Projekt wird geladen"><SkProjectDetail /></Loading></section>
  if (!q.data) {
    return (
      <section className="page">
        <PageHead crumbs={[{ label: 'Projekte', to: ep('/projekte') }, { label: 'Nicht gefunden' }]} title="Projekt nicht gefunden" />
        <div className="state state-empty">
          <p>Vielleicht wurde es gelöscht, in eine andere Umgebung verschoben, oder die Adresse ist veraltet.</p>
          <Link className="button" to={ep('/projekte')}>Zu den Projekten</Link>
        </div>
      </section>
    )
  }

  const p = q.data!.project
  const env = q.data!.env
  const url = p.routes.find((r) => r.target !== 'public')?.urls[0] ?? p.routes[0]?.urls[0]
  const isStatic = p.runtimeKind === 'static'
  const openFindings = openTotal(p.security?.open)
  const deployCount = deployList.data?.deployments[0]?.seq ?? deployList.data?.deployments.length
  // Ton des Zählers nach der schwersten offenen Stufe (Farbregel, UI-Qualität 7)
  const o = p.security?.open
  const secTone = o?.critical ? 'critical' : o?.high ? 'bad' : o?.medium ? 'warn' : undefined
  const tabInfo: Record<Tab, { label: string; count?: number; tone?: 'warn' | 'bad' | 'critical'; countLabel?: string; live?: boolean }> = {
    uebersicht: { label: 'Übersicht' },
    aufbau: { label: 'Aufbau' },
    security: { label: 'Security', count: openFindings, tone: secTone, countLabel: openFindings === 1 ? '1 offener Befund' : `${openFindings} offene Befunde` },
    deployments: { label: 'Deployments', count: deployCount, countLabel: `${deployCount} ${deployCount === 1 ? 'Deployment' : 'Deployments'}` },
    // Statische Seiten haben keinen Container: dort das Zugriffs-Log von Caddy
    logs: { label: isStatic ? 'Zugriffe' : 'Logs', live: !isStatic && Boolean(health.data?.container?.running) },
    besucher: { label: 'Besucher' },
    einstellungen: { label: 'Einstellungen' },
  }

  return (
    <section className="page page-project">
      <PageHead
        crumbs={[{ label: 'Projekte', to: ep('/projekte') }, { label: p.name }]}
        name={p.name}
        title={<><h1>{p.name}</h1><StatusBadge state={p.state} /><PublicPillFor p={p} /></>}
        actions={
          <>
            {/* Sichtbar nur das Häufige; alles Weitere im «⋯»-Menü (Rückfragen dort, wie in der Projektkarte) */}
            {url && isLive(p) && <a className="button" href={url} target="_blank" rel="noreferrer">Öffnen ↗</a>}
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
          // Fokus nur auf den Reiter, der auch gewählt ist (bei «Weiter bearbeiten» bleibt alles)
          void setTab(next).then((ok) => { if (ok) requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus()) })
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
              {/* Zahl sichtbar, für Screenreader als Satz (aria-label auf span ohne Rolle ist unzulässig) */}
              {t.count !== undefined && t.count > 0 && <><span className={`tab-count${t.tone ? ` tab-count-${t.tone}` : ''}`} aria-hidden="true">{t.count}</span><span className="sr-only">, {t.countLabel}</span></>}
              {t.live && <span className="tab-live" role="img" aria-label="Container läuft" title="Container läuft" />}
            </button>
          )
        })}
      </nav>
      {/* Bleibt über Reiterwechsel und das Ende des Deploys hinweg im DOM */}
      <p className="sr-only" role="status">{announce}</p>
      <div id="tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>

      {tab === 'uebersicht' && (
        <div className="tab-panel">
          {watching && (
            <DeployProgress
              deploymentId={watching}
              hasPrevious={Boolean(p.activeDeployment)}
              onFinished={(ok) => {
                // Ende ansagen über die Region der Seite: der Fortschritt verschwindet gleich danach
                setAnnounce(ok ? 'Deploy fertig. Der neue Stand ist live.'
                  : p.activeDeployment ? 'Deploy fehlgeschlagen. Die vorherige Fassung läuft weiter.' : 'Deploy fehlgeschlagen. Es läuft noch keine Fassung.')
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
            onAddEnv={goToEnv}
            onContainerField={goToContainer}
            containerSaved={containerSaved}
          />
        </div>
      )}

      {tab === 'deployments' && (
        <Deployments
          projectId={id}
          onRollback={(depId) => {
            setWatching(depId)
            showOverviewIfFree()
          }}
          onPreviewSettings={goToPreviewSettings}
        />
      )}
      {tab === 'aufbau' && (
        <Topology
          p={p}
          onLogs={(service) => void goToLogs(service)}
          onPublish={goToPublish}
          onRestart={() => act.mutate('restart')}
          restartBusy={act.isPending}
          onManageHeaders={() => manageHeaders()}
          onDeployments={() => void setTab('deployments')}
        />
      )}
      {tab === 'logs' && (isStatic ? <SiteAccess projectId={id} slug={p.slug} /> : (
        <LogsTab
          projectId={id}
          slug={p.slug}
          activeDeploymentId={p.activeDeployment?.id ?? null}
          service={logService}
          onService={(s) => setParams(s ? { tab: 'logs', dienst: s } : { tab: 'logs' }, { replace: true })}
        />
      ))}
      {tab === 'besucher' && <TrafficTab p={p} onAccessLog={isStatic ? () => void setTab('logs') : undefined} />}
      {tab === 'security' && <ProjectSecurity projectId={p.id} sourceType={p.sourceType} />}
      {tab === 'einstellungen' && (
        <ProjectSettings
          p={p}
          env={env}
          // Projekt gelöscht: offene Eingaben haben kein Ziel mehr, keine Rückfrage
          onDeleted={() => { leaveWithoutAsking(); navigate(ep('/projekte')) }}
          deleteRequested={deleteRequested}
          onDeleteShown={() => setDeleteRequested(false)}
          envRequest={envRequest}
          onEnvShown={() => setEnvRequest(null)}
          containerRequest={containerRequest}
          onContainerShown={() => setContainerRequest(null)}
          onContainerSaved={(patch, undo) => setContainerSaved((s) => {
            const next = { ...s, ...patch }
            if (undo) for (const k of Object.keys(patch) as (keyof ContainerPatch)[]) delete next[k]
            return next
          })}
          onDeploy={() => act.mutate('deploy')}
          deploying={act.isPending || p.status === 'deploying'}
          onManageHeaders={() => manageHeaders()}
          publishRequested={publishRequested}
          onPublishShown={() => setPublishRequested(false)}
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
    <RowMenu label="Weitere Aktionen" onClose={() => setConfirm(null)}>
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

function Deployments({ projectId, onRollback, onPreviewSettings }: { projectId: string; onRollback: (deploymentId: string) => void; onPreviewSettings: () => void }) {
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
      {/* Etappe 6: Vorschau-Deploys je Branch/PR (nur intern) */}
      <PreviewsSection projectId={projectId} onSettings={onPreviewSettings} />
    </div>
  )
}


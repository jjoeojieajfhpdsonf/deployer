import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { publicStateOf, sumCounts, DISK_BLOCK_PERCENT, DISK_HINT_PERCENT, type ProjectDto, type SystemStatusDto } from '@airlock/shared'
import { PublicPillFor } from '../components/Publication.js'
import { usePublicActions } from '../lib/public.js'
import { api } from '../api.js'
import { poll } from '../lib/live.js'
import { ChatSteps } from '../components/ChatSteps.js'
import { StatusBadge } from '../components/Status.js'
import { PageHead } from '../components/PageHead.js'
import { RowMenu } from '../components/RowMenu.js'
import { OfflineMenuItems, StopStartMenuItems, type MenuConfirm } from '../components/ProjectMenuItems.js'
import { IconAlert, IconBox, IconChat, IconGit, IconPlus, IconSearch, IconUpload, IconWarn } from '../components/Icons.js'
import { useSystem } from '../components/ServerName.js'
import { useEnvPath } from '../lib/env.js'
import { useProjects, attention, deployFailedState, isPublic, isRunningOk, urgency } from '../lib/projects.js'
import { relativeTime, clockOrDay, gb, pct, shortVersion, KIND_LABEL, actorLabel, auditTone, describeAudit } from '../lib/format.js'
import { ageMs, fmtDateTime } from '../lib/dates.js'
import { notifyOk } from '../lib/feedback.js'
import { EmptyState, ErrorState, Loading, SkProjectCards, SkRows, SkStats } from '../components/States.js'
import { useTrafficToday } from '../components/Traffic.js'


type Filter = 'alle' | 'laufen' | 'aufmerksamkeit'

export function Projects() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const ep = useEnvPath()
  const projects = useProjects()
  const system = useSystem()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('alle')
  const searchRef = useRef<HTMLInputElement>(null)

  // Ergebnis als Toast (ein Muster für die ganze App); Stoppen lässt sich rückgängig machen
  const act = useMutation({
    meta: { errorTitle: 'Aktion nicht ausgeführt' },
    mutationFn: async ({ id, what }: { id: string; what: 'deploy' | 'stop' | 'start' }) => {
      if (what === 'deploy') return api.deploy(id)
      if (what === 'stop') return api.stop(id)
      return api.start(id)
    },
    onSuccess: (_r, v) => {
      const p = list.find((x) => x.id === v.id)
      const name = p?.name ?? 'Projekt'
      if (v.what === 'deploy') notifyOk(`Deploy für «${name}» gestartet`, { id: `act-${v.id}`, description: 'Der Fortschritt steht oben bei «Vorgänge» und in der Karte.' })
      else if (v.what === 'stop') notifyOk(`«${name}» ist gestoppt`, { id: `act-${v.id}`, description: 'Die Adresse antwortet nicht mehr.', undo: () => act.mutate({ id: v.id, what: 'start' }) })
      else notifyOk(`«${name}» wird gestartet`, { id: `act-${v.id}` })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  })

  const list = projects.data?.projects ?? []
  // Etappe 3: «214 Aufrufe heute» – nur wenn Airlock das Zugriffs-Log liest und das Projekt eine Adresse hat
  const today = useTrafficToday()
  const viewsToday = (p: ProjectDto): number | null =>
    today.data?.ingest === 'ok' && p.routes.length > 0 ? today.data.views[p.id] ?? 0 : null
  const counts = useMemo(() => ({
    alle: list.length,
    laufen: list.filter(isRunningOk).length,
    aufmerksamkeit: list.filter((p) => attention(p)).length,
  }), [list])
  // Bei wenigen Projekten sagt der Filter nichts, was das Raster nicht schon zeigt
  const showFilter = list.length >= 4
  const view: Filter = showFilter ? filter : 'alle'

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return list
      .filter((p) => view === 'alle' || (view === 'laufen' ? isRunningOk(p) : attention(p)))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.includes(q) || p.routes.some((r) => r.hostname.includes(q)))
      // Dringendes zuerst, dann nach Name
      .sort((a, b) => urgency(b) - urgency(a) || a.name.localeCompare(b.name, 'de-CH'))
  }, [list, view, query])

  // Karte «Neues Projekt» füllt die freien Spalten der letzten Reihe; bei voller Reihe entfällt sie
  const [grid, setGrid] = useState<HTMLUListElement | null>(null)
  const cols = useGridColumns(grid)
  const free = (cols - (shown.length % cols)) % cols
  const showNew = view === 'alle' && !query.trim() && free > 0
  const [chatGuide, setChatGuide] = useState(false)

  const failed = list.filter(deployFailedState)

  return (
    <section className="page">
      <PageHead
        crumbs={[{ label: 'Projekte' }]}
        title="Projekte"
        actions={
          <>
            <div className="search">
              <IconSearch />
              <input ref={searchRef} data-page-search aria-keyshortcuts="/" type="search" aria-label="Projekte durchsuchen (Taste /)" placeholder="Suchen …  /" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <Link className="button button-primary" to={ep('/projekte/neu')}><IconPlus /> Neues Projekt</Link>
          </>
        }
      />

      {!projects.data && projects.isError ? (
        <ErrorState what="Die Projektliste" error={projects.error} retrying={projects.isFetching} onRetry={() => void projects.refetch()} />
      ) : !projects.data ? (
        <Loading label="Projekte werden geladen"><SkStats /><SkProjectCards /></Loading>
      ) : list.length === 0 ? (
        <>
          <Stats list={list} system={system.data} />
          <div className="state state-empty section">
            <h2>Noch kein Projekt</h2>
            <p>
              Ein fertiges Image, ein Repo mit Dockerfile, eine Compose-Datei oder eine statische Seite.
              Aus dem Chat geht es über MCP auch ohne Repo.
            </p>
            <Link className="button button-primary" to={ep('/projekte/neu')}><IconPlus /> Erstes Projekt anlegen</Link>
          </div>
        </>
      ) : (
        <>
          <Stats list={list} system={system.data} />

          {failed.slice(0, 3).map((p) => (
            <FailedBanner
              key={p.id}
              p={p}
              onLog={() => navigate(ep(`/projekte/${p.id}?tab=deployments`))}
              onRetry={() => act.mutate({ id: p.id, what: 'deploy' })}
              busy={act.isPending}
            />
          ))}
          {failed.length > 3 && (
            <p className="hint">und {failed.length - 3} weitere fehlgeschlagene Deploys – Filter «Brauchen Aufmerksamkeit».</p>
          )}

          <div className="section">
            <div className="section-head">
              <h2>{view === 'alle' ? 'Alle Projekte' : view === 'laufen' ? 'Laufende Projekte' : 'Brauchen Aufmerksamkeit'}</h2>
              {showFilter && (
                <div className="segmented" role="group" aria-label="Filter">
                  {([
                    ['alle', 'Alle'],
                    ['laufen', 'Laufen'],
                    ['aufmerksamkeit', 'Brauchen Aufmerksamkeit'],
                  ] as const).map(([k, label]) => (
                    <button key={k} aria-pressed={view === k} onClick={() => setFilter(k)}>
                      {label} <span className="num">{counts[k]}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Projekte als Karten im Raster (cal.com: Karten statt Tabelle) */}
            <ul className="pcards" aria-label="Projekte" ref={setGrid}>
              {shown.map((p) => (
                <ProjectCard key={p.id} p={p} onAct={(what) => act.mutate({ id: p.id, what })} busy={act.isPending} viewsToday={viewsToday(p)} />
              ))}
              {showNew && <NewProjectCard span={free} onChat={() => setChatGuide(true)} />}
            </ul>
            {shown.length === 0 && (
              <p className="empty-inline">
                {query ? <>Kein Projekt passt zu «{query}».</> : view === 'aufmerksamkeit' ? 'Nichts zu tun – alles in Ordnung.' : 'Keine Projekte in dieser Ansicht.'}
              </p>
            )}
          </div>
          <ChatGuide open={chatGuide} onClose={() => setChatGuide(false)} />
        </>
      )}

      <div className="split">
        <Activity projects={list} />
        <ServerPanel s={system.data} />
      </div>
    </section>
  )
}

/* --- Kennzahlen ----------------------------------------------------------------- */

function Stats({ list, system }: { list: ProjectDto[]; system: SystemStatusDto | undefined }) {
  // Zählung aus p.state (gleiche Quelle wie Pillen und Karten)
  // «laufen» ohne die mit gescheitertem Deploy (die stehen als «Deploy-Fehler» daneben, nicht doppelt) – wie der Filter
  const running = list.filter(isRunningOk).length
  const deploying = list.filter((p) => p.state.key === 'deploying').length
  const failedCount = list.filter((p) => p.state.key === 'failed_old_running' || p.state.key === 'down').length
  const all = sumCounts(list.map((p) => p.security?.open))
  const sum = (k: 'critical' | 'high' | 'medium' | 'low') => all[k]
  const crit = sum('critical')
  const high = sum('high')
  const rest = sum('medium') + sum('low')
  const worst = list.filter((p) => p.security && (crit ? p.security.open.critical : p.security.open.high) > 0)
  const whereText = worst.length === 0 ? '' : worst.length <= 2 ? `in ${worst.map((p) => p.slug).join(', ')}` : `in ${worst.length} Projekten`
  const where = whereText ? <> · <span className="truncate" title={whereText}>{whereText}</span></> : null
  const publicList = list.filter(isPublic)
  // Bei ein, zwei öffentlichen Projekten die Adressen selbst, sonst nur der Weg
  const publicUrls = publicList.length <= 2
    ? publicList.flatMap((p) => p.routes.find((r) => r.target === 'public')?.urls[0] ?? [])
    : []
  const srv = system?.server
  const memPct = pct(srv?.memUsedBytes, srv?.memTotalBytes)
  const diskPct = pct(srv?.diskUsedBytes, srv?.diskTotalBytes)

  return (
    <div className="stats">
      <div className="stat">
        <div className="label">Projekte</div>
        <div className="stat-value">{list.length}</div>
        {/* Nullen weglassen, damit die Zeile auch in schmalen Karten einzeilig bleibt */}
        <div className="stat-sub">
          {running} {running === 1 ? 'läuft' : 'laufen'}
          {deploying > 0 && ` · ${deploying} deployt`}
          {failedCount > 0 ? ` · ${failedCount} Deploy-Fehler` : ' · keine Fehler'}
        </div>
      </div>
      <div className="stat">
        <div className="label">Offene Befunde</div>
        {crit > 0 ? (
          <div className="stat-value tone-bad">{crit} kritisch</div>
        ) : high > 0 ? (
          <div className="stat-value tone-bad tone-high">{high} hoch</div>
        ) : (
          <div className="stat-value">{rest > 0 ? rest : '0'}</div>
        )}
        <div className="stat-sub">
          {crit > 0 ? <>{high} hoch{where}</> : high > 0 ? <>0 kritisch{where}</> : rest > 0 ? 'nur mittel und niedrig' : 'nichts offen'}
        </div>
      </div>
      <div className="stat">
        <div className="label">Öffentlich</div>
        <div className="stat-value">{publicList.length}</div>
        <div className="stat-sub">
          {publicUrls.length > 0 ? (
            <span className="stat-links">
              {publicUrls.map((u) => {
                const host = u.replace(/^https?:\/\//, '')
                return <a key={u} href={u} target="_blank" rel="noreferrer" title={host}>{host}</a>
              })}
            </span>
          ) : system?.publicTunnel.configured ? 'über Cloudflare Tunnel' : 'Tunnel nicht eingerichtet'}
        </div>
      </div>
      <div className="stat">
        <div className="label">Arbeitsspeicher</div>
        <div className="stat-value">{gb(srv?.memUsedBytes)} <small>/ {gb(srv?.memTotalBytes)} GB</small></div>
        <div className="stat-sub">
          CPU {srv?.cpuPercent ?? '–'} % · Disk {diskPct ?? '–'} %
          {memPct !== null && memPct >= 90 && <span className="warn"> · Speicher knapp</span>}
        </div>
      </div>
    </div>
  )
}

/* --- Neues Projekt im Raster ---------------------------------------------------------- */

/** Spaltenzahl des Rasters (auto-fill), gemessen am Element; folgt der Fensterbreite. */
function useGridColumns(el: HTMLElement | null) {
  const [cols, setCols] = useState(3)
  useLayoutEffect(() => {
    if (!el) return
    const read = () => setCols(Math.max(1, getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length))
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return cols
}

const SOURCES: { key: 'git' | 'image' | 'upload' | 'chat'; title: string; hint: string; Icon: ComponentType<{ size?: number }> }[] = [
  { key: 'git', title: 'Git-Repo', hint: 'GitHub, GitLab oder eigene URL', Icon: IconGit },
  { key: 'image', title: 'Image', hint: 'Fertiges Container-Image', Icon: IconBox },
  { key: 'upload', title: 'Upload', hint: 'ZIP mit Seite oder Compose', Icon: IconUpload },
  { key: 'chat', title: 'Per Chat', hint: 'In Claude über den MCP-Server', Icon: IconChat },
]

/**
 * Gestrichelte Karte in den freien Spalten der letzten Reihe: mit einer Spalte
 * nur Titel und Knopf, ab zwei Spalten die vier Quellen als Kacheln.
 */
function NewProjectCard({ span, onChat }: { span: number; onChat: () => void }) {
  const ep = useEnvPath()
  const head = (
    <div className="pnew-head">
      <span className="pnew-mark" aria-hidden="true"><IconPlus /></span>
      <h3>Neues Projekt</h3>
    </div>
  )
  if (span < 2) {
    return (
      <li className="pnew pnew-compact">
        {head}
        <Link className="button" to={ep('/projekte/neu')}>Quelle wählen</Link>
      </li>
    )
  }
  return (
    <li className="pnew" style={{ gridColumn: `span ${span}` }}>
      {head}
      <p className="pnew-lede">Deployen aus einer dieser Quellen. Jedes Projekt wird vor dem Veröffentlichen gescannt.</p>
      <ul className="pnew-sources" aria-label="Quelle für ein neues Projekt">
        {SOURCES.map(({ key, title, hint, Icon }) => {
          const body = <><Icon size={16} /><strong>{title}</strong><small>{hint}</small></>
          return (
            <li key={key}>
              {key === 'chat'
                ? <button type="button" className="pnew-source" aria-haspopup="dialog" onClick={onChat}>{body}</button>
                : <Link className="pnew-source" to={ep(`/projekte/neu?quelle=${key}`)}>{body}</Link>}
            </li>
          )
        })}
      </ul>
    </li>
  )
}

/** Kurze Anleitung: Projekte aus dem Chat über den MCP-Server anlegen. */
function ChatGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ep = useEnvPath()
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    // Klick auf den abgedunkelten Rand schliesst (das Ziel ist dann das <dialog> selbst)
    <dialog ref={ref} className="dialog" aria-labelledby="chat-guide-h" onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog-body">
        <h2 id="chat-guide-h">Per Chat deployen</h2>
        <p className="dialog-lede">Claude legt Projekte über den MCP-Server von Airlock an, ohne Repo und ohne Formular. Einmal einrichten:</p>
        <ChatSteps />
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Schliessen</button>
          <Link className="button button-primary" to={ep('/tokens')}>Zu den Tokens</Link>
        </div>
      </div>
    </dialog>
  )
}

/* --- Hinweis bei fehlgeschlagenem Deploy -------------------------------------------- */

function FailedBanner({ p, onLog, onRetry, busy }: { p: ProjectDto; onLog: () => void; onRetry: () => void; busy: boolean }) {
  const d = p.lastDeployment!
  const still = p.activeDeployment ? `Version ${shortVersion(p.activeDeployment.version)} läuft unverändert weiter.` : 'Es läuft keine frühere Version.'
  return (
    <div className="alert" role="alert">
      <span className="alert-icon"><IconAlert /></span>
      <div className="alert-body">
        <strong>{p.name}: {d.trigger === 'rollback' ? 'Rollback' : 'Deploy'} fehlgeschlagen</strong>
        <span>{sentence(d.failure?.title ?? firstLine(d.errorMessage ?? 'Ohne Fehlermeldung'))} {still}</span>
      </div>
      <div className="alert-actions">
        <button onClick={onLog}>Log ansehen</button>
        <button onClick={onRetry} disabled={busy} title="Baut bzw. holt die Quelle neu und deployt sie">Erneut deployen</button>
      </div>
    </div>
  )
}

const shorten = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
/** Nur die erste Zeile bzw. der erste Satz einer Fehlermeldung, ohne Stack. */
const firstLine = (s: string) => {
  let line = s.split(/\n|\s+at\s+\S+\s+\(/)[0]!.trim()
  // Endet die erste Zeile mit «:», folgt ein Auszug – dann nur die Sätze davor (break-ui #3)
  if (line.endsWith(':')) {
    const sentences = line.match(/[^.!?]+[.!?]/g)
    line = sentences && sentences.length > 1 ? sentences.slice(0, -1).join('').trim() : line.replace(/:$/, '')
  }
  return shorten(line, 160)
}
/** Satzende ergänzen, damit der nächste Satz nicht angeklebt wirkt. */
const sentence = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`)

/* --- Projekt-Karte ------------------------------------------------------------------ */

const STEP: Record<string, { n: number; label: string }> = {
  pending: { n: 0, label: 'wartet' },
  pulling: { n: 1, label: 'Quelle holen' },
  starting: { n: 2, label: 'Starten' },
  healthchecking: { n: 3, label: 'Healthcheck' },
  active: { n: 4, label: 'Umschalten' },
}

/** Menü «…» eines Projekts. */
function ProjectMenu({ p, url, onAct, busy }: { p: ProjectDto; url: string | undefined; onAct: (what: 'deploy' | 'stop' | 'start') => void; busy: boolean }) {
  const ep = useEnvPath()
  const [confirm, setConfirm] = useState<MenuConfirm>(null)
  return (
    <RowMenu label={`Aktionen für ${p.name}`} onClose={() => setConfirm(null)}>
      {(close) => (
        <>
          {url && <a role="menuitem" href={url} target="_blank" rel="noreferrer" onClick={close}>Öffnen</a>}
          <Link role="menuitem" to={ep(`/projekte/${p.id}?tab=logs`)} onClick={close}>Logs</Link>
          <Link role="menuitem" to={ep(`/projekte/${p.id}?tab=deployments`)} onClick={close}>Deployments</Link>
          <div className="menu-sep" />
          <button role="menuitem" disabled={busy || p.status === 'deploying'} onClick={() => { close(); onAct('deploy') }}>Neu deployen</button>
          <OfflineMenuItems p={p} close={close} confirm={confirm} setConfirm={setConfirm} />
          <StopStartMenuItems p={p} close={close} busy={busy} confirm={confirm} setConfirm={setConfirm} onStop={() => onAct('stop')} onStart={() => onAct('start')} />
        </>
      )}
    </RowMenu>
  )
}

/** Erreichbarkeit als dezente Pillen (Öffentlich hebt sich mit Zeichen ab). */
function Reach({ p, className }: { p: ProjectDto; className: string }) {
  if (p.routes.length === 0) return <span className="muted">nirgends</span>
  return (
    <div className={className}>
      <PublicPillFor p={p} />
      {p.routes.some((r) => (r.targets ?? [r.target]).includes('lan')) && <span className="chip">LAN</span>}
      {p.routes.some((r) => (r.targets ?? [r.target]).includes('tailnet')) && <span className="chip">Tailnet</span>}
    </div>
  )
}

/* --- Projekt-Karte (Prototyp «cal») ------------------------------------------------- */

function ProjectCard({ p, onAct, busy, viewsToday }: { p: ProjectDto; onAct: (what: 'deploy' | 'stop' | 'start') => void; busy: boolean; viewsToday: number | null }) {
  const ep = useEnvPath()
  const url = p.routes.find((r) => r.target !== 'public')?.urls[0] ?? p.routes[0]?.urls[0]
  const host = url?.replace(/^https?:\/\//, '')
  const d = p.lastDeployment
  const version = shortVersion(d?.version ?? p.activeDeployment?.version)
  const src = sourceLine(p)
  const bad = p.state.key === 'failed_old_running' || p.state.key === 'down'
  return (
    <li className={`pcard${bad ? ' pcard-bad' : ''}`}>
      <div className="pcard-head">
        <div className="pcard-title">
          {/* Der Name ist der Link; ::after macht die ganze Karte klickbar */}
          <h3><Link className="pcard-link" to={ep(`/projekte/${p.id}`)}>{p.name}</Link></h3>
          {host ? <span className="pcard-host" title={host}>{host}</span> : <span className="pcard-host">keine Adresse</span>}
        </div>
        <StatusBadge state={p.state} />
      </div>

      <div className="pcard-state">
        <StatusSub p={p} />
        <Reach p={p} className="chips" />
      </div>

      {/* Fakten als Zeilen unter einer feinen Linie, keine Kästchen in der Karte */}
      <dl className="pcard-facts">
        <div>
          <dt>Security</dt>
          <dd><SecurityCell p={p} /></dd>
        </div>
        <div>
          <dt>Letzter Deploy</dt>
          <dd>
            {p.status === 'deploying' ? 'läuft gerade' : relativeTime(d?.startedAt)}
            {version !== '–' && <> · <span className="version">{version}</span></>}
          </dd>
        </div>
        <div>
          <dt>Quelle</dt>
          <dd title={src.title}>{src.text}</dd>
        </div>
      </dl>

      <div className="pcard-foot">
        {viewsToday !== null && (
          <Link className="pcard-visits" to={ep(`/projekte/${p.id}?tab=besucher`)}>
            <span className="num">{viewsToday.toLocaleString('de-CH')}</span> {viewsToday === 1 ? 'Aufruf' : 'Aufrufe'} heute
          </Link>
        )}
        <div className="pcard-actions">
          {url && <a className="button button-small" href={url} target="_blank" rel="noreferrer">Öffnen</a>}
          <ProjectMenu p={p} url={url} onAct={onAct} busy={busy} />
        </div>
      </div>
    </li>
  )
}

/** Zeile «Quelle»: Art und das Wichtigste dazu (Tag, Repo, Ablauf bei Chat-Projekten). */
function sourceLine(p: ProjectDto): { text: string; title?: string } {
  const kind = KIND_LABEL[p.sourceType] ?? p.sourceType
  const s = p.source as { image?: string; repoUrl?: string; uploadId?: string } | null
  if (p.sourceType === 'files') {
    const left = ageMs(p.expiresAt)
    const days = left !== null ? Math.max(0, Math.ceil(-left / 86_400_000)) : null
    const runtime = p.runtimeKind !== 'static' ? KIND_LABEL[p.runtimeKind] : null
    const life = p.keep ? 'behalten' : days !== null ? `Ablauf in ${days} ${days === 1 ? 'Tag' : 'Tagen'}` : null
    return { text: [kind, runtime, life].filter(Boolean).join(' · ') }
  }
  if (s?.image) return { text: `${kind} · ${shortVersion(s.image.split('/').pop())}`, title: s.image }
  if (s?.repoUrl) {
    // Nur «besitzer/repo»; die volle Adresse im Tooltip
    const repo = s.repoUrl.replace(/^[a-z]+:\/\//i, '').replace(/\.git$/, '').split('/').filter(Boolean).slice(-2).join('/')
    return { text: `${kind} · ${repo}`, title: s.repoUrl }
  }
  if (s?.uploadId) return { text: `${kind} · Upload` }
  return { text: kind }
}

function StatusSub({ p }: { p: ProjectDto }) {
  const d = p.lastDeployment
  if (p.status === 'deploying' && d) {
    const step = STEP[d.status] ?? { n: 0, label: d.status }
    return (
      <>
        <div className="progress" aria-label={`Schritt ${step.n} von 4`}>
          <div className="progress-track"><div className="progress-fill" style={{ width: `${(step.n / 4) * 100}%` }} /></div>
          <span className="num">{step.n}/4</span>
        </div>
        <div className="cell-sub">{step.label}</div>
      </>
    )
  }
  // Unterzeile aus derselben Quelle wie die Pille (p.state); «läuft» braucht keine
  if (p.state.key === 'failed_old_running') {
    return (
      <div className="cell-sub">
        {p.state.detail ? <span className="deploy-failed">{p.state.detail}</span> : null}
        {p.activeDeployment ? `${p.state.detail ? ' · ' : ''}${shortVersion(p.activeDeployment.version)} läuft` : null}
      </div>
    )
  }
  return p.state.detail ? <div className="cell-sub">{p.state.detail}</div> : null
}

function SecurityCell({ p }: { p: ProjectDto }) {
  const s = p.security
  if (!s || s.grade === null) {
    const note = s?.status === 'running' || s?.status === 'queued' ? 'scannt' : p.status === 'deploying' ? 'nach Deploy' : s?.status === 'failed' ? 'Scan fehlgeschlagen' : 'kein Scan'
    return <div className="grade-cell"><span className="grade grade-none" aria-hidden="true">–</span>{note}</div>
  }
  // Schwerster offener Befund in der Form seiner Stufe (UI-Qualität 7)
  const serious = s.open.critical > 0 ? { sev: 'critical', text: `${s.open.critical} kritisch` } : s.open.high > 0 ? { sev: 'high', text: `${s.open.high} hoch` } : null
  return (
    <div className="grade-cell" title={`Note ${s.grade}, Score ${s.score} von 100`}>
      <span className={`grade grade-${s.grade}`}>{s.grade}</span>
      {serious ? <span>{s.score} · <span className={`sev sev-compact sev-${serious.sev}`}>{serious.text}</span></span> : <span>{s.score} / 100</span>}
      {(s.status === 'running' || s.status === 'queued') && <span className="muted">· scannt</span>}
    </div>
  )
}

/* --- Unterer Bereich ------------------------------------------------------------------ */

function Activity({ projects }: { projects: ProjectDto[] }) {
  const ep = useEnvPath()
  const audit = useQuery({ queryKey: ['audit', 'recent'], queryFn: () => api.audit(40), refetchInterval: poll })
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  // Benachrichtigungen (notify.*) gehören in die Glocke, hier stünden sie doppelt neben dem Ereignis
  const events = (audit.data?.events ?? []).filter((e) => e.action !== 'auth.login' && !e.action.startsWith('notify.')).slice(0, 6)

  return (
    <section className="panel panel-pad" aria-labelledby="activity-h">
      <div className="panel-head">
        <h2 id="activity-h">Letzte Aktivität</h2>
        <Link to={ep('/audit')} className="muted">Alles im Audit-Log</Link>
      </div>
      {!audit.data && audit.isError ? (
        <ErrorState compact what="Die Aktivität" error={audit.error} retrying={audit.isFetching} onRetry={() => void audit.refetch()} />
      ) : !audit.data ? (
        <Loading label="Aktivität wird geladen"><SkRows n={4} card={false} /></Loading>
      ) : events.length === 0 ? (
        <EmptyState compact title="Noch nichts passiert." action={<Link to="/projekte/neu" className="button button-small">Projekt anlegen</Link>}>Hier erscheinen Deploys, Scans und Änderungen.</EmptyState>
      ) : (
        <ul className="activity">
          {events.map((e) => (
            <li key={e.id}>
              <time dateTime={e.at} title={fmtDateTime(e.at)}>{clockOrDay(e.at)}</time>
              <span className={`dot dot-${auditTone(e)}`} aria-hidden="true" />
              <span className="what">{describeAudit(e, byId)}{e.result === 'error' && e.error ? <span className="muted"> – {shorten(e.error, 90)}</span> : null}</span>
              <span className="who">{actorLabel(e.actor)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ServerPanel({ s }: { s: SystemStatusDto | undefined }) {
  const srv = s?.server
  const rows: { label: string; value: string; p: number | null }[] = [
    { label: 'CPU', value: srv?.cpuPercent !== null && srv?.cpuPercent !== undefined ? `${srv.cpuPercent} %` : '–', p: srv?.cpuPercent ?? null },
    { label: 'Arbeitsspeicher', value: `${gb(srv?.memUsedBytes)} / ${gb(srv?.memTotalBytes)} GB`, p: pct(srv?.memUsedBytes, srv?.memTotalBytes) },
    { label: 'Speicherplatz', value: `${gb(srv?.diskUsedBytes)} / ${gb(srv?.diskTotalBytes)} GB`, p: pct(srv?.diskUsedBytes, srv?.diskTotalBytes) },
  ]
  const q = s?.scanQueue ?? 0
  return (
    <section className="panel panel-pad" aria-labelledby="server-h">
      <div className="panel-head">
        <h2 id="server-h">Server</h2>
        <Link to="/server" className="muted">Server</Link>
      </div>
      <div className="meters">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="meter-head"><span>{r.label}</span><span className="num">{r.value}</span></div>
            <div className="meter-track" role="progressbar" aria-label={r.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.p ?? undefined}>
              <div className={`meter-fill${r.p !== null && r.p >= 90 ? ' tone-bad' : r.p !== null && r.p >= 75 ? ' tone-warn' : ''}`} style={{ width: `${r.p ?? 0}%` }} />
            </div>
          </div>
        ))}
        {/* Nacht 3, Etappe 3: ab 80 % ein Hinweis mit Text (nicht nur die Farbe des Balkens) */}
        {typeof srv?.diskPercent === 'number' && srv.diskPercent >= DISK_HINT_PERCENT && (
          <p className="meter-hint">
            <strong>Platte zu {srv.diskPercent} % belegt{srv.diskPercent >= DISK_BLOCK_PERCENT ? ' – Deploys gesperrt' : ''}.</strong>{' '}
            <Link to="/server/speicher">Aufräumen</Link>
          </p>
        )}
        <div className="meter-note">
          Scanner: {q === 0 ? 'bereit, nichts in der Warteschlange' : q === 1 ? '1 Scan läuft' : `${q} Scans in der Warteschlange`}
        </div>
      </div>
    </section>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import type { ProjectDto, SystemStatusDto } from '@deployer/shared'
import { api, ApiError } from '../api.js'
import { StatusBadge } from '../components/Status.js'
import { PageHead } from '../components/PageHead.js'
import { RowMenu } from '../components/RowMenu.js'
import { IconAlert, IconPlus, IconSearch } from '../components/Icons.js'
import { useSystem } from '../components/ServerName.js'
import { useProjects, attention, isPublic, runtimeStatus, urgency } from '../lib/projects.js'
import { relativeTime, since, clockOrDay, gb, pct, shortVersion, KIND_LABEL, actorLabel, auditTone, describeAudit } from '../lib/format.js'

import { isPrototype } from '../prototype/flag.js'

type Filter = 'alle' | 'laufen' | 'aufmerksamkeit'

export function Projects() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const projects = useProjects()
  const system = useSystem()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('alle')
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'info' } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // «/» springt in die Suche (wie in vielen Werkzeugen), ausser beim Tippen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) && !t.isContentEditable) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Rückmeldung nach einer Aktion verschwindet nach ein paar Sekunden
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [notice])

  const act = useMutation({
    mutationFn: async ({ id, what }: { id: string; what: 'deploy' | 'stop' | 'start' }) => {
      if (what === 'deploy') return api.deploy(id)
      if (what === 'stop') return api.stop(id)
      return api.start(id)
    },
    onSuccess: (_r, v) => {
      const p = list.find((x) => x.id === v.id)
      const name = p?.name ?? 'Projekt'
      setNotice(v.what === 'deploy'
        ? { text: `Deploy für «${name}» gestartet – der Fortschritt steht in der Zeile.`, tone: 'info' }
        : v.what === 'stop' ? { text: `«${name}» gestoppt. Starten geht im Menü «…».`, tone: 'ok' }
        : { text: `«${name}» wird gestartet.`, tone: 'info' })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  })

  const list = projects.data?.projects ?? []
  const counts = useMemo(() => ({
    alle: list.length,
    laufen: list.filter((p) => p.status === 'running').length,
    aufmerksamkeit: list.filter((p) => attention(p)).length,
  }), [list])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return list
      .filter((p) => filter === 'alle' || (filter === 'laufen' ? p.status === 'running' : attention(p)))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.includes(q) || p.routes.some((r) => r.hostname.includes(q)))
      // Dringendes zuerst, dann nach Name
      .sort((a, b) => urgency(b) - urgency(a) || a.name.localeCompare(b.name, 'de-CH'))
  }, [list, filter, query])

  const failed = list.filter((p) => p.lastDeployment?.status === 'failed')
  const proto = isPrototype()

  return (
    <section className="page">
      <PageHead
        crumbs={[{ label: 'projekte' }]}
        title="Projekte"
        actions={
          <>
            <div className="search">
              <IconSearch />
              <input ref={searchRef} type="search" aria-label="Projekte durchsuchen (Taste /)" placeholder="Suchen …  /" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <Link className="button button-primary" to="/projekte/neu"><IconPlus /> Neues Projekt</Link>
          </>
        }
      />

      {projects.isLoading ? (
        <p className="state state-loading">Projekte werden geladen…</p>
      ) : projects.isError ? (
        <p className="state state-error" role="alert">Projekte konnten nicht geladen werden.</p>
      ) : list.length === 0 ? (
        <>
          <Stats list={list} system={system.data} />
          <div className="state state-empty section">
            <h2>Noch kein Projekt</h2>
            <p>
              Ein fertiges Image, ein Repo mit Dockerfile, eine Compose-Datei oder eine statische Seite.
              Aus dem Chat geht es über MCP auch ohne Repo.
            </p>
            <Link className="button button-primary" to="/projekte/neu"><IconPlus /> Erstes Projekt anlegen</Link>
          </div>
        </>
      ) : (
        <>
          <Stats list={list} system={system.data} />

          {failed.slice(0, 3).map((p) => (
            <FailedBanner
              key={p.id}
              p={p}
              onLog={() => navigate(`/projekte/${p.id}?tab=deployments`)}
              onRetry={() => act.mutate({ id: p.id, what: 'deploy' })}
              busy={act.isPending}
            />
          ))}
          {failed.length > 3 && (
            <p className="hint">und {failed.length - 3} weitere fehlgeschlagene Deploys – Filter «Brauchen Aufmerksamkeit».</p>
          )}
          {notice && <p role="status" className={`notice notice-${notice.tone}`}>{notice.text}</p>}
          {act.isError && (
            <p role="alert" className="error">
              {act.error instanceof ApiError && act.error.status === 409 ? 'Für dieses Projekt läuft bereits ein Deploy.' : (act.error as Error).message}
            </p>
          )}

          <div className="section">
            <div className="section-head">
              <h2>{filter === 'alle' ? 'Alle Projekte' : filter === 'laufen' ? 'Laufende Projekte' : 'Brauchen Aufmerksamkeit'}</h2>
              <div className="segmented" role="group" aria-label="Filter">
                {([
                  ['alle', 'Alle'],
                  ['laufen', 'Laufen'],
                  ['aufmerksamkeit', 'Brauchen Aufmerksamkeit'],
                ] as const).map(([k, label]) => (
                  <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                    {label} <span className="num">{counts[k]}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Prototyp «cal»: Projekte als Karten im Raster statt als Tabelle */}
            {proto ? (
              <>
                <ul className="pcards" aria-label="Projekte">
                  {shown.map((p) => (
                    <ProjectCard key={p.id} p={p} onAct={(what) => act.mutate({ id: p.id, what })} busy={act.isPending} />
                  ))}
                </ul>
                {shown.length === 0 && (
                  <p className="empty-inline">
                    {query ? <>Kein Projekt passt zu «{query}».</> : filter === 'aufmerksamkeit' ? 'Nichts zu tun – alles in Ordnung.' : 'Keine Projekte in dieser Ansicht.'}
                  </p>
                )}
              </>
            ) : (
            <div className="table-scroll">
              <table className="table projects-table">
                <thead>
                  <tr>
                    <th>Projekt</th>
                    <th>Status</th>
                    <th>Erreichbar</th>
                    <th>Security</th>
                    <th>Letzter Deploy</th>
                    <th><span className="visually-hidden">Aktionen</span></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => (
                    <ProjectRow key={p.id} p={p} onAct={(what) => act.mutate({ id: p.id, what })} busy={act.isPending} />
                  ))}
                </tbody>
              </table>
              {shown.length === 0 && (
                <p className="empty-inline">
                  {query ? <>Kein Projekt passt zu «{query}».</> : filter === 'aufmerksamkeit' ? 'Nichts zu tun – alles in Ordnung.' : 'Keine Projekte in dieser Ansicht.'}
                </p>
              )}
            </div>
            )}
          </div>
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
  const running = list.filter((p) => runtimeStatus(p).status === 'running').length
  const deploying = list.filter((p) => p.status === 'deploying').length
  const failedCount = list.filter((p) => runtimeStatus(p).status === 'failed' || p.lastDeployment?.status === 'failed').length
  const sum = (k: 'critical' | 'high' | 'medium' | 'low') => list.reduce((n, p) => n + (p.security?.open[k] ?? 0), 0)
  const crit = sum('critical')
  const high = sum('high')
  const rest = sum('medium') + sum('low')
  const worst = list.filter((p) => p.security && (crit ? p.security.open.critical : p.security.open.high) > 0)
  const whereText = worst.length === 0 ? '' : worst.length <= 2 ? `in ${worst.map((p) => p.slug).join(', ')}` : `in ${worst.length} Projekten`
  const where = whereText ? <> · <span className="truncate" title={whereText}>{whereText}</span></> : null
  const publicCount = list.filter(isPublic).length
  const srv = system?.server
  const memPct = pct(srv?.memUsedBytes, srv?.memTotalBytes)
  const diskPct = pct(srv?.diskUsedBytes, srv?.diskTotalBytes)

  return (
    <div className="stats">
      <div className="stat">
        <div className="label">Projekte</div>
        <div className="stat-value">{list.length}</div>
        <div className="stat-sub">{running} {running === 1 ? 'läuft' : 'laufen'} · {deploying} deployt · {failedCount} Deploy-Fehler</div>
      </div>
      <div className="stat">
        <div className="label">Offene Befunde</div>
        {crit > 0 ? (
          <div className="stat-value tone-bad">{crit} kritisch</div>
        ) : high > 0 ? (
          <div className="stat-value tone-warn">{high} hoch</div>
        ) : (
          <div className="stat-value">{rest > 0 ? rest : '0'}</div>
        )}
        <div className="stat-sub">
          {crit > 0 ? <>{high} hoch{where}</> : high > 0 ? <>0 kritisch{where}</> : rest > 0 ? 'nur mittel und niedrig' : 'nichts offen'}
        </div>
      </div>
      <div className="stat">
        <div className="label">Öffentlich</div>
        <div className="stat-value">{publicCount}</div>
        <div className="stat-sub">{system?.publicTunnel.configured ? 'über Cloudflare Tunnel' : 'Tunnel nicht eingerichtet'}</div>
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

/* --- Hinweis bei fehlgeschlagenem Deploy -------------------------------------------- */

function FailedBanner({ p, onLog, onRetry, busy }: { p: ProjectDto; onLog: () => void; onRetry: () => void; busy: boolean }) {
  const d = p.lastDeployment!
  const still = p.activeDeployment ? `Version ${shortVersion(p.activeDeployment.version)} läuft unverändert weiter.` : 'Es läuft keine frühere Version.'
  return (
    <div className="alert" role="alert">
      <span className="alert-icon"><IconAlert /></span>
      <div className="alert-body">
        <strong>{p.name}: {d.trigger === 'rollback' ? 'Rollback' : 'Deploy'} fehlgeschlagen</strong>
        <span>{sentence(firstLine(d.errorMessage ?? 'Ohne Fehlermeldung'))} {still}</span>
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

/* --- Tabellenzeile ------------------------------------------------------------------ */

const STEP: Record<string, { n: number; label: string }> = {
  pending: { n: 0, label: 'wartet' },
  pulling: { n: 1, label: 'Quelle holen' },
  starting: { n: 2, label: 'Starten' },
  healthchecking: { n: 3, label: 'Healthcheck' },
  active: { n: 4, label: 'Umschalten' },
}

function ProjectRow({ p, onAct, busy }: { p: ProjectDto; onAct: (what: 'deploy' | 'stop' | 'start') => void; busy: boolean }) {
  const navigate = useNavigate()
  const url = p.routes.find((r) => r.target !== 'public')?.urls[0] ?? p.routes[0]?.urls[0]
  const host = url?.replace(/^https?:\/\//, '')
  const d = p.lastDeployment
  const kind = KIND_LABEL[p.sourceType] ?? p.sourceType
  const source = p.source as { image?: string } | null
  const rt = runtimeStatus(p)
  const versionText = p.sourceType === 'image' && source?.image ? shortVersion(source.image.split('/').pop()) : shortVersion(d?.version ?? p.activeDeployment?.version)
  const deployLine = `${kind}${p.sourceType === 'files' && p.runtimeKind !== 'static' ? ` · ${KIND_LABEL[p.runtimeKind]}` : ''} · ${p.sourceType === 'image' && source?.image ? source.image : d?.version ?? p.activeDeployment?.version ?? '–'}`

  // Ganze Zeile führt zum Projekt – ausser Klicks auf Links, Knöpfe, Menü.
  const onRowClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('a, button, [role="menu"], input')) return
    if (window.getSelection()?.toString()) return
    navigate(`/projekte/${p.id}`)
  }

  return (
    <tr className="row-link" onClick={onRowClick}>
      <td>
        <div className="cell-main"><Link to={`/projekte/${p.id}`}>{p.name}</Link></div>
        {host ? <a className="cell-url" href={url} target="_blank" rel="noreferrer" title={host}>{host}</a> : <div className="cell-sub">keine Adresse</div>}
      </td>

      <td>
        <StatusBadge status={rt.status} />
        <StatusSub p={p} />
      </td>

      <td>
        <Reach p={p} className="chips" />
      </td>

      <td><SecurityCell p={p} /></td>

      <td>
        <div>{p.status === 'deploying' ? 'läuft gerade' : relativeTime(d?.startedAt)}</div>
        <div className="cell-sub mono" title={deployLine}>
          {kind}
          {p.sourceType === 'files' && p.runtimeKind !== 'static' ? ` · ${KIND_LABEL[p.runtimeKind]}` : ''}
          {' · '}
          {versionText}
        </div>
      </td>

      <td>
        <ProjectMenu p={p} url={url} onAct={onAct} busy={busy} />
      </td>
    </tr>
  )
}

/** Menü «…» eines Projekts – in der Tabellenzeile und in der Karte (Prototyp) dasselbe. */
function ProjectMenu({ p, url, onAct, busy }: { p: ProjectDto; url: string | undefined; onAct: (what: 'deploy' | 'stop' | 'start') => void; busy: boolean }) {
  const [confirmStop, setConfirmStop] = useState(false)
  return (
    <RowMenu label={`Aktionen für ${p.name}`}>
      {(close) => (
        <>
          {url && <a role="menuitem" href={url} target="_blank" rel="noreferrer" onClick={close}>Öffnen</a>}
          <Link role="menuitem" to={`/projekte/${p.id}?tab=logs`} onClick={close}>Logs</Link>
          <Link role="menuitem" to={`/projekte/${p.id}?tab=deployments`} onClick={close}>Deployments</Link>
          <div className="menu-sep" />
          <button role="menuitem" disabled={busy || p.status === 'deploying'} onClick={() => { close(); onAct('deploy') }}>Neu deployen</button>
          {p.desiredState === 'running' ? (
            confirmStop ? (
              <>
                <div className="menu-confirm">! {isPublic(p) ? 'Öffentlich erreichbar – ' : ''}die Seite ist danach offline.</div>
                <button role="menuitem" className="menu-danger" disabled={busy} onClick={() => { close(); setConfirmStop(false); onAct('stop') }}>Ja, stoppen</button>
                <button role="menuitem" onClick={() => setConfirmStop(false)}>Abbrechen</button>
              </>
            ) : (
              <button role="menuitem" disabled={busy} onClick={() => setConfirmStop(true)}>Stoppen …</button>
            )
          ) : (
            <button role="menuitem" disabled={busy} onClick={() => { close(); onAct('start') }}>Starten</button>
          )}
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
      {isPublic(p) && (
        <span className="chip chip-public">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></svg>
          Öffentlich
        </span>
      )}
      {p.routes.some((r) => (r.targets ?? [r.target]).includes('lan')) && <span className="chip">LAN</span>}
      {p.routes.some((r) => (r.targets ?? [r.target]).includes('tailnet')) && <span className="chip">Tailnet</span>}
    </div>
  )
}

/* --- Projekt-Karte (Prototyp «cal») ------------------------------------------------- */

function ProjectCard({ p, onAct, busy }: { p: ProjectDto; onAct: (what: 'deploy' | 'stop' | 'start') => void; busy: boolean }) {
  const url = p.routes.find((r) => r.target !== 'public')?.urls[0] ?? p.routes[0]?.urls[0]
  const host = url?.replace(/^https?:\/\//, '')
  const d = p.lastDeployment
  const kind = KIND_LABEL[p.sourceType] ?? p.sourceType
  const version = shortVersion(d?.version ?? p.activeDeployment?.version)
  const rt = runtimeStatus(p)
  return (
    <li className={`pcard${rt.deployFailed || rt.status === 'failed' ? ' pcard-bad' : ''}`}>
      <div className="pcard-head">
        <div className="pcard-title">
          {/* Der Name ist der Link; ::after macht die ganze Karte klickbar */}
          <h3><Link className="pcard-link" to={`/projekte/${p.id}`}>{p.name}</Link></h3>
          {host ? <span className="pcard-host" title={host}>{host}</span> : <span className="pcard-host">keine Adresse</span>}
        </div>
        <StatusBadge status={rt.status} />
      </div>

      <div className="pcard-state">
        <StatusSub p={p} />
        <Reach p={p} className="chips" />
      </div>

      <dl className="pcard-facts">
        <div>
          <dt>Security</dt>
          <dd><SecurityCell p={p} /></dd>
        </div>
        <div>
          <dt>Letzter Deploy</dt>
          <dd>
            {p.status === 'deploying' ? 'läuft gerade' : relativeTime(d?.startedAt)}
            <span className="pcard-kind">{kind} <span className="version">{version}</span></span>
          </dd>
        </div>
      </dl>

      <div className="pcard-foot">
        <div className="pcard-actions">
          {url && <a className="button button-small" href={url} target="_blank" rel="noreferrer">Öffnen</a>}
          <ProjectMenu p={p} url={url} onAct={onAct} busy={busy} />
        </div>
      </div>
    </li>
  )
}

function StatusSub({ p }: { p: ProjectDto }) {
  const d = p.lastDeployment
  if (p.status === 'deploying' && d) {
    const step = STEP[d.status] ?? { n: 0, label: d.status }
    return (
      <>
        <div className="progress" aria-label={`Schritt ${step.n} von 4`}>
          <div className="progress-track"><div className="progress-fill" style={{ width: `${(step.n / 4) * 100}%` }} /></div>
          <span className="mono">{step.n}/4</span>
        </div>
        <div className="cell-sub">{step.label}</div>
      </>
    )
  }
  if (runtimeStatus(p).deployFailed) {
    return (
      <div className="cell-sub">
        <span className="deploy-failed">✕ Deploy fehlgeschlagen</span>
        {p.activeDeployment ? ` · ${shortVersion(p.activeDeployment.version)} läuft` : ' · nichts aktiv'}
      </div>
    )
  }
  if (p.status === 'running') {
    if (p.sourceType === 'files') {
      const days = p.expiresAt ? Math.max(0, Math.ceil((new Date(p.expiresAt).getTime() - Date.now()) / 86_400_000)) : null
      return <div className="cell-sub">Chat-Projekt{p.keep ? ' · behalten' : days !== null ? ` · Ablauf in ${days} T.` : ''}</div>
    }
    return <div className="cell-sub">{since(p.activeDeployment?.finishedAt ?? p.activeDeployment?.startedAt)}</div>
  }
  if (p.status === 'stopped') return <div className="cell-sub">gestoppt</div>
  return <div className="cell-sub">noch nicht deployt</div>
}

function SecurityCell({ p }: { p: ProjectDto }) {
  const s = p.security
  if (!s || s.grade === null) {
    const note = s?.status === 'running' || s?.status === 'queued' ? 'scannt' : p.status === 'deploying' ? 'nach Deploy' : s?.status === 'failed' ? 'Scan fehlgeschlagen' : 'kein Scan'
    return <div className="grade-cell"><span className="grade grade-none" aria-hidden="true">–</span>{note}</div>
  }
  const serious = s.open.critical > 0 ? `${s.open.critical} kritisch` : s.open.high > 0 ? `${s.open.high} hoch` : null
  return (
    <div className="grade-cell" title={`Note ${s.grade}, Score ${s.score} von 100`}>
      <span className={`grade grade-${s.grade}`}>{s.grade}</span>
      {serious ? <span>{s.score} · {serious}</span> : <span>{s.score} / 100</span>}
      {(s.status === 'running' || s.status === 'queued') && <span className="muted">· scannt</span>}
    </div>
  )
}

/* --- Unterer Bereich ------------------------------------------------------------------ */

function Activity({ projects }: { projects: ProjectDto[] }) {
  const demo = import.meta.env.DEV && new URLSearchParams(window.location.search).has('demo')
  const audit = useQuery({ queryKey: ['audit', 'recent'], queryFn: () => api.audit(40), refetchInterval: 10_000, enabled: !demo })
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const events = (audit.data?.events ?? []).filter((e) => e.action !== 'auth.login').slice(0, 6)

  return (
    <section className="panel panel-pad" aria-labelledby="activity-h">
      <div className="panel-head">
        <h2 id="activity-h">Letzte Aktivität</h2>
        <Link to="/audit" className="muted">Alles im Audit-Log</Link>
      </div>
      {events.length === 0 ? (
        <p className="muted">{audit.isLoading ? 'Wird geladen…' : 'Noch nichts passiert.'}</p>
      ) : (
        <ul className="activity">
          {events.map((e) => (
            <li key={e.id}>
              <time dateTime={e.at} title={new Date(e.at).toLocaleString('de-CH')}>{clockOrDay(e.at)}</time>
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
        <Link to="/system" className="muted">System</Link>
      </div>
      <div className="meters">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="meter-head"><span>{r.label}</span><span className="mono">{r.value}</span></div>
            <div className="meter-track" role="progressbar" aria-label={r.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.p ?? undefined}>
              <div className={`meter-fill${r.p !== null && r.p >= 90 ? ' tone-bad' : r.p !== null && r.p >= 75 ? ' tone-warn' : ''}`} style={{ width: `${r.p ?? 0}%` }} />
            </div>
          </div>
        ))}
        <div className="meter-note">
          Scanner: {q === 0 ? 'bereit, nichts in der Warteschlange' : q === 1 ? '1 Scan läuft' : `${q} Scans in der Warteschlange`}
        </div>
      </div>
    </section>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { AddressRowInput, DeploymentDto, EnvEntryDto, ProjectDto, ResourceSample } from '@airlock/shared'
import { browserCanProbe, splitAddresses } from '@airlock/shared'
import { api, probeUrl } from '../api.js'
import { relativeTime, shortVersion, since } from '../lib/format.js'
import { fmtDayTime, fmtTime, msOf } from '../lib/dates.js'
import { bundle, isReadOnly } from '../lib/activity.js'
import { ActivityList } from './ActivityList.js'
import { explainDeployFailure, logTail } from '../lib/failure.js'
import { IconWarn } from './Security.js'
import { DeployList, useDeployments } from './DeployList.js'
import { SecurityCard } from './SecurityCard.js'
import { KeyFacts } from './KeyFacts.js'
import { IconBad, IconOk, IconPending } from './Icons.js'
import { EmptyState, ErrorState, Loading, PartialNote, Sk, SkLog, SkRows, errorReason } from './States.js'

type Tab = 'uebersicht' | 'deployments' | 'logs' | 'security' | 'einstellungen'

const svg = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
const IconCopy = () => <svg {...svg}><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" /></svg>
const IconCheck = () => <svg {...svg}><path d="m3.5 8.5 3 3 6-7" /></svg>

/** Läuft der Container der aktiven Fassung wirklich? (für Kopf und Übersicht) */
export function useProjectHealth(p: ProjectDto) {
  return useQuery({
    queryKey: ['health', p.id],
    queryFn: () => api.health(p.id, true),
    enabled: Boolean(p.activeDeployment) && p.desiredState === 'running',
    refetchInterval: 30_000,
  })
}

export function ProjectOverview({
  p, env, onTab, onDeploy, deploying, onRollback, onToggleKeep, keepBusy,
}: {
  p: ProjectDto
  env: EnvEntryDto[]
  onTab: (t: Tab) => void
  onDeploy: () => void
  deploying: boolean
  onRollback: (deploymentId: string) => void
  onToggleKeep: () => void
  keepBusy?: boolean
}) {
  const running = p.desiredState === 'running' && Boolean(p.activeDeployment)
  const health = useProjectHealth(p)
  const h = health.data
  const containerDown = Boolean(running && h?.container && !h.container.running)
  const deployFailed = p.lastDeployment?.status === 'failed'

  return (
    <div className="overview">
      {deployFailed && p.lastDeployment && (
        <DeployFailure p={p} dep={p.lastDeployment} stillRunning={running && !containerDown} onTab={onTab} onDeploy={onDeploy} deploying={deploying} />
      )}
      {!deployFailed && containerDown && h?.container && (
        <ContainerDown projectId={p.id} exitCode={h.container.exitCode} missing={Boolean(h.container.missing)} onTab={onTab} onDeploy={onDeploy} deploying={deploying} />
      )}

      <div className="overview-grid">
        <div className="overview-main">
          {running && !containerDown && <HealthPanel p={p} loading={health.isLoading} data={h ?? null} />}
          {!running && !deployFailed && (
            <section className="panel panel-pad ov-section">
              <h2 className="ov-title">Zustand</h2>
              <p className="muted ov-empty">
                {p.status === 'stopped' ? 'Gestoppt. Die Adressen antworten erst wieder nach «Starten».' : 'Noch nichts deployt. «Neu deployen» startet die erste Fassung.'}
              </p>
            </section>
          )}
          <DeployTimeline projectId={p.id} onTab={onTab} onRollback={onRollback} />
          <SecurityCard p={p} onTab={onTab} />
          <Activity projectId={p.id} />
        </div>

        <aside className="overview-side" aria-label="Eckdaten">
          <Addresses p={p} down={containerDown} />
          <KeyFacts p={p} env={env} health={h ?? null} onTab={onTab} onToggleKeep={onToggleKeep} keepBusy={keepBusy} />
        </aside>
      </div>
    </div>
  )
}

/* --- Fehler ---------------------------------------------------------------- */

function DeployFailure({ p, dep, stillRunning, onTab, onDeploy, deploying }: {
  p: ProjectDto; dep: DeploymentDto; stillRunning: boolean; onTab: (t: Tab) => void; onDeploy: () => void; deploying: boolean
}) {
  const d = useQuery({ queryKey: ['deployment', dep.id], queryFn: () => api.getDeployment(dep.id) })
  const log = d.data?.log ?? ''
  const f = explainDeployFailure(p, dep.errorMessage, log)
  const lines = logTail(log, 15)
  return (
    <section className="failure" role="alert" aria-labelledby="failure-title">
      <div className="failure-head">
        <span className="failure-icon"><IconBad /></span>
        <div>
          <h2 id="failure-title">{f.title}</h2>
          <p className="failure-meta">
            Deploy {relativeTime(dep.startedAt)}{dep.version ? <> · <code>{shortVersion(dep.version)}</code></> : null}
            {stillRunning ? ' · die vorherige Fassung läuft weiter' : ' · nichts läuft'}
          </p>
        </div>
      </div>
      <p className="failure-cause">{f.cause}</p>
      <div className="failure-log">
        <div className="failure-log-head">
          <span>Letzte {lines.length} Zeilen des Deploy-Logs</span>
          <button type="button" className="link-button" onClick={() => onTab('deployments')}>Ganzes Log</button>
        </div>
        {/* Teilweise: Ursache und Aktionen stehen auch ohne Log */}
        {!d.data && d.isError ? <PartialNote onRetry={() => void d.refetch()}>Das Deploy-Log ist gerade nicht abrufbar ({errorReason(d.error)})</PartialNote>
          : !d.data ? <Loading label="Log wird geladen"><SkLog n={6} /></Loading>
          : <pre className="log log-failure" aria-label="Letzte Zeilen des Deploy-Logs">{lines.join('\n') || 'Für dieses Deployment wurde kein Log gespeichert.'}</pre>}
      </div>
      <div className="failure-actions">
        <button type="button" className="button-primary" onClick={onDeploy} disabled={deploying} aria-busy={deploying || undefined}>Erneut deployen</button>
        <button type="button" onClick={() => onTab('einstellungen')}>{f.fix === 'env' ? 'Umgebungsvariablen ändern' : 'Einstellungen ändern'}</button>
      </div>
    </section>
  )
}

function ContainerDown({ projectId, exitCode, missing, onTab, onDeploy, deploying }: {
  projectId: string; exitCode: number | null; missing: boolean; onTab: (t: Tab) => void; onDeploy: () => void; deploying: boolean
}) {
  const logs = useQuery({ queryKey: ['logs-tail', projectId], queryFn: () => api.getLogs(projectId, 15), enabled: !missing, retry: false })
  const lines = logTail(logs.data?.logs ?? '', 15)
  const cause = missing
    ? 'Der Container der aktiven Fassung existiert nicht mehr – er wurde von Hand entfernt, oder der Neustart nach einem Server-Neustart ist gescheitert. Die Adressen antworten nicht. «Erneut deployen» baut ihn neu auf.'
    : exitCode === 137
    ? 'Der Container wurde beendet (Exit-Code 137) – meist, weil er mehr RAM brauchte als erlaubt. Die Grenze lässt sich unter Einstellungen erhöhen.'
    : `Der Container hat sich beendet${exitCode !== null ? ` (Exit-Code ${exitCode})` : ''}. Die Ursache steht meist in den letzten Zeilen seiner Ausgabe.`
  return (
    <section className="failure" role="alert" aria-labelledby="failure-title">
      <div className="failure-head">
        <span className="failure-icon"><IconBad /></span>
        <div><h2 id="failure-title">{missing ? 'Container fehlt' : 'Container läuft nicht'}</h2><p className="failure-meta">Der letzte Deploy war erfolgreich, der Container ist danach ausgefallen</p></div>
      </div>
      <p className="failure-cause">{cause}</p>
      {!missing && <div className="failure-log">
        <div className="failure-log-head"><span>Letzte {lines.length} Zeilen der Container-Ausgabe</span><button type="button" className="link-button" onClick={() => onTab('logs')}>Logs</button></div>
        {!logs.data && logs.isError ? <PartialNote onRetry={() => void logs.refetch()}>Die Container-Ausgabe ist gerade nicht abrufbar ({errorReason(logs.error)})</PartialNote>
          : !logs.data ? <Loading label="Ausgabe wird geladen"><SkLog n={6} /></Loading>
          : <pre className="log log-failure">{lines.join('\n') || logs.data.hint || 'Der Container hat nichts ausgegeben.'}</pre>}
      </div>}
      <div className="failure-actions">
        <button type="button" className="button-primary" onClick={onDeploy} disabled={deploying} aria-busy={deploying || undefined}>Erneut deployen</button>
        <button type="button" onClick={() => onTab('einstellungen')}>Einstellungen ändern</button>
      </div>
    </section>
  )
}

/* --- Zustand --------------------------------------------------------------- */

function fmtCpu(v: number): string {
  return v.toLocaleString('de-CH', { minimumFractionDigits: v >= 1 && Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })
}

function HealthPanel({ p, loading, data }: { p: ProjectDto; loading: boolean; data: import('@airlock/shared').ProjectHealthDto | null }) {
  const isStatic = data?.kind === 'static' || p.runtimeKind === 'static'
  const c = data?.container
  const hc = data?.health
  return (
    <section className="panel panel-pad ov-section" aria-labelledby="ov-state">
      <h2 className="ov-title" id="ov-state">Zustand</h2>
      <dl className="state-rows">
        <dt>Laufzeit</dt>
        <dd>
          {isStatic ? <span>Statische Seite, Caddy liefert sie direkt aus</span>
            : loading ? <Sk w={180} h={13} />
            : c?.startedAt ? <><strong className="state-strong">läuft {since(c.startedAt).replace(/^seit /, 'seit ')}</strong> <span className="muted">· gestartet {fmtDayTime(c.startedAt)}</span></>
            : <span className="muted">unbekannt</span>}
        </dd>

        <dt>Healthcheck</dt>
        <dd>
          {isStatic ? <span className="muted">entfällt bei statischen Seiten</span>
            : !hc ? <span className="hc hc-pending"><IconPending /> {loading ? 'Prüfung läuft' : 'noch keiner seit dem Start'}</span>
            : hc.ok ? <span className="hc hc-ok"><IconOk /> gesund <span className="hc-detail">HTTP {hc.status} auf {hc.url} · {hc.ms} ms · {relativeTime(hc.at).replace('gerade eben', 'eben')}</span></span>
            : <span className="hc hc-bad"><IconBad /> antwortet nicht <span className="hc-detail">{hc.error} · {hc.url} · {relativeTime(hc.at)}</span></span>}
        </dd>
      </dl>
      {!isStatic && (
        <div className="ov-meters">
          <Meter label="CPU" unit="CPU" limit={p.cpuLimit} samples={data?.samples ?? []} pick={(s) => s.cpu} fmt={fmtCpu} />
          <Meter label="RAM" unit="MB" limit={p.memoryLimitMb} samples={data?.samples ?? []} pick={(s) => s.memMb} fmt={(v) => Math.round(v).toLocaleString('de-CH')} />
        </div>
      )}
    </section>
  )
}

/**
 * Verlauf der letzten Stunde gegen die Grenze: die Grenze ist die Oberkante,
 * so sieht man sofort, wie viel Luft bleibt. Ein Wert pro Minute.
 */
export function Meter({ label, unit, limit, samples: all, pick, fmt }: {
  label: string; unit: string; limit: number; samples: ResourceSample[]; pick: (s: ResourceSample) => number; fmt: (v: number) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  // Messpunkte mit ungültiger Zeit fallen weg, statt die Linie zu zerreissen
  const samples = all.filter((s) => msOf(s.at) !== null)
  const W = 300
  const H = 56
  const values = samples.map(pick)
  const now = values.at(-1) ?? null
  const peak = values.length ? Math.max(...values) : null
  const ratio = now !== null && limit ? now / limit : 0
  const tone = ratio >= 0.9 ? 'bad' : ratio >= 0.7 ? 'warn' : 'ok'
  // Zeitachse: 60 Minuten, rechts ist jetzt
  const t0 = Date.now() - 60 * 60_000
  const x = (t: number) => Math.max(0, Math.min(W, ((t - t0) / (60 * 60_000)) * W))
  const y = (v: number) => H - Math.min(1, v / limit) * (H - 2) - 1
  // Messpunkte mit ungültiger Zeit fallen weg statt die Linie zu zerreissen
  const pts = samples.map((s) => [x(msOf(s.at)!), y(pick(s))] as const)
  const line = pts.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}`).join(' ')
  const area = pts.length ? `${line} L${pts.at(-1)![0].toFixed(1)},${H} L${pts[0]![0].toFixed(1)},${H} Z` : ''
  const hv = hover !== null ? samples[hover] : null

  return (
    <figure className={`ov-meter ov-meter-${tone}`}>
      <figcaption className="ov-meter-head">
        <span className="ov-meter-label">{label}</span>
        <span className="ov-meter-value">
          {now === null ? <span className="muted">noch kein Wert</span> : <><strong>{fmt(now)}</strong> <span className="muted">von {fmt(limit)} {unit}</span></>}
        </span>
      </figcaption>
      <div className="ov-meter-plot">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={now === null ? `${label}: noch keine Messung` : `${label} letzte Stunde: jetzt ${fmt(now)} von ${fmt(limit)} ${unit}, Spitze ${fmt(peak!)}`}
          onMouseMove={(e) => {
            if (!pts.length) return
            const r = e.currentTarget.getBoundingClientRect()
            const mx = ((e.clientX - r.left) / r.width) * W
            let best = 0
            pts.forEach(([a], i) => { if (Math.abs(a - mx) < Math.abs(pts[best]![0] - mx)) best = i })
            setHover(best)
          }}
          onMouseLeave={() => setHover(null)}
        >
          <line x1="0" x2={W} y1="1" y2="1" className="ov-meter-limit" vectorEffect="non-scaling-stroke" />
          <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} className="ov-meter-base" vectorEffect="non-scaling-stroke" />
          {area && <path d={area} className="ov-meter-area" />}
          {pts.length > 1 && <path d={line} className="ov-meter-line" vectorEffect="non-scaling-stroke" />}
          {hv && <line x1={pts[hover!]![0]} x2={pts[hover!]![0]} y1="0" y2={H} className="ov-meter-cross" vectorEffect="non-scaling-stroke" />}
        </svg>
        {pts.length === 1 && <span className="ov-meter-dot" style={{ left: `${(pts[0]![0] / W) * 100}%`, top: `${(pts[0]![1] / H) * 100}%` }} aria-hidden="true" />}
        {hv && (
          <span className="ov-meter-tip" style={{ left: `${(pts[hover!]![0] / W) * 100}%` }}>
            {fmtTime(hv.at)} · {fmt(pick(hv))} {unit}
          </span>
        )}
      </div>
      <div className="ov-meter-foot">
        <span>vor 60 Min.</span>
        <span>{peak !== null ? <>Spitze {fmt(peak)} {unit}</> : `Grenze ${fmt(limit)} ${unit}`}</span>
        <span>jetzt</span>
      </div>
    </figure>
  )
}

/* --- Deployments ------------------------------------------------------------ */

function DeployTimeline({ projectId, onTab, onRollback }: { projectId: string; onTab: (t: Tab) => void; onRollback: (id: string) => void }) {
  const list = useDeployments(projectId)
  const rows = list.data?.deployments ?? []
  const total = rows[0]?.seq ?? rows.length

  return (
    <section className="panel panel-pad ov-section" aria-labelledby="ov-deploys">
      <div className="ov-head">
        <h2 className="ov-title" id="ov-deploys">Deployments</h2>
        {total > 0 && <button type="button" className="link-button" onClick={() => onTab('deployments')}>Alle {total}</button>}
      </div>
      {!list.data && list.isError ? <ErrorState compact plural what="Die Deployments" error={list.error} retrying={list.isFetching} onRetry={() => void list.refetch()} />
        : !list.data ? <Loading label="Deployments werden geladen"><SkRows n={3} card={false} /></Loading>
        : rows.length === 0 ? <EmptyState compact title="Noch kein Deployment.">Das erste startet nach dem Anlegen von selbst.</EmptyState> : (
        <DeployList projectId={projectId} rows={rows} limit={5} onRollback={onRollback} />
      )}
    </section>
  )
}

/* --- Security ---------------------------------------------------------------- */

/* --- Aktivität ---------------------------------------------------------------- */

/** Höchstens so viele Einträge in der Karte */
const ACTIVITY_SHOWN = 5

function Activity({ projectId }: { projectId: string }) {
  const a = useQuery({ queryKey: ['audit-project', projectId], queryFn: () => api.audit(60, projectId), refetchInterval: 15_000 })
  const items = useMemo(() => bundle((a.data?.events ?? []).filter((e) => !isReadOnly(e))), [a.data])
  const shown = items.slice(0, ACTIVITY_SHOWN)
  const more = items.length - shown.length
  return (
    <section className="panel panel-pad ov-section" aria-labelledby="ov-act">
      <div className="ov-head">
        <h2 className="ov-title" id="ov-act">Aktivität</h2>
        <Link to="/audit">Audit-Log</Link>
      </div>
      {!a.data && a.isError ? <ErrorState compact what="Die Aktivität" error={a.error} retrying={a.isFetching} onRetry={() => void a.refetch()} />
        : !a.data ? <Loading label="Aktivität wird geladen"><SkRows n={3} card={false} /></Loading>
        : <ActivityList items={shown} />}
      {more > 0 && (
        <p className="act-more">
          {a.data && a.data.events.length >= 60 ? 'Weitere Ereignisse' : `Weitere ${more} ${more === 1 ? 'Ereignis' : 'Ereignisse'}`} · <Link to={`/audit?projekt=${projectId}`}>Alle anzeigen</Link>
        </p>
      )}
    </section>
  )
}

/* --- Adressen ------------------------------------------------------------------- */

const WAY_LABEL: Record<string, string> = { lan: 'LAN', tailnet: 'Tailnet', public: 'Öffentlich' }

function Addresses({ p, down }: { p: ProjectDto; down: boolean }) {
  const { primary, more } = splitAddresses(p.routes)
  const live = p.desiredState === 'running' && Boolean(p.activeDeployment) && !down
  const idle = down ? 'antwortet nicht' : 'nicht aktiv'
  const row = (r: AddressRowInput) => <AddressRow key={r.url} projectId={p.id} url={r.url} ways={r.ways} access={r.access} live={live} idle={idle} />
  const viaServer = live && [...primary, ...more].some((r) => !browserCanProbe(r.url, window.location.protocol))
  return (
    <section className="panel panel-pad ov-section" aria-labelledby="ov-addr">
      <h2 className="ov-title" id="ov-addr">Adressen</h2>
      {primary.length === 0 && more.length === 0 ? <p className="muted ov-empty">Keine. Unter Einstellungen → Erreichbarkeit festlegen.</p> : (
        <ul className="addr-list">{primary.map(row)}</ul>
      )}
      {more.length > 0 && (
        <details className="addr-more">
          <summary>Weitere Adressen ({more.length})</summary>
          <p className="hint">nip.io-Namen ohne Zertifikat, für Geräte ohne passenden DNS.</p>
          <ul className="addr-list">{more.map(row)}</ul>
        </details>
      )}
      {primary.length + more.length > 0 && live && (
        <p className="ov-foot">{viaServer ? 'https-Adressen geprüft von diesem Gerät aus, http-Adressen vom Server aus.' : 'Geprüft von diesem Gerät aus.'}</p>
      )}
    </section>
  )
}

type AddrState = 'idle' | 'checking' | 'ok' | 'bad' | 'routed' | 'unchecked'

function AddressRow({ projectId, url, ways, access, live, idle }: { projectId: string; url: string; ways: string[]; access: boolean; live: boolean; idle: string }) {
  const [state, setState] = useState<AddrState>('idle')
  const [detail, setDetail] = useState('')
  const [copied, setCopied] = useState(false)
  // Auf einer https-Seite blockiert der Browser http-Adressen (Mixed Content):
  // dann prüft der Server über Caddy, und das steht dabei.
  const byServer = !browserCanProbe(url, window.location.protocol)
  const check = () => {
    setState('checking')
    if (!byServer) {
      void probeUrl(url).then((ok) => { setDetail(''); setState(ok ? 'ok' : 'bad') })
      return
    }
    api.addressCheck(projectId, url).then((r) => {
      setDetail(r.detail)
      setState(r.state === 'ok' ? 'ok' : r.state === 'routed' ? 'routed' : r.state === 'error' ? 'unchecked' : 'bad')
    }).catch((err: Error) => {
      setDetail(err.message)
      setState('unchecked')
    })
  }
  useEffect(() => {
    if (live) check()
    else setState('idle')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, live])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ohne Zwischenablage (http) bleibt die Adresse markierbar */ }
  }
  const host = url.replace(/^https?:\/\//, '')
  return (
    <li className="addr">
      <div className="addr-top">
        <a className="addr-url" href={url} target="_blank" rel="noreferrer" title={url}>{host}</a>
        <button type="button" className="icon-button" onClick={copy} aria-label={copied ? 'Kopiert' : `${host} kopieren`} title={copied ? 'Kopiert' : 'Kopieren'}>
          {copied ? <IconCheck /> : <IconCopy />}
        </button>
      </div>
      <div className="addr-bottom">
        <span className="addr-ways">{ways.map((w) => WAY_LABEL[w] ?? w).join(' · ')}{access ? ' · Cloudflare Access' : ''}</span>
        {!live ? <span className={idle === 'antwortet nicht' ? 'addr-state addr-bad' : 'addr-state addr-idle'}>{idle === 'antwortet nicht' && <IconBad />}{idle}</span>
          : state === 'checking' ? <span className="addr-state addr-checking"><IconPending /> prüft…</span>
          : state === 'ok' ? <span className="addr-state addr-ok" title={detail || undefined}><IconOk /> erreichbar{byServer ? ' · vom Server geprüft' : ''}</span>
          : state === 'routed' ? <span className="addr-state addr-ok" title={detail}><IconOk /> Route aktiv · vom Server geprüft</span>
          : state === 'unchecked' ? <button type="button" className="addr-state addr-idle link-button" onClick={check} title={`${detail} Nochmals prüfen.`}><IconPending /> nicht vom Browser prüfbar (http)</button>
          : state === 'bad' ? <button type="button" className="addr-state addr-bad link-button" onClick={check} title={detail ? `${detail} Nochmals prüfen.` : 'Nochmals prüfen'}><IconBad /> nicht erreichbar{byServer ? ' · vom Server geprüft' : ''}</button>
          : null}
      </div>
    </li>
  )
}


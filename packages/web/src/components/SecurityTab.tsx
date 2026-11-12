import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { api, type ScanHistoryItemDto, type ScanReportDto } from '../api.js'
import { poll } from '../lib/live.js'
import { relativeTime } from '../lib/format.js'
import { fmtDateTimeShort } from '../lib/dates.js'
import {
  CHIP_STATE_LABEL, headerStates, situation, sparkPoints, stageChips,
  type ChipState, type StageChip,
} from '../lib/security-view.js'
import { brokenStageNames, LiveScan, runFor, scanTime, StageList, TRIGGER, useNow } from './Security.js'
import { FindingsView } from './SecurityFindings.js'
import { HeaderCspView, useHeaderRules } from './HeaderFix.js'
import { useFixRequests } from './ClaudeFix.js'
import { ErrorState, Loading, PartialNote, SkLines, SkRows, SkStats } from './States.js'
import { IconAlert, IconBad, IconOk, IconPending, IconSkipped, IconWarn } from './Icons.js'
import { InlineConfirm } from './Confirm.js'

/**
 * Reiter «Security» am Projekt: oben die Zusammenfassung (Note, Lage in
 * einem Satz, Scan starten, Prüfstufen), darunter die Unternavigation
 * Befunde · Header & CSP · Prüfungen · Verlauf (in der Adresse: ?ansicht=…).
 */

export type SecView = 'befunde' | 'header' | 'pruefungen' | 'verlauf'
const VIEWS: { key: SecView; label: string }[] = [
  { key: 'befunde', label: 'Befunde' },
  { key: 'header', label: 'Header & CSP' },
  { key: 'pruefungen', label: 'Prüfungen' },
  { key: 'verlauf', label: 'Verlauf' },
]
const isView = (v: string | null): v is SecView => VIEWS.some((x) => x.key === v)

/** Element erscheint nach dem Wechsel der Ansicht: bis zu 2 s warten, dann ansteuern */
function whenThere(id: string, then: (el: HTMLElement) => void, tries = 20) {
  const el = document.getElementById(id)
  if (el) then(el)
  else if (tries > 0) setTimeout(() => whenThere(id, then, tries - 1), 100)
}
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function ProjectSecurity({ projectId, sourceType }: { projectId: string; sourceType?: string }) {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const raw = params.get('ansicht')
  const view: SecView = isView(raw) ? raw : 'befunde'
  const setView = (v: SecView) => setParams((prev) => {
    const n = new URLSearchParams(prev)
    if (v === 'befunde') n.delete('ansicht')
    else n.set('ansicht', v)
    return n
  })

  const q = useQuery({
    queryKey: ['scan', projectId],
    queryFn: () => api.latestScan(projectId),
    // Fortschritt kommt über den Ereignisstrom; ohne ihn alle 60 s (UI-Qualität 3)
    refetchInterval: (query) => {
      const st = query.state.data?.report?.scan.status
      return st === 'queued' || st === 'running' ? poll() : false
    },
  })
  const latest = q.data?.report ?? null
  const running = Boolean(latest && (latest.scan.status === 'queued' || latest.scan.status === 'running'))
  // Läuft ein Scan, bleibt der letzte fertige sichtbar
  const done = useQuery({
    queryKey: ['scan', projectId, 'done'],
    queryFn: () => api.latestScan(projectId, true),
    enabled: running,
  })
  const finished = running ? done.data?.report ?? null : latest
  const rules = useHeaderRules(projectId)
  const fixesQ = useFixRequests(projectId)
  const fixes = fixesQ.data?.fixes ?? []

  // Meldungen der Abläufe (Header gesetzt, Vorschlag übernommen) unter der Zusammenfassung.
  // Erst leeren, dann setzen: auch eine gleichlautende Meldung wird angesagt.
  const [fixNotice, setFixNotice] = useState<string | null>(null)
  const noticeRef = useRef<HTMLDivElement>(null)
  const showFixNotice = (msg: string) => {
    setFixNotice(null)
    setTimeout(() => {
      setFixNotice(msg)
      requestAnimationFrame(() => noticeRef.current?.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' }))
    }, 50)
  }
  // Nach «Auftrag kopieren»: öfter nach neuen Vorschlägen von Claude sehen
  const [watchFixes, setWatchFixes] = useState(false)
  useEffect(() => {
    if (!watchFixes) return
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: ['fix-requests', projectId] }), 10_000)
    const stop = setTimeout(() => setWatchFixes(false), 10 * 60_000)
    return () => { clearInterval(t); clearTimeout(stop) }
  }, [watchFixes, qc, projectId])

  const [toolFilter, setToolFilter] = useState<string | null>(null)
  const [stageTarget, setStageTarget] = useState<string | null>(null)
  const refreshScan = () => void qc.invalidateQueries({ queryKey: ['scan', projectId] })

  const openStage = (key: string) => {
    setStageTarget(key)
    setView('pruefungen')
    whenThere(`stufe-${key}`, (el) => {
      el.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' })
      el.focus({ preventScroll: true })
    })
  }
  const openCsp = () => {
    setView('header')
    whenThere('header-caddy-csp-title', (el) => {
      el.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' })
      el.focus({ preventScroll: true })
    })
  }
  const showTool = (tool: string) => {
    setToolFilter(tool)
    setView('befunde')
  }

  if (!q.data && q.isError) return <div className="tab-panel"><ErrorState what="Der Scan-Bericht" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} /></div>
  if (!q.data) return <div className="tab-panel"><Loading label="Scan-Bericht wird geladen"><SkStats n={3} /><SkRows n={4} /></Loading></div>

  const open = finished?.findings.filter((f) => f.status === 'open') ?? []
  const observed = finished?.scan.stages.headers?.observed ?? null
  const missingHeaders = rules.data && finished ? headerStates({ rules: rules.data, observed, findings: finished.findings }).filter((s) => s.state === 'missing').length : null
  const broken = finished && finished.scan.status !== 'failed' ? brokenStageNames(finished.scan) : []

  return (
    <div className="tab-panel sec">
      <Summary projectId={projectId} report={finished} running={running ? latest : null} fixes={fixes} onStage={openStage} onStarted={refreshScan} />
      {running && latest && <LiveScan report={latest} onCancelled={refreshScan} />}
      {broken.length > 0 && (
        <PartialNote>
          {broken.length === 1 ? <>Die Stufe «{broken[0]}» ist gescheitert.</> : <>{broken.length} Stufen sind gescheitert ({broken.join(', ')}).</>}
          {' '}Alle übrigen Ergebnisse sind vollständig. Der Grund steht unter «Prüfungen».
        </PartialNote>
      )}
      <div ref={noticeRef} role="status" aria-live="polite" className="fix-live">{fixNotice && <p className="fix-notice">{fixNotice}</p>}</div>
      {finished && (
        <>
          <SubNav view={view} onView={setView} counts={{ befunde: open.length, header: missingHeaders ?? undefined }} />
          <div className="sec-view" role="tabpanel" id="sec-panel" aria-labelledby={`sec-tab-${view}`}>
            {view === 'befunde' && (
              <FindingsView
                projectId={projectId} sourceType={sourceType} findings={finished.findings} fixes={fixes} rules={rules.data}
                toolFilter={toolFilter} onClearTool={() => setToolFilter(null)}
                onAccepted={refreshScan} onFixDone={showFixNotice} onCopied={() => setWatchFixes(true)} onOpenCsp={openCsp}
              />
            )}
            {view === 'header' && <HeaderCspView projectId={projectId} findings={finished.findings} observed={observed} />}
            {view === 'pruefungen' && <ChecksView report={finished} highlight={stageTarget} onTool={showTool} toolFilter={toolFilter} />}
            {view === 'verlauf' && <HistoryView projectId={projectId} />}
          </div>
        </>
      )}
    </div>
  )
}

/* --- Zusammenfassung ---------------------------------------------------------------- */

const TRIGGER_AFTER: Record<string, string> = { deploy: 'nach Deploy', mcp: 'über MCP', manual: 'manuell', schedule: 'nach Zeitplan' }

const CHIP_ICON: Record<ChipState, ReactNode> = {
  bad: <IconBad size={14} />, warn: <IconWarn size={14} />, ok: <IconOk size={14} />, skip: <IconSkipped size={14} />,
  running: <IconPending size={14} />, waiting: <IconPending size={14} />, failed: <IconAlert size={14} />,
}

function Summary({ projectId, report, running, fixes, onStage, onStarted }: {
  projectId: string
  report: ScanReportDto | null
  /** Laufender Scan (der Bericht ist dann der letzte fertige) */
  running: ScanReportDto | null
  fixes: Parameters<typeof situation>[1]
  onStage: (key: string) => void
  onStarted: () => void
}) {
  const [confirmActive, setConfirmActive] = useState(false)
  const start = useMutation({
    mutationFn: (level: 'standard' | 'active') => api.startScan(projectId, level),
    onSuccess: () => { setConfirmActive(false); onStarted() },
  })
  const now = useNow(Boolean(running))
  const s = report?.scan
  const failed = s && (s.status === 'failed' || s.status === 'cancelled')
  const open = report?.findings.filter((f) => f.status === 'open') ?? []
  const lage = !report
    ? { headline: running ? 'Der erste Scan läuft.' : 'Noch kein Scan.', detail: 'Nach jedem Deploy läuft einer automatisch.', tone: 'ok' as const }
    : failed
      ? { headline: s.status === 'failed' ? 'Der letzte Scan ist gescheitert.' : 'Der letzte Scan wurde abgebrochen.', detail: s.error, tone: 'bad' as const }
      : situation(open, fixes)
  const grade = s?.grade ?? null
  const score = s?.score ?? null
  const prev = s?.previousScore ?? null
  const diff = score !== null && prev !== null ? score - prev : null
  const chips = s ? stageChips(s.stages, open) : []
  const t = s ? scanTime(s) : null

  return (
    <section className="panel sec-summary" aria-labelledby="sec-summary-title">
      <div className="sec-summary-top">
        <div className="sec-score">
          <span className={`sec-grade ${grade ? `grade-${grade}` : 'grade-none'}`} aria-hidden="true">{grade ?? '–'}</span>
          <div className="sec-score-text">
            {score !== null ? (
              <>
                <p className="sec-points"><span className="visually-hidden">Note {grade}, </span><strong>{score}</strong> / 100<span className="visually-hidden"> Punkte</span></p>
                <p className="sec-delta">
                  {prev === null ? 'erster Scan' : <>vorher {prev}{diff !== 0 && diff !== null && <> · {Math.abs(diff)} {Math.abs(diff) === 1 ? 'Punkt' : 'Punkte'} {diff < 0 ? 'weniger' : 'mehr'}</>}{diff === 0 && ' · unverändert'}</>}
                </p>
              </>
            ) : <p className="sec-points sec-points-none">noch keine Note</p>}
          </div>
        </div>
        <div className={`sec-say tone-${lage.tone}`}>
          <h2 id="sec-summary-title" className="sec-headline">{lage.headline}</h2>
          {lage.detail && <p>{lage.detail}</p>}
        </div>
        <div className="sec-scan-actions">
          {!confirmActive ? (
            <>
              <button type="button" onClick={() => start.mutate('standard')} disabled={start.isPending || Boolean(running)} aria-busy={(start.isPending && start.variables === 'standard') || undefined}>
                {running ? 'Scan läuft …' : 'Jetzt scannen'}
              </button>
              <button type="button" className="button-ghost" onClick={() => setConfirmActive(true)} disabled={Boolean(running)}>
                Aktiver Scan …
              </button>
            </>
          ) : (
            <InlineConfirm label="Aktiven Scan bestätigen" small confirmLabel="Ja, aktiv angreifen" disabled={start.isPending} focus="cancel"
              className="sec-active-confirm"
              note={<><strong>Aktiver Scan</strong> greift die App mit OWASP ZAP aktiv an (XSS, SQL-Injection) und kann dabei Daten anlegen oder ändern. Nur der interne Container, nie über das Internet.</>}
              onCancel={() => setConfirmActive(false)} onConfirm={() => start.mutate('active')} />
          )}
        </div>
      </div>
      {s && (
        <div className="sec-summary-stages">
          <span className="sec-stages-label" id="sec-stages-label">Prüfungen</span>
          <ul className="sec-chips" aria-labelledby="sec-stages-label">
            {chips.map((c) => <li key={c.key}><StageChipButton c={c} onClick={() => onStage(c.key)} /></li>)}
          </ul>
          <p className="sec-meta">
            {running
              ? <>Neuer Scan läuft seit {runFor(running.scan.startedAt, now)}</>
              : <>Letzter Scan {t!.rel}{s.trigger && <> · {TRIGGER_AFTER[s.trigger] ?? s.trigger}</>}{t!.took && <> · {t!.took}</>}{s.level === 'active' && <> · aktiver Scan</>}</>}
          </p>
        </div>
      )}
    </section>
  )
}

function StageChipButton({ c, onClick }: { c: StageChip; onClick: () => void }) {
  return (
    // Name = sichtbarer Text («Image 3») plus Zustand für Screenreader
    <button type="button" className={`sec-chip sec-chip-${c.state}`} onClick={onClick}>
      <span className="sec-chip-icon" aria-hidden="true">{CHIP_ICON[c.state]}</span>
      <span>{c.label}</span>
      {c.count > 0 && <span className="sec-chip-n">{c.count}</span>}
      <span className="visually-hidden">{c.count > 0 ? ` ${c.count === 1 ? 'offener Befund' : 'offene Befunde'}${c.state === 'bad' ? ', kritisch oder hoch' : ''}` : `, ${CHIP_STATE_LABEL[c.state]}`} – in den Prüfungen zeigen</span>
    </button>
  )
}

/* --- Unternavigation ---------------------------------------------------------------- */

function SubNav({ view, onView, counts }: { view: SecView; onView: (v: SecView) => void; counts: Partial<Record<SecView, number>> }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = VIEWS.findIndex((v) => v.key === view)
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? VIEWS.length - 1 : null
    if (to === null) return
    e.preventDefault()
    const next = VIEWS[(to + VIEWS.length) % VIEWS.length]!.key
    onView(next)
    refs.current[next]?.focus()
  }
  return (
    <div className="sec-subnav segmented" role="tablist" aria-label="Security-Ansicht" onKeyDown={onKey}>
      {VIEWS.map((v) => (
        <button key={v.key} ref={(el) => { refs.current[v.key] = el }} type="button" role="tab" id={`sec-tab-${v.key}`}
          aria-selected={view === v.key} aria-controls="sec-panel" tabIndex={view === v.key ? 0 : -1} onClick={() => onView(v.key)}>
          {v.label}{counts[v.key] ? <span className="num">{counts[v.key]}</span> : null}
        </button>
      ))}
    </div>
  )
}

/* --- Prüfungen ------------------------------------------------------------------------ */

function ChecksView({ report, highlight, onTool, toolFilter }: { report: ScanReportDto; highlight: string | null; onTool: (tool: string) => void; toolFilter: string | null }) {
  const s = report.scan
  const t = scanTime(s)
  const open = report.findings.filter((f) => f.status === 'open')
  return (
    <section className="panel sec-card" aria-labelledby="sec-checks-title">
      <div className="sec-card-head">
        <h2 id="sec-checks-title" className="sec-card-title">Prüfungen</h2>
        <p className="sec-card-sub">
          {t.abs}{t.took && <> · Dauer {t.took}</>}{s.trigger && <> · {TRIGGER[s.trigger] ?? s.trigger}</>}{s.level === 'active' && <> · aktiver Scan</>}
          {s.nextScheduledAt && <> · nächster automatischer Scan {fmtDateTimeShort(s.nextScheduledAt)}</>}
        </p>
      </div>
      {s.status === 'failed' && <p className="error-inline">Scan fehlgeschlagen: {s.error}</p>}
      {s.status === 'cancelled' && <p className="muted">Scan abgebrochen: {s.error}</p>}
      <StageList stages={s.stages} now={Date.now()} open={open} onTool={onTool} toolFilter={toolFilter} idPrefix="stufe-" highlight={highlight} />
    </section>
  )
}

/* --- Verlauf --------------------------------------------------------------------------- */

function HistoryView({ projectId }: { projectId: string }) {
  const q = useQuery({ queryKey: ['scan-history', projectId], queryFn: () => api.scanHistory(projectId) })
  if (!q.data && q.isError) return <ErrorState what="Der Verlauf" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
  if (!q.data) return <Loading label="Verlauf wird geladen"><SkLines n={6} /></Loading>
  const scans = q.data.scans
  const scored = [...scans].reverse().filter((x) => x.status === 'done' && x.score !== null)
  return (
    <section className="panel sec-card" aria-labelledby="sec-history-title">
      <div className="sec-card-head sec-history-head">
        <div>
          <h2 id="sec-history-title" className="sec-card-title">Verlauf</h2>
          <p className="sec-card-sub">Punkte je abgeschlossenem Scan, älteste links. Die letzten {scans.length} Scans.</p>
        </div>
        {scored.length > 1 && <Spark scans={scored} />}
      </div>
      <div className="table-scroll sec-table-scroll">
        <table className="table sec-history">
          <thead><tr><th scope="col">Datum</th><th scope="col">Auslöser</th><th scope="col">Note</th><th scope="col">Befunde</th></tr></thead>
          <tbody>
            {scans.map((x) => (
              <tr key={x.id}>
                <td>{fmtDateTimeShort(x.startedAt)} <span className="muted">· {relativeTime(x.startedAt)}</span></td>
                <td>{x.trigger ? TRIGGER[x.trigger] ?? x.trigger : '–'}{x.level === 'active' && <span className="muted"> · aktiv</span>}</td>
                <td><HistoryGrade x={x} /></td>
                <td><HistoryDelta x={x} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

const STATUS_WORD: Record<string, string> = { queued: 'wartet', running: 'läuft', failed: 'gescheitert', cancelled: 'abgebrochen' }

function HistoryGrade({ x }: { x: ScanHistoryItemDto }) {
  if (x.status !== 'done' || x.grade === null) return <span className="muted">{STATUS_WORD[x.status] ?? '–'}</span>
  return <span className="sec-hgrade"><span className={`grade grade-${x.grade}`}>{x.grade}</span>{x.score} / 100</span>
}

function HistoryDelta({ x }: { x: ScanHistoryItemDto }) {
  if (x.newCount === null || x.fixedCount === null) return <span className="muted">{x.status === 'done' ? 'erster Scan' : '–'}</span>
  if (!x.newCount && !x.fixedCount) return <span className="muted">keine Änderung</span>
  return (
    <span className="sec-hdelta">
      {x.newCount > 0 && <span className="tone-warn">{x.newCount} neu</span>}
      {x.newCount > 0 && x.fixedCount > 0 && <span className="muted"> · </span>}
      {x.fixedCount > 0 && <span className="tone-ok">{x.fixedCount} behoben</span>}
    </span>
  )
}

/** Kleine Kurve der Punkte; Werte stehen im Namen (Screenreader) und als Endpunkte daneben */
function Spark({ scans }: { scans: ScanHistoryItemDto[] }) {
  const W = 220, H = 56
  const pts = sparkPoints(scans.map((x) => x.score), W, H, 5)
  const last = pts.at(-1)!
  return (
    <figure className="sec-spark">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`Punkte der letzten ${pts.length} Scans, älteste zuerst: ${pts.map((p) => p.v).join(', ')}`}>
        <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="sec-spark-mid" />
        <polyline points={pts.map((p) => `${p.x},${p.y}`).join(' ')} className="sec-spark-line" />
        {pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={i === pts.length - 1 ? 3.5 : 2} className={i === pts.length - 1 ? 'sec-spark-now' : 'sec-spark-dot'} />)}
      </svg>
      <figcaption><span className="muted">zuerst {pts[0]!.v}</span> <strong>jetzt {last.v}</strong></figcaption>
    </figure>
  )
}

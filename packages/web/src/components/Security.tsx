import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ScanReportDto, type FindingDto } from '../api.js'
import { acceptFindingSchema, SCAN_STAGE_LABEL, type ScanStageDto } from '@airlock/shared'
import { useFormErrors } from '../lib/form.js'
import { FieldError } from './Field.js'
import { relativeTime, duration } from '../lib/format.js'
import { ageMs, fmtDateTimeShort, fmtTime, spanMs } from '../lib/dates.js'
import { EmptyState, ErrorState, Loading, PartialNote, SkRows, SkStats } from './States.js'
import { IconBad, IconPending, IconSkipped } from './Icons.js'
import { HeaderFixAction, HeaderRulesSection, useHeaderRules } from './HeaderFix.js'
import { ClaudeFixAction, FixRequestsSection } from './ClaudeFix.js'

/**
 * Ergebnis eines Scans: Note, Score, offene Befunde, Stufen, Zeit. Wird am
 * Projekt und bei externen Zielen benutzt. Schweregrad steht immer als Wort
 * da; Farbe kommt nur dazu, wenn es etwas zu melden gibt.
 */

type Sev = FindingDto['severity']
const SEVERITIES: Sev[] = ['critical', 'high', 'medium', 'low']
export const SEVERITY_LABEL: Record<Sev, string> = { critical: 'kritisch', high: 'hoch', medium: 'mittel', low: 'niedrig' }

// Einheitliche Stufennamen (shared), gleich in Karte, Reiter, Fortschritt und MCP
const STAGE_LABEL = SCAN_STAGE_LABEL
/** Welches Werkzeug die Befunde einer Stufe liefert */
const STAGE_TOOL: [RegExp, string][] = [[/^trivy-/, 'trivy'], [/^headers$/, 'header-check'], [/^zap-/, 'zap'], [/^nuclei$/, 'nuclei'], [/^testssl$/, 'testssl']]
/** Reihenfolge wie in der Pipeline */
const ORDER = ['trivy-image', 'trivy-source', 'headers', 'zap-baseline', 'zap-full', 'nuclei', 'testssl']
const stageOrder = (k: string) => { const i = ORDER.indexOf(k.split(' ')[0]!); return i < 0 ? 99 : i }
const toolOf = (stage: string) => STAGE_TOOL.find(([re]) => re.test(stage))?.[1] ?? stage
const TOOL_LABEL: Record<string, string> = { trivy: 'Trivy', 'header-check': 'Header-Check', zap: 'OWASP ZAP', nuclei: 'Nuclei', testssl: 'testssl.sh' }

/* --- Icons der Stufen (Linien, 16 px, wie die übrigen) --- */
const svg = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
const IconClean = () => <svg {...svg}><circle cx="8" cy="8" r="6.2" /><path d="m5.3 8.2 1.9 1.9 3.5-3.7" /></svg>
const IconFound = () => <svg {...svg}><circle cx="8" cy="8" r="6.2" /><path d="M8 4.8v3.7M8 11v.1" /></svg>
// Gleich gezeichnet wie in Icons.tsx: dort nur einmal
const IconFailed = IconBad
const IconWaiting = IconPending
const IconRunning = () => <svg {...svg}><circle cx="8" cy="8" r="6.2" opacity=".35" /><path d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2" /></svg>
const IconTimeout = () => <svg {...svg}><circle cx="8" cy="8" r="6.2" /><path d="M8 4.8V8l2.2 1.6" /></svg>
export const IconWarn = () => <svg {...svg}><path d="M7.1 2.6 1.6 12.2a1 1 0 0 0 .9 1.5h11a1 1 0 0 0 .9-1.5L8.9 2.6a1 1 0 0 0-1.8 0Z" /><path d="M8 6.2v3.1M8 11.4v.1" /></svg>

/** Note und Score auf einer Linie: «A  90 / 100» */
export function GradeBadge({ grade, score }: { grade: string | null; score: number | null }) {
  if (!grade || score === null) return <span className="grade-line"><span className="grade grade-none" aria-hidden="true">–</span><span className="muted">noch keine Note</span></span>
  return (
    <span className="grade-line">
      <span className="visually-hidden">Note {grade}, {score} von 100</span>
      <span className={`grade grade-${grade}`} aria-hidden="true">{grade}</span>
      <span className="grade-score" aria-hidden="true"><strong>{score}</strong> / 100</span>
    </span>
  )
}

/** Vier gleiche Zähler; Farbe nur bei Werten über 0. */
export function SeverityChips({ counts }: { counts: Record<Sev, number> }) {
  return (
    <ul className="sev-chips" aria-label="Offene Befunde nach Schwere">
      {SEVERITIES.map((k) => (
        <li key={k} className={counts[k] > 0 ? `sev-chip sev-chip-${k}` : 'sev-chip sev-chip-zero'}>
          <span className="sev-chip-n">{counts[k].toLocaleString('de-CH')}</span> {SEVERITY_LABEL[k]}
        </li>
      ))}
    </ul>
  )
}

/* --- Stufen: live und nach dem Scan ------------------------------------------- */

type StageState = NonNullable<ScanStageDto['state']>

/** Zustand auch für ältere Scans ohne state-Feld */
const stateOf = (v: ScanStageDto): StageState => v.state ?? (v.ran ? 'done' : v.failed ? 'failed' : 'skipped')

const TRIGGER: Record<string, string> = { deploy: 'Deploy', mcp: 'MCP', manual: 'manuell', schedule: 'Zeitplan' }

/** Läuft im Sekundentakt, solange active – für «läuft seit». */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

/** «1:05 Min.» bzw. «42 s» */
function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}:${String(s % 60).padStart(2, '0')} Min.`
  return `${Math.floor(m / 60)} Std. ${m % 60} Min.`
}

const hhmm = (iso: string) => fmtTime(iso)
/** Laufzeit seit `iso`; ungültige Zeit zählt als «gerade gestartet» */
const runFor = (iso: string | null | undefined, now: number) => clock(Math.max(0, ageMs(iso, now) ?? 0))

/** Kopfzeile: «Gestartet 19:04 · läuft seit 5 Min. · ausgelöst durch MCP» */
export function ScanHead({ s, now }: { s: ScanReportDto['scan']; now: number }) {
  const by = s.trigger ? <>ausgelöst durch {TRIGGER[s.trigger] ?? s.trigger}{s.actor && s.actor !== 'system' ? <span className="muted"> ({s.actor})</span> : null}</> : null
  if (s.status === 'queued') {
    return (
      <p className="scan-head">
        <span className="scan-head-state"><IconWaiting /> Wartet in der Warteschlange</span>
        {s.queue && <span>Position {s.queue.position}{s.queue.ahead > 0 ? ` (${s.queue.ahead} ${s.queue.ahead === 1 ? 'Scan' : 'Scans'} davor)` : ''}</span>}
        {by && <span>{by}</span>}
      </p>
    )
  }
  return (
    <p className="scan-head">
      <span className="scan-head-state"><IconRunning /> Scan läuft</span>
      <span>Gestartet {hhmm(s.startedAt)}</span>
      <span>läuft seit {runFor(s.startedAt, now)}</span>
      {by && <span>{by}</span>}
      {s.level === 'active' && <span>aktiver Scan</span>}
    </p>
  )
}

/**
 * Alle Stufen mit Zustand (Wort und eigenes Symbol, nie nur Farbe), Dauer,
 * was geprüft wird bzw. wurde. Laufende: Fortschritt und einklappbare
 * Live-Ausgabe. Fertige: Befundzahl, auch «0 Befunde – geprüft: …».
 */
function StageList({ stages, now, open, onTool, toolFilter }: {
  stages: Record<string, ScanStageDto>
  now: number
  /** Offene Befunde des fertigen Scans; null während des Laufs (noch nicht gewertet) */
  open: FindingDto[] | null
  onTool?: (tool: string) => void
  toolFilter?: string | null
}) {
  const worst = new Map<string, Sev>()
  for (const f of open ?? []) {
    const prev = worst.get(f.tool)
    if (!prev || SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(prev)) worst.set(f.tool, f.severity)
  }
  const entries = Object.entries(stages).sort(([a], [b]) => stageOrder(a) - stageOrder(b))
  if (entries.length === 0) return <p className="muted">Keine Stufe geplant.</p>
  return (
    <ol className="stages">
      {entries.map(([k, v]) => {
        const base = k.split(' ')[0]!
        const tool = toolOf(base)
        const st = stateOf(v)
        const n = v.findings ?? 0
        const openN = open?.filter((f) => f.tool === tool).length ?? n
        const sev = worst.get(tool)
        // Live (open == null): Befunde sind noch nicht gewertet, also nur gezählt
        const result = st !== 'done' ? st : n === 0 ? 'clean' : !open || openN > 0 ? 'found' : 'accepted'
        const took = v.durationMs !== undefined ? clock(v.durationMs) : null
        return (
          <li key={k} className={`stage stage-${result}${sev && result === 'found' ? ` stage-${sev}` : ''}`}>
            <span className="stage-icon">
              {result === 'clean' || result === 'accepted' ? <IconClean />
                : result === 'found' ? <IconFound />
                : result === 'running' ? <IconRunning />
                : result === 'waiting' ? <IconWaiting />
                : result === 'timeout' ? <IconTimeout />
                : result === 'failed' ? <IconFailed />
                : <IconSkipped />}
            </span>
            <div className="stage-main">
              <span className="stage-name">{STAGE_LABEL[base] ?? k}{k.includes(' ') ? <span className="muted"> {k.split(' ').slice(1).join(' ')}</span> : null}</span>
              <span className="stage-checks">
                {result === 'clean' ? <>geprüft: {v.checked ?? v.checks ?? 'alles dieser Stufe'}</> : v.checked ?? v.checks}
              </span>
              {st === 'running' && v.tail && v.tail.length > 0 && (
                <details className="stage-tail">
                  <summary>Letzte Ausgabe</summary>
                  <pre>{v.tail.join('\n')}</pre>
                </details>
              )}
              {(st === 'failed' || st === 'timeout') && v.tail && v.tail.length > 0 && (
                <details className="stage-tail">
                  <summary>Letzte Ausgabe vor dem Abbruch</summary>
                  <pre>{v.tail.join('\n')}</pre>
                </details>
              )}
            </div>
            <span className="stage-state">
              {result === 'waiting' && <span className="muted">wartet{v.timeoutMs ? ` · Zeitlimit ${Math.round(v.timeoutMs / 60_000)} Min.` : ''}</span>}
              {result === 'running' && (
                <span className="stage-live">
                  läuft seit {v.startedAt ? runFor(v.startedAt, now) : '…'}
                  {v.progress && <span className="stage-progress">{v.progress}</span>}
                  {v.timeoutMs ? <span className="muted">Zeitlimit {Math.round(v.timeoutMs / 60_000)} Min.</span> : null}
                </span>
              )}
              {result === 'clean' && <>0 Befunde{took && <span className="muted"> · {took}</span>}</>}
              {result === 'found' && (<>
                {onTool ? (
                  <button type="button" className="link-button stage-link" aria-pressed={toolFilter === tool} onClick={() => onTool(tool)}>
                    {openN} {openN === 1 ? 'Befund' : 'Befunde'}{sev ? `, ${openN > 1 ? 'höchster ' : ''}${SEVERITY_LABEL[sev]}` : ''}
                  </button>
                ) : <>{n} {n === 1 ? 'Befund' : 'Befunde'}</>}
                {n > openN && <span className="muted">, {n - openN} akzeptiert</span>}
                {took && <span className="muted"> · {took}</span>}
              </>)}
              {result === 'accepted' && <span className="muted">{n} {n === 1 ? 'Befund' : 'Befunde'}, alle akzeptiert oder behoben{took && ` · ${took}`}</span>}
              {result === 'skipped' && <span className="muted">übersprungen – {v.note}</span>}
              {result === 'cancelled' && <span className="muted">abgebrochen{v.note && !/^nicht gelaufen/.test(v.note) ? ` – ${v.note}` : ''}</span>}
              {result === 'failed' && <span className="stage-failed-note">Fehler – {v.note}{took && <span className="muted"> · nach {took}</span>}</span>}
              {result === 'timeout' && <span className="stage-failed-note">Zeitlimit – {v.note}</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** Laufender oder wartender Scan: Kopf, Abbrechen, Stufen live. */
export function LiveScan({ report, onCancelled }: { report: ScanReportDto; onCancelled?: () => void }) {
  const s = report.scan
  const now = useNow(true)
  const [confirm, setConfirm] = useState(false)
  const cancel = useMutation({
    mutationFn: () => api.cancelScan(s.id),
    onSuccess: () => { setConfirm(false); onCancelled?.() },
  })
  return (
    <section className="panel panel-pad live-scan" aria-labelledby="live-scan-title">
      <div className="live-scan-top">
        <h2 id="live-scan-title" className="ov-title">Aktueller Scan</h2>
        {!confirm ? (
          <button type="button" className="button-small" onClick={() => setConfirm(true)} disabled={cancel.isPending}>Scan abbrechen</button>
        ) : (
          <span className="confirm-inline" role="group" aria-label="Scan abbrechen bestätigen">
            <span className="confirm-note">Befunde dieses Laufs werden nicht gewertet.</span>
            <button type="button" className="button-small" onClick={() => setConfirm(false)}>Weiterlaufen lassen</button>
            <button type="button" className="button-small button-primary" onClick={() => cancel.mutate()} disabled={cancel.isPending} aria-busy={cancel.isPending || undefined} autoFocus>
              Ja, abbrechen
            </button>
          </span>
        )}
      </div>
      <div aria-live="polite"><ScanHead s={s} now={now} /></div>
      <StageList stages={s.stages} now={now} open={null} />
    </section>
  )
}

function scanTime(s: ScanReportDto['scan']) {
  const abs = fmtDateTimeShort(s.startedAt)
  const span = spanMs(s.startedAt, s.finishedAt)
  const took = span !== null ? duration(span) : null
  return { rel: relativeTime(s.startedAt), abs, took }
}

export function ScanReport({
  report,
  onAccepted,
  runningSince,
  findingAction,
  after,
}: {
  report: ScanReportDto
  onAccepted?: () => void
  /** Ein neuerer Scan läuft gerade (dieser Bericht ist der letzte fertige). */
  runningSince?: string | null
  /** M8: Weg zum Beheben neben «Akzeptieren» (Header setzen, Mit Claude lösen) */
  findingAction?: (f: FindingDto, acceptButton: ReactNode) => ReactNode
  /** M8: Abschnitt unter den Befunden (Header über Caddy) */
  after?: ReactNode
}) {
  const s = report.scan
  const running = s.status === 'queued' || s.status === 'running'
  const [toolFilter, setToolFilter] = useState<string | null>(null)
  const open = report.findings.filter((f) => f.status === 'open')
  const shown = toolFilter ? open.filter((f) => f.tool === toolFilter) : open
  const other = report.findings.filter((f) => f.status !== 'open')
  const t = scanTime(s)
  const now = useNow(running)

  const showFindings = (tool: string) => {
    setToolFilter(tool)
    requestAnimationFrame(() => document.getElementById('befunde')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  // Zustand «Teilweise»: einzelne Stufen gescheitert, der Rest des Berichts gilt
  const brokenStages = running ? [] : Object.entries(s.stages)
    .filter(([, v]) => { const st = stateOf(v); return st === 'failed' || st === 'timeout' })
    .map(([k]) => STAGE_LABEL[k.split(' ')[0]!] ?? k)

  return (
    <div className="scan-report">
      {brokenStages.length > 0 && s.status !== 'failed' && (
        <PartialNote>
          {brokenStages.length === 1 ? <>Die Stufe «{brokenStages[0]}» ist gescheitert.</> : <>{brokenStages.length} Stufen sind gescheitert ({brokenStages.join(', ')}).</>}
          {' '}Alle übrigen Ergebnisse sind vollständig; ihre Befunde stehen unten. Der Grund steht bei der Stufe.
        </PartialNote>
      )}
      {/* Ergebnis als Bento: Note, offene Befunde, Zeit; darunter die Stufen */}
      <div className="bento">
        <section className="bento-card" aria-labelledby="sec-result">
          <h3 id="sec-result" className="bento-label">Ergebnis</h3>
          <div aria-live="polite" className="bento-value">
            {running ? <span className="scan-running"><span className="status-dot" aria-hidden="true" />Scan läuft …</span> : <GradeBadge grade={s.grade} score={s.score} />}
          </div>
          {runningSince && !running && <span className="scan-running scan-running-inline"><span className="status-dot" aria-hidden="true" />Neuer Scan läuft seit {relativeTime(runningSince).replace(/^vor /, '')}</span>}
          {s.status === 'failed' && <p className="error-inline">Scan fehlgeschlagen: {s.error}</p>}
          {s.status === 'cancelled' && <p className="muted">Scan abgebrochen: {s.error}</p>}
        </section>

        <section className="bento-card" aria-labelledby="sec-open">
          <h3 id="sec-open" className="bento-label">Offene Befunde</h3>
          <div className="bento-value"><SeverityChips counts={report.counts} /></div>
        </section>

        <section className="bento-card" aria-labelledby="sec-time">
          <h3 id="sec-time" className="bento-label">{running ? 'Läuft seit' : 'Letzter Scan'}</h3>
          <p className="bento-value bento-text">{running ? runFor(s.startedAt, now) : t.rel}</p>
          <p className="bento-sub">
            {t.abs}
            {t.took && <> · Dauer {t.took}</>}
            {s.trigger && <> · {TRIGGER[s.trigger] ?? s.trigger}</>}
            {s.level === 'active' && <> · aktiver Scan</>}
          </p>
        </section>

        <section className="bento-card bento-wide" aria-labelledby="sec-stages">
          <h3 id="sec-stages" className="bento-label">Stufen</h3>
          {running && <ScanHead s={s} now={now} />}
          <StageList stages={s.stages} now={now} open={running ? null : open} onTool={running ? undefined : showFindings} toolFilter={toolFilter} />
        </section>
      </div>

      <div className="section-head findings-head" id="befunde">
        <h2>
          {toolFilter ? <>Befunde von {TOOL_LABEL[toolFilter] ?? toolFilter}</> : 'Offene Befunde'}
          <span className="muted findings-count"> {shown.length}</span>
        </h2>
        {toolFilter && <button type="button" className="button-small" onClick={() => setToolFilter(null)}>Alle Befunde zeigen</button>}
      </div>
      {open.length === 0 && !running && <p className="state state-empty">Keine offenen Befunde.</p>}
      {shown.length > 0 && (
        <ul className="finding-list">
          {shown.map((f) => <Finding key={f.id} f={f} onAccepted={onAccepted} action={findingAction ? (accept) => findingAction(f, accept) : undefined} />)}
        </ul>
      )}
      {other.length > 0 && (
        <details>
          <summary>{other.length} akzeptierte oder behobene Befunde</summary>
          <ul className="finding-list">{other.map((f) => <Finding key={f.id} f={f} />)}</ul>
        </details>
      )}
      {after}
    </div>
  )
}

function Finding({ f, onAccepted, action }: { f: FindingDto; onAccepted?: () => void; action?: (acceptButton: ReactNode) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const v = useFormErrors({
    schema: acceptFindingSchema,
    values: () => ({ status: 'accepted', reason }),
    idFor: (n) => `f-${f.id}-${n}`,
  })
  const accept = useMutation({
    // Das Formular (Begründung) zeigt den Fehler selbst
    meta: { quiet: true },
    mutationFn: () => api.acceptFinding(f.id, reason),
    onSuccess: () => {
      setOpen(false)
      onAccepted?.()
    },
    onError: (err) => void v.setServerErrors(err),
  })
  return (
    <li className={`finding finding-${f.severity} finding-${f.status}`}>
      <div className="finding-head">
        <span className={`sev sev-${f.severity}`}>{SEVERITY_LABEL[f.severity]}</span>
        <strong>{f.title}</strong>
        <span className="muted">{TOOL_LABEL[f.tool] ?? f.tool}</span>
      </div>
      <code className="finding-loc">{f.location}</code>
      {f.description && <p>{f.description}</p>}
      {f.fix && <p><span className="muted">Behebung:</span> {f.fix}</p>}
      {f.status === 'accepted' && <p className="muted">✓ akzeptiert: {f.acceptReason}</p>}
      {f.status === 'fixed' && <p className="muted">✓ behoben</p>}
      {f.status === 'open' && (() => {
        // M8: Der Weg zum Beheben rendert die Knopfzeile selbst (mit «Akzeptieren»
        // am Ende) und sein Panel darunter – so stimmt die Tab-Reihenfolge, und
        // das Panel bleibt offen, während das Akzeptieren-Formular offen ist.
        const acceptButton = onAccepted && !open ? <button className="button-small" onClick={() => setOpen(true)}>Akzeptieren</button> : null
        if (action) return action(acceptButton)
        return acceptButton ? <div className="finding-actions">{acceptButton}</div> : null
      })()}
      {open && (
        <form
          className="inline-form"
          noValidate
          ref={v.formRef}
          onSubmit={(e) => {
            e.preventDefault()
            if (v.validateAll()) accept.mutate()
          }}
        >
          <div className="inline-form-field">
            <label htmlFor={v.idFor('reason')} className="visually-hidden">Begründung</label>
            <input {...v.field('reason')} placeholder="Begründung (steht im Audit-Log)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            {v.errors.reason && <FieldError id={v.idFor('reason')} message={v.errors.reason} />}
          </div>
          <button type="submit" className="button-primary" disabled={accept.isPending}>Akzeptieren</button>
          <button type="button" onClick={() => { setOpen(false); v.reset() }}>Abbrechen</button>
        </form>
      )}
      {accept.isError && !v.errors.reason && <p role="alert" className="error">{(accept.error as Error).message}</p>}
    </li>
  )
}

/** Reiter "Security" am Projekt. */
export function ProjectSecurity({ projectId, sourceType }: { projectId: string; sourceType?: string }) {
  const qc = useQueryClient()
  const [confirmActive, setConfirmActive] = useState(false)
  const q = useQuery({
    queryKey: ['scan', projectId],
    queryFn: () => api.latestScan(projectId),
    refetchInterval: (query) => {
      const st = query.state.data?.report?.scan.status
      return st === 'queued' || st === 'running' ? 4000 : false
    },
  })
  const latest = q.data?.report
  const running = Boolean(latest && (latest.scan.status === 'queued' || latest.scan.status === 'running'))
  // Läuft ein Scan, bleibt der letzte fertige sichtbar
  const done = useQuery({
    queryKey: ['scan', projectId, 'done'],
    queryFn: () => api.latestScan(projectId, true),
    enabled: running,
  })
  const start = useMutation({
    mutationFn: (level: 'standard' | 'active') => api.startScan(projectId, level),
    onSuccess: () => {
      setConfirmActive(false)
      void qc.invalidateQueries({ queryKey: ['scan', projectId] })
    },
  })
  const finished = running ? done.data?.report ?? null : latest
  // M8: Header über Caddy; Ergebnis des Nachscans als Meldung über den Befunden
  const headerRules = useHeaderRules(projectId)
  const [fixNotice, setFixNotice] = useState<string | null>(null)
  // Nach «Auftrag kopieren»: öfter nach neuen Vorschlägen von Claude sehen
  const [watchFixes, setWatchFixes] = useState(false)
  const noticeRef = useRef<HTMLDivElement>(null)
  // Die Karte des behobenen Befunds verschwindet; die Meldung oben einblenden.
  // Erst leeren, dann setzen: auch eine gleichlautende Meldung wird angesagt.
  const showFixNotice = (msg: string) => {
    setFixNotice(null)
    setTimeout(() => {
      setFixNotice(msg)
      requestAnimationFrame(() => noticeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
    }, 50)
  }

  return (
    <div className="tab-panel">
      <div className="scan-actions">
        <button className="button-primary" onClick={() => start.mutate('standard')} disabled={start.isPending || running}>
          {running ? 'Scan läuft …' : 'Jetzt scannen'}
        </button>
        {!confirmActive ? (
          <button className="button-warn" onClick={() => setConfirmActive(true)} disabled={running}>
            <IconWarn /> Aktiver Scan
          </button>
        ) : (
          <span className="confirm-inline" role="group" aria-label="Aktiven Scan bestätigen">
            <button onClick={() => setConfirmActive(false)}>Abbrechen</button>
            <button className="button-danger-solid" onClick={() => start.mutate('active')} disabled={start.isPending} autoFocus>Ja, aktiv angreifen</button>
          </span>
        )}
        <p className="scan-actions-hint">
          <strong>Aktiver Scan</strong> greift die App mit OWASP ZAP aktiv an (XSS, SQL-Injection) und kann dabei Daten anlegen oder ändern. Nur der interne Container, nie über das Internet.
        </p>
      </div>
      {running && latest && <LiveScan report={latest} onCancelled={() => void qc.invalidateQueries({ queryKey: ['scan', projectId] })} />}
      {!q.data && q.isError ? (
        <ErrorState what="Der Scan-Bericht" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <Loading label="Scan-Bericht wird geladen"><SkStats n={3} /><SkRows n={4} /></Loading>
      ) : !finished ? (
        !running && (
          <EmptyState title="Noch kein Scan" action={<button type="button" className="button-primary" onClick={() => start.mutate('standard')}>Jetzt scannen</button>}>
            Nach jedem Deploy läuft einer automatisch.
          </EmptyState>
        )
      ) : (
        <>
          {running && <div className="section-head"><h2>Letzter abgeschlossener Scan</h2></div>}
          <div ref={noticeRef} role="status" aria-live="polite" className="fix-live">{fixNotice && <p className="fix-notice">{fixNotice}</p>}</div>
          <ScanReport
            report={finished}
            onAccepted={() => void qc.invalidateQueries({ queryKey: ['scan', projectId] })}
            findingAction={(f, accept) => (
              <ClaudeFixAction
                projectId={projectId}
                finding={f}
                sourceType={sourceType}
                before={<HeaderFixAction projectId={projectId} finding={f} rules={headerRules.data} onDone={showFixNotice} />}
                after={accept}
                onCopied={() => setWatchFixes(true)}
              />
            )}
            after={<><FixRequestsSection projectId={projectId} onDone={showFixNotice} watch={watchFixes} /><HeaderRulesSection projectId={projectId} /></>}
          />
        </>
      )}
    </div>
  )
}

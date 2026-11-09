import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type ScanReportDto, type FindingDto } from '../api.js'
import { acceptFindingSchema } from '@deployer/shared'
import { useFormErrors } from '../lib/form.js'
import { FieldError } from './Field.js'
import { relativeTime, duration } from '../lib/format.js'

/**
 * Ergebnis eines Scans: Note, Score, offene Befunde, Stufen, Zeit. Wird am
 * Projekt und bei externen Zielen benutzt. Schweregrad steht immer als Wort
 * da; Farbe kommt nur dazu, wenn es etwas zu melden gibt.
 */

type Sev = FindingDto['severity']
const SEVERITIES: Sev[] = ['critical', 'high', 'medium', 'low']
export const SEVERITY_LABEL: Record<Sev, string> = { critical: 'kritisch', high: 'hoch', medium: 'mittel', low: 'niedrig' }

const STAGE_LABEL: Record<string, string> = {
  'trivy-image': 'Image (Trivy)',
  'trivy-source': 'Quellcode (Trivy)',
  headers: 'Security-Header',
  'zap-baseline': 'OWASP ZAP (passiv)',
  'zap-full': 'OWASP ZAP (aktiv)',
  nuclei: 'Offene Dateien (Nuclei)',
  testssl: 'TLS (testssl.sh)',
}
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
const IconSkipped = () => <svg {...svg}><circle cx="8" cy="8" r="6.2" /><path d="M5.2 8h5.6" /></svg>
const IconFailed = () => <svg {...svg}><circle cx="8" cy="8" r="6.2" /><path d="m6 6 4 4M10 6l-4 4" /></svg>
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

function scanTime(s: ScanReportDto['scan']) {
  const start = new Date(s.startedAt)
  const abs = start.toLocaleString('de-CH', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  const took = s.finishedAt ? duration(new Date(s.finishedAt).getTime() - start.getTime()) : null
  return { rel: relativeTime(s.startedAt), abs, took }
}

export function ScanReport({
  report,
  onAccepted,
  runningSince,
}: {
  report: ScanReportDto
  onAccepted?: () => void
  /** Ein neuerer Scan läuft gerade (dieser Bericht ist der letzte fertige). */
  runningSince?: string | null
}) {
  const s = report.scan
  const running = s.status === 'queued' || s.status === 'running'
  const [toolFilter, setToolFilter] = useState<string | null>(null)
  const open = report.findings.filter((f) => f.status === 'open')
  const shown = toolFilter ? open.filter((f) => f.tool === toolFilter) : open
  const other = report.findings.filter((f) => f.status !== 'open')
  const t = scanTime(s)

  // Höchste offene Schwere je Werkzeug, für die Farbe der Stufe
  const worst = new Map<string, Sev>()
  for (const f of open) {
    const prev = worst.get(f.tool)
    if (!prev || SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(prev)) worst.set(f.tool, f.severity)
  }
  const openByTool = (tool: string) => open.filter((f) => f.tool === tool).length

  const showFindings = (tool: string) => {
    setToolFilter(tool)
    requestAnimationFrame(() => document.getElementById('befunde')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  return (
    <div className="scan-report">
      {/* Ergebnis als Bento: Note, offene Befunde, Zeit; darunter die Stufen */}
      <div className="bento">
        <section className="bento-card" aria-labelledby="sec-result">
          <h3 id="sec-result" className="bento-label">Ergebnis</h3>
          <div aria-live="polite" className="bento-value">
            {running ? <span className="scan-running"><span className="status-dot" aria-hidden="true" />Scan läuft …</span> : <GradeBadge grade={s.grade} score={s.score} />}
          </div>
          {runningSince && !running && <span className="scan-running scan-running-inline"><span className="status-dot" aria-hidden="true" />Neuer Scan läuft seit {relativeTime(runningSince).replace(/^vor /, '')}</span>}
          {s.status === 'failed' && <p className="error-inline">Scan fehlgeschlagen: {s.error}</p>}
        </section>

        <section className="bento-card" aria-labelledby="sec-open">
          <h3 id="sec-open" className="bento-label">Offene Befunde</h3>
          <div className="bento-value"><SeverityChips counts={report.counts} /></div>
        </section>

        <section className="bento-card" aria-labelledby="sec-time">
          <h3 id="sec-time" className="bento-label">Zeit</h3>
          <p className="bento-value bento-text">{t.rel}</p>
          <p className="bento-sub">
            {t.abs}
            {t.took && <> · Dauer {t.took}</>}
            {s.level === 'active' && <> · aktiver Scan</>}
          </p>
        </section>

        <section className="bento-card bento-wide" aria-labelledby="sec-stages">
          <h3 id="sec-stages" className="bento-label">Stufen</h3>
          <ul className="stages">
              {Object.entries(s.stages).sort(([a], [b]) => stageOrder(a) - stageOrder(b)).map(([k, v]) => {
                const tool = toolOf(k.split(' ')[0]!)
                const sev = worst.get(tool)
                const n = v.findings ?? 0
                const openN = openByTool(tool)
                const state = !v.ran ? (v.failed ? 'failed' : 'skipped') : n === 0 ? 'clean' : openN > 0 ? 'found' : 'accepted'
                return (
                  <li key={k} className={`stage stage-${state}${sev && state === 'found' ? ` stage-${sev}` : ''}`}>
                    <span className="stage-icon">
                      {state === 'clean' || state === 'accepted' ? <IconClean /> : state === 'found' ? <IconFound /> : state === 'failed' ? <IconFailed /> : <IconSkipped />}
                    </span>
                    <span className="stage-name">{STAGE_LABEL[k.split(' ')[0]!] ?? k}{k.includes(' ') ? <span className="muted mono"> {k.split(' ').slice(1).join(' ')}</span> : null}</span>
                    <span className="stage-state">
                      {state === 'clean' && 'keine Befunde'}
                      {state === 'found' && (<>
                        <button type="button" className="link-button stage-link" aria-pressed={toolFilter === tool} onClick={() => showFindings(tool)}>
                          {openN} {openN === 1 ? 'Befund' : 'Befunde'}{sev ? `, ${openN > 1 ? 'höchster ' : ''}${SEVERITY_LABEL[sev]}` : ''}
                        </button>
                        {n > openN && <span className="muted">, {n - openN} akzeptiert</span>}
                      </>)}
                      {state === 'accepted' && <span className="muted">{n} {n === 1 ? 'Befund' : 'Befunde'}, alle akzeptiert oder behoben</span>}
                      {state === 'skipped' && <span className="muted">übersprungen – {v.note}</span>}
                      {state === 'failed' && <span className="stage-failed-note">gescheitert – {v.note}</span>}
                    </span>
                  </li>
                )
              })}
              {Object.keys(s.stages).length === 0 && <li className="muted">{running ? 'Die Stufen erscheinen, sobald sie durchgelaufen sind.' : 'Keine Stufe gelaufen.'}</li>}
          </ul>
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
          {shown.map((f) => <Finding key={f.id} f={f} onAccepted={onAccepted} />)}
        </ul>
      )}
      {other.length > 0 && (
        <details>
          <summary>{other.length} akzeptierte oder behobene Befunde</summary>
          <ul className="finding-list">{other.map((f) => <Finding key={f.id} f={f} />)}</ul>
        </details>
      )}
    </div>
  )
}

function Finding({ f, onAccepted }: { f: FindingDto; onAccepted?: () => void }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const v = useFormErrors({
    schema: acceptFindingSchema,
    values: () => ({ status: 'accepted', reason }),
    idFor: (n) => `f-${f.id}-${n}`,
  })
  const accept = useMutation({
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
      {f.status === 'open' && onAccepted && !open && <button className="button-small" onClick={() => setOpen(true)}>Akzeptieren …</button>}
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
export function ProjectSecurity({ projectId }: { projectId: string }) {
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
  const report = running && done.data?.report ? done.data.report : latest

  return (
    <div className="tab-panel">
      <div className="scan-actions">
        <button className="button-primary" onClick={() => start.mutate('standard')} disabled={start.isPending || running}>
          {running ? 'Scan läuft …' : 'Jetzt scannen'}
        </button>
        {!confirmActive ? (
          <button className="button-warn" onClick={() => setConfirmActive(true)} disabled={running}>
            <IconWarn /> Aktiver Scan …
          </button>
        ) : (
          <span className="confirm-inline" role="group" aria-label="Aktiven Scan bestätigen">
            <button className="button-danger" onClick={() => start.mutate('active')} disabled={start.isPending} autoFocus>Ja, aktiv angreifen</button>
            <button onClick={() => setConfirmActive(false)}>Abbrechen</button>
          </span>
        )}
        <p className="scan-actions-hint">
          <strong>Aktiver Scan</strong> greift die App mit OWASP ZAP aktiv an (XSS, SQL-Injection) und kann dabei Daten anlegen oder ändern. Nur der interne Container, nie über das Internet.
        </p>
      </div>
      {start.isError && (
        <p role="alert" className="error">{start.error instanceof ApiError ? start.error.message : 'Scan nicht gestartet'}</p>
      )}
      {q.isLoading ? (
        <p className="state state-loading">Wird geladen…</p>
      ) : !report ? (
        <p className="state state-empty">Noch kein Scan. Nach jedem Deploy läuft einer automatisch.</p>
      ) : (
        <ScanReport
          report={report}
          runningSince={running && report !== latest ? latest!.scan.startedAt : null}
          onAccepted={() => void qc.invalidateQueries({ queryKey: ['scan', projectId] })}
        />
      )}
    </div>
  )
}

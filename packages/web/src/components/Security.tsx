import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type ScanReportDto, type FindingDto } from '../api.js'
import { acceptFindingSchema } from '@deployer/shared'
import { useFormErrors } from '../lib/form.js'
import { FieldError } from './Field.js'

/**
 * Ergebnis eines Scans: Score, Note, Stufen, Befunde. Wird am Projekt und
 * bei externen Zielen benutzt. Schweregrad immer als Wort und Zeichen,
 * nie nur als Farbe.
 */

export const SEVERITY: Record<FindingDto['severity'], { label: string; mark: string }> = {
  critical: { label: 'kritisch', mark: '!!' },
  high: { label: 'hoch', mark: '!' },
  medium: { label: 'mittel', mark: '•' },
  low: { label: 'niedrig', mark: '·' },
}

export function GradeBadge({ grade, score }: { grade: string | null; score: number | null }) {
  if (!grade || score === null) return <span className="grade grade-none">–</span>
  return (
    <span className={`grade grade-${grade}`} title={`Score ${score} von 100`}>
      <strong>{grade}</strong> {score}
    </span>
  )
}

const STAGE_LABEL: Record<string, string> = {
  'trivy-image': 'Image (Trivy)',
  'trivy-source': 'Quellcode (Trivy)',
  headers: 'Security-Header',
  'zap-baseline': 'OWASP ZAP (passiv)',
  'zap-full': 'OWASP ZAP (aktiv)',
  nuclei: 'Offene Dateien (Nuclei)',
  testssl: 'TLS (testssl.sh)',
}

export function ScanReport({ report, onAccepted }: { report: ScanReportDto; onAccepted?: () => void }) {
  const s = report.scan
  const running = s.status === 'queued' || s.status === 'running'
  const open = report.findings.filter((f) => f.status === 'open')
  const other = report.findings.filter((f) => f.status !== 'open')

  return (
    <div className="scan-report">
      <dl className="facts">
        <dt>Ergebnis</dt>
        <dd>
          {running ? <span className="muted">Scan läuft …</span> : <GradeBadge grade={s.grade} score={s.score} />}
          {s.status === 'failed' && <span className="error-inline"> ✕ fehlgeschlagen: {s.error}</span>}
        </dd>
        <dt>Offen</dt>
        <dd>
          {(['critical', 'high', 'medium', 'low'] as const).map((k) => (
            <span key={k} className={`count count-${k}`}>{SEVERITY[k].mark} {report.counts[k]} {SEVERITY[k].label}</span>
          ))}
        </dd>
        <dt>Stufen</dt>
        <dd>
          <ul className="stage-list">
            {Object.entries(s.stages).map(([k, v]) => (
              <li key={k}>
                <span className="stage-mark">{v.ran ? '✓' : '–'}</span> {STAGE_LABEL[k.split(' ')[0]!] ?? k}
                {v.ran ? <span className="muted"> · {v.findings ?? 0} Befunde</span> : <span className="muted"> · {v.note}</span>}
              </li>
            ))}
          </ul>
        </dd>
        <dt>Zeit</dt>
        <dd className="muted">{new Date(s.startedAt).toLocaleString('de-CH')}{s.level === 'active' ? ' · aktiver Scan' : ''}</dd>
      </dl>

      {open.length === 0 && !running && <p className="state state-empty">Keine offenen Befunde.</p>}
      <ul className="finding-list">
        {open.map((f) => <Finding key={f.id} f={f} onAccepted={onAccepted} />)}
      </ul>
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
        <span className={`sev sev-${f.severity}`}>{SEVERITY[f.severity].mark} {SEVERITY[f.severity].label}</span>
        <strong>{f.title}</strong>
        <span className="muted">{f.tool}</span>
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
  const start = useMutation({
    mutationFn: (level: 'standard' | 'active') => api.startScan(projectId, level),
    onSuccess: () => {
      setConfirmActive(false)
      void qc.invalidateQueries({ queryKey: ['scan', projectId] })
    },
  })

  const report = q.data?.report
  const running = report && (report.scan.status === 'queued' || report.scan.status === 'running')

  return (
    <div className="tab-panel">
      <div className="form-actions">
        <button onClick={() => start.mutate('standard')} disabled={start.isPending || !!running}>Jetzt scannen</button>
        {!confirmActive && <button onClick={() => setConfirmActive(true)} disabled={!!running}>Aktiver Scan …</button>}
        {confirmActive && (
          <>
            <span className="warn">Der aktive Scan probiert XSS und SQL-Injection gegen den internen Container und kann Daten verändern.</span>
            <button className="button-danger" onClick={() => start.mutate('active')}>Ja, aktiv scannen</button>
            <button onClick={() => setConfirmActive(false)}>Abbrechen</button>
          </>
        )}
      </div>
      {start.isError && (
        <p role="alert" className="error">{start.error instanceof ApiError ? start.error.message : 'Scan nicht gestartet'}</p>
      )}
      {q.isLoading ? (
        <p className="state state-loading">Wird geladen…</p>
      ) : !report ? (
        <p className="state state-empty">Noch kein Scan. Nach jedem Deploy läuft einer automatisch.</p>
      ) : (
        <ScanReport report={report} onAccepted={() => void qc.invalidateQueries({ queryKey: ['scan', projectId] })} />
      )}
    </div>
  )
}

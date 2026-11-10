import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CspAnalysisDto, FindingDto, ProjectDto, ScanReportDto, ScanStageDto } from '@airlock/shared'
import { headerFixFor } from '@airlock/shared'
import { api, ApiError } from '../api.js'
import { relativeTime, inTime } from '../lib/format.js'
import { isPublic } from '../lib/projects.js'
import { SEVERITY_LABEL } from './Security.js'
import { HeaderFixAction, useHeaderRules } from './HeaderFix.js'
import { ClaudeFixAction } from './ClaudeFix.js'

/**
 * Security in der Projektübersicht: Note im Ring, Urteil in Worten, nur die
 * Zahlen, die zählen, und die zwei wichtigsten offenen Befunde mit ihrer
 * Aktion. Ohne Befunde eine klare Aussage statt eines leeren Rasters.
 */

type Sev = FindingDto['severity']
const SEVS: Sev[] = ['critical', 'high', 'medium', 'low']

const VERDICT: Record<string, string> = { A: 'Gut geschützt', B: 'Solide', C: 'Verbesserungsbedarf', D: 'Handlungsbedarf' }

/** Kurze Namen der Stufen für die Fusszeile */
const STAGE_SHORT: Record<string, string> = {
  headers: 'Header', 'zap-baseline': 'ZAP', 'zap-full': 'ZAP aktiv', nuclei: 'Nuclei', 'trivy-source': 'Quellcode', 'trivy-image': 'Image', testssl: 'TLS',
}
const STAGE_ORDER = ['headers', 'zap-baseline', 'zap-full', 'nuclei', 'trivy-source', 'trivy-image', 'testssl']

/** Grund einer übersprungenen Stufe, kurz: «statisch», «kein Quellcode» */
export function skipReason(note: string | undefined): string {
  if (!note) return 'übersprungen'
  if (/statische Seite/.test(note)) return 'statisch'
  if (/fertiges Image/.test(note)) return 'fertiges Image'
  if (/Quellordner|Quellcode/.test(note)) return 'ohne Quelle'
  if (/Caddy/.test(note)) return 'bei Caddy'
  if (/Compose-Dienste/.test(note)) return 'keine Dienste'
  if (/externen Zielen/.test(note)) return 'extern'
  const head = note.split(/[:,(]/)[0]!.trim()
  return head.length > 18 ? `${head.slice(0, 17)}…` : head
}

/** Inline-Analyse als Satz: «Seite nutzt 1 Inline-Skript und 1 Inline-Style – vor dem Setzen auslagern» */
export function cspAnalysisLine(a: CspAnalysisDto | null | undefined, enforced: boolean): string | null {
  if (!a || a.error) return null
  const parts: string[] = []
  const n = (v: number, one: string, many: string) => `${v} ${v === 1 ? one : many}`
  if (a.inlineScripts) parts.push(n(a.inlineScripts, 'Inline-Skript', 'Inline-Skripte'))
  if (a.inlineStyles) parts.push(n(a.inlineStyles, 'Inline-Style', 'Inline-Styles'))
  if (a.eventHandlers) parts.push(n(a.eventHandlers, 'Ereignis-Attribut', 'Ereignis-Attribute'))
  if (a.styleAttributes) parts.push(n(a.styleAttributes, 'style-Attribut', 'style-Attribute'))
  const pages = a.pages.length === 1 ? 'Seite nutzt' : 'Seiten nutzen'
  if (parts.length === 0) return `Kein Inline-Code gefunden – die Vorgabe lässt sich ${enforced ? 'halten' : 'direkt setzen'}`
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} und ${parts.at(-1)}`
  return `${pages} ${list} – vor dem Setzen auslagern`
}

/** Unterzeile unter dem Urteil */
function summaryLine(counts: Record<Sev, number>, open: number, p: ProjectDto): string {
  if (open === 0) return isPublic(p) ? 'Alle Prüfungen bestanden' : 'Alle Prüfungen bestanden · bereit für «Öffentlich»'
  const severe = counts.critical + counts.high
  if (severe === 0) {
    const m = counts.medium
    const l = counts.low
    const rest = [m ? `${m} ${m === 1 ? 'mittlerer' : 'mittlere'}` : null, l ? `${l} ${l === 1 ? 'niedriger' : 'niedrige'}` : null].filter(Boolean).join(' und ')
    return `Keine kritischen oder hohen Befunde · ${rest} offen`
  }
  if (counts.critical) return `${counts.critical === 1 ? 'Ein kritischer Befund' : `${counts.critical} kritische Befunde`} offen · sperrt «Öffentlich»`
  return `${counts.high === 1 ? 'Ein hoher Befund' : `${counts.high} hohe Befunde`} offen · vor «Öffentlich» beheben`
}

function Ring({ grade, score }: { grade: string; score: number }) {
  const r = 34
  const c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score)) / 100
  return (
    <div className={`sc-ring sc-ring-${grade}`} role="img" aria-label={`Note ${grade}, ${score} von 100 Punkten`}>
      <svg viewBox="0 0 80 80" aria-hidden="true">
        <circle cx="40" cy="40" r={r} className="sc-ring-track" />
        <circle cx="40" cy="40" r={r} className="sc-ring-value" strokeDasharray={`${(c * pct).toFixed(2)} ${c.toFixed(2)}`} transform="rotate(-90 40 40)" />
      </svg>
      <span className="sc-ring-grade" aria-hidden="true">{grade}</span>
      <span className="sc-ring-score num" aria-hidden="true">{score} / 100</span>
    </div>
  )
}

function Delta({ score, previous }: { score: number; previous: number | null | undefined }) {
  if (previous === null || previous === undefined) return null
  const d = score - previous
  if (d === 0) return <span className="sc-delta sc-delta-same">unverändert seit letztem Scan</span>
  return <span className={`sc-delta ${d > 0 ? 'sc-delta-up' : 'sc-delta-down'}`}>{d > 0 ? `+${d}` : `−${Math.abs(d)}`} seit letztem Scan</span>
}

/** Vorhandene Stufen farbig mit Zahl und Wort, Nullen grau gesammelt */
function SeverityLine({ counts }: { counts: Record<Sev, number> }) {
  const present = SEVS.filter((s) => counts[s] > 0)
  const zero = SEVS.filter((s) => counts[s] === 0)
  return (
    <p className="sc-sevs" aria-label="Offene Befunde nach Schwere">
      {present.map((s) => (
        <span key={s} className={`sc-sev sc-sev-${s}`}><span className="sc-sev-mark" aria-hidden="true" />{counts[s]} {SEVERITY_LABEL[s]}</span>
      ))}
      {zero.length > 0 && <span className="sc-sev-zero">{zero.map((s) => `0 ${SEVERITY_LABEL[s]}`).join(' · ')}</span>}
    </p>
  )
}

function StageFoot({ stages }: { stages: Record<string, ScanStageDto> }) {
  const keys = Object.keys(stages).sort((a, b) => {
    const ia = STAGE_ORDER.indexOf(a.split(' ')[0]!)
    const ib = STAGE_ORDER.indexOf(b.split(' ')[0]!)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  return (
    <ul className="sc-stages" aria-label="Stufen des Scans">
      {keys.map((k) => {
        const s = stages[k]!
        const name = STAGE_SHORT[k.split(' ')[0]!] ?? k
        const failed = s.failed || s.state === 'failed' || s.state === 'timeout'
        if (s.ran && !failed) return <li key={k} className="sc-stage sc-stage-ok"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>{name}</li>
        if (failed) return <li key={k} className="sc-stage sc-stage-bad" title={s.note}>✕ {name} <span>(fehlgeschlagen)</span></li>
        if (s.state === 'running' || s.state === 'waiting') return <li key={k} className="sc-stage sc-stage-skip">… {name} <span>({s.state === 'running' ? 'läuft' : 'wartet'})</span></li>
        return <li key={k} className="sc-stage sc-stage-skip" title={s.note}>– {name} <span>({skipReason(s.note)})</span></li>
      })}
    </ul>
  )
}

export function SecurityCard({ p, onTab }: { p: ProjectDto; onTab: (t: 'security') => void }) {
  const qc = useQueryClient()
  const r = useQuery({ queryKey: ['scan-done', p.id], queryFn: () => api.latestScan(p.id, true), enabled: Boolean(p.security) })
  const rules = useHeaderRules(p.id)
  const report: ScanReportDto | null | undefined = r.data?.report
  const scanning = p.security?.status === 'running' || p.security?.status === 'queued'
  const start = useMutation({
    mutationFn: () => api.startScan(p.id, 'standard'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['project', p.id] })
      void qc.invalidateQueries({ queryKey: ['scan', p.id] })
    },
  })
  const open = (report?.findings ?? []).filter((f) => f.status === 'open')
  const top = [...open].sort((a, b) => SEVS.indexOf(a.severity) - SEVS.indexOf(b.severity)).slice(0, 2)
  const total = open.length

  const head = (
    <div className="ov-head">
      <h2 className="ov-title" id="ov-sec">Security</h2>
      <button type="button" className="link-button" onClick={() => onTab('security')}>{total > 0 ? 'Alle Befunde' : 'Verlauf'}</button>
    </div>
  )

  if (!p.security || (!report && !r.isLoading)) {
    return (
      <section className="panel panel-pad ov-section" aria-labelledby="ov-sec">
        {head}
        <p className="muted ov-empty">{scanning ? 'Der erste Scan läuft.' : 'Noch kein Scan. Er startet nach dem ersten erfolgreichen Deploy.'}</p>
      </section>
    )
  }
  if (!report) {
    return <section className="panel panel-pad ov-section" aria-labelledby="ov-sec">{head}<p className="muted ov-empty">Wird geladen…</p></section>
  }

  const s = report.scan
  const grade = s.grade ?? 'D'
  const score = s.score ?? 0
  const verdict = total === 0 ? 'Keine offenen Befunde' : VERDICT[grade] ?? 'Bewertet'
  const cspRule = rules.data?.rules.find((x) => x.header === 'content-security-policy')
  const activeRules = rules.data?.rules ?? []
  const protections = [
    activeRules.length ? `${activeRules.length} Header gesetzt` : null,
    cspRule ? (cspRule.mode === 'enforce' ? 'CSP aktiv' : 'CSP im Report-Only') : null,
  ].filter(Boolean).join(', ')
  const next = s.nextScheduledAt && p.desiredState === 'running' ? `nächster automatischer Scan ${inTime(s.nextScheduledAt)}` : null

  return (
    <section className="panel panel-pad ov-section sc" aria-labelledby="ov-sec">
      {head}
      <div className="sc-main">
        <Ring grade={grade} score={score} />
        <div className="sc-verdict">
          <p className="sc-verdict-line"><strong className="sc-verdict-word">{verdict}</strong><Delta score={score} previous={s.previousScore} /></p>
          <p className="sc-summary">{summaryLine(report.counts, total, p)}</p>
          {total > 0 && <SeverityLine counts={report.counts} />}
        </div>
      </div>

      {top.length > 0 ? (
        <ul className="sc-findings">
          {top.map((f) => {
            const isCsp = headerFixFor(f) === 'content-security-policy'
            const sub = isCsp ? cspAnalysisLine(rules.data?.csp.analysis, cspRule?.mode === 'enforce') : null
            return (
              <li key={f.id} className="sc-finding">
                <span className={`badge sev-${f.severity}`}>{SEVERITY_LABEL[f.severity]}</span>
                <div className="sc-finding-text">
                  <span className="sc-finding-title">{f.title}</span>
                  {sub && <span className="sc-finding-sub">{sub}</span>}
                </div>
                <div className="sc-finding-actions">
                  <ClaudeFixAction
                    projectId={p.id}
                    finding={f}
                    sourceType={p.sourceType}
                    before={<HeaderFixAction projectId={p.id} finding={f} rules={rules.data} onDone={() => void qc.invalidateQueries({ queryKey: ['scan-done', p.id] })} />}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="sc-calm">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
          {[protections || null, next].filter(Boolean).join(' · ') || 'Alle Prüfungen bestanden'}
        </p>
      )}

      <div className="sc-foot">
        <StageFoot stages={s.stages} />
        <p className="sc-when">
          {scanning ? <span>Scan läuft …</span> : <span>Scan <time dateTime={s.finishedAt ?? s.startedAt} title={new Date(s.finishedAt ?? s.startedAt).toLocaleString('de-CH')}>{relativeTime(s.finishedAt ?? s.startedAt)}</time></span>}
          {!scanning && <> · <button type="button" className="link-button" onClick={() => start.mutate()} disabled={start.isPending}>{start.isPending ? 'Startet …' : 'Neu scannen'}</button></>}
        </p>
      </div>
      {start.isError && <p role="alert" className="error-inline">{start.error instanceof ApiError ? start.error.message : 'Scan nicht gestartet'}</p>}
    </section>
  )
}

/**
 * Stufen eines Scans für die Live-Anzeige: Plan von Anfang an, Zustand,
 * Dauer, Zeitlimit, Fortschritt aus den Logzeilen der Scanner. Reine
 * Funktionen, ohne Datenbank und Docker – testbar.
 */

import { SCAN_STAGE_LABEL, type ScanReportDto } from '@airlock/shared'
import type { ScanStage, ScanStages } from '../db/schema.js'

export type StageKey = 'trivy-image' | 'trivy-source' | 'headers' | 'zap-baseline' | 'zap-full' | 'nuclei' | 'testssl'

/** Was eine Stufe prüft (Anzeige und MCP) und wie lange sie höchstens laufen darf. */
export const STAGE_INFO: Record<StageKey, { label: string; checks: string; timeoutMs: number }> = {
  'trivy-image': { label: SCAN_STAGE_LABEL['trivy-image']!, checks: 'Trivy: bekannte Schwachstellen in Paketen und Image, Secrets, Fehlkonfiguration', timeoutMs: 15 * 60_000 },
  'trivy-source': { label: SCAN_STAGE_LABEL['trivy-source']!, checks: 'Trivy: verwundbare Abhängigkeiten aus Lockfiles, Secrets im Code, Fehlkonfiguration (Dockerfile, Compose)', timeoutMs: 10 * 60_000 },
  headers: { label: SCAN_STAGE_LABEL.headers!, checks: 'Header-Check: Security-Header und Cookies der Antwort', timeoutMs: 60_000 },
  'zap-baseline': { label: SCAN_STAGE_LABEL['zap-baseline']!, checks: 'ZAP Baseline: Seite crawlen und passiv auf typische Web-Schwachstellen prüfen', timeoutMs: 15 * 60_000 },
  'zap-full': { label: SCAN_STAGE_LABEL['zap-full']!, checks: 'ZAP Full Scan: aktive Angriffe (XSS, SQL-Injection) gegen den Container', timeoutMs: 45 * 60_000 },
  nuclei: { label: SCAN_STAGE_LABEL.nuclei!, checks: 'Nuclei: offen erreichbare Dateien, Admin-Oberflächen, Standard-Logins', timeoutMs: 15 * 60_000 },
  testssl: { label: SCAN_STAGE_LABEL.testssl!, checks: 'testssl.sh: Zertifikat, Protokolle und Cipher', timeoutMs: 10 * 60_000 },
}

/** Stufenschlüssel ohne Zusatz («trivy-image nginx:1» → «trivy-image»). */
export const baseKey = (name: string) => name.split(' ')[0] as StageKey

export function infoOf(name: string) {
  return STAGE_INFO[baseKey(name)] ?? { label: name, checks: '', timeoutMs: 10 * 60_000 }
}

export const waiting = (name: string): ScanStage => ({ ran: false, state: 'waiting', checks: infoOf(name).checks, timeoutMs: infoOf(name).timeoutMs })
export const skipped = (name: string, reason: string): ScanStage => ({ ran: false, state: 'skipped', note: reason, checks: infoOf(name).checks })

/**
 * Stufen eines Scans von Anfang an, in Pipeline-Reihenfolge: was laufen wird
 * (wartet) und was nicht anwendbar ist (übersprungen, mit Grund).
 */
export function planStages(o: {
  external: boolean
  level: 'standard' | 'active'
  /** Projektart nach effectiveKind: image, dockerfile, compose, static */
  kind?: string
  /** Gibt es einen Quellordner für trivy-source? */
  hasSource?: boolean
  /** Wildcard-Zertifikat aktiv (nur für die Begründung bei testssl) */
  tls?: boolean
}): ScanStages {
  const zapKey = o.level === 'active' ? 'zap-full' : 'zap-baseline'
  if (o.external) {
    return {
      'trivy-image': skipped('trivy-image', 'entfällt bei externen Zielen: kein Image'),
      'trivy-source': skipped('trivy-source', 'entfällt bei externen Zielen: kein Quellcode'),
      headers: waiting('headers'),
      [zapKey]: waiting(zapKey),
      nuclei: waiting('nuclei'),
      testssl: waiting('testssl'),
    }
  }
  const hasImage = o.kind === 'image' || o.kind === 'dockerfile' || o.kind === 'compose'
  return {
    'trivy-image': hasImage ? waiting('trivy-image') : skipped('trivy-image', 'kein Image, statische Seite'),
    'trivy-source': o.hasSource ? waiting('trivy-source') : skipped('trivy-source', 'kein Quellordner: fertiges Image ohne Quellcode'),
    headers: waiting('headers'),
    [zapKey]: waiting(zapKey),
    nuclei: waiting('nuclei'),
    testssl: skipped('testssl', o.tls ? 'TLS endet zentral bei Caddy, siehe Systemseite' : 'nicht anwendbar: intern kein TLS'),
  }
}

/** Wer den Scan ausgelöst hat. */
export type ScanTrigger = 'deploy' | 'mcp' | 'manual' | 'schedule'
export const TRIGGER_LABEL: Record<ScanTrigger, string> = { deploy: 'Deploy', mcp: 'MCP', manual: 'manuell', schedule: 'Zeitplan' }

/* --- Fortschritt aus Logzeilen ---------------------------------------------------- */

/** Zeilen ohne Farbcodes; Fortschrittsbalken (\r) als eigene Zeilen. */
export function logLines(text: string): string[] {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
}

/**
 * Was sich aus den letzten Logzeilen über den Fortschritt sagen lässt. null,
 * wenn nichts Bekanntes dabei ist – dann bleibt die Anzeige bei «läuft».
 */
export function progressOf(name: string, text: string): string | null {
  const lines = logLines(text)
  const key = baseKey(name)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!
    if (key === 'trivy-image' || key === 'trivy-source') {
      // «34.50 MiB / 58.91 MiB [------>____] 58.56% 10.2 MiB p/s»
      const dl = /([\d.]+)\s*MiB\s*\/\s*([\d.]+)\s*MiB/.exec(l)
      if (dl) return `Schwachstellen-Datenbank: ${Math.round(Number(dl[1]))} von ${Math.round(Number(dl[2]))} MB geladen`
      if (/Downloading (vulnerability )?DB|Need to update DB/i.test(l)) return 'Schwachstellen-Datenbank wird geladen'
      if (/Detecting .* vulnerabilities|Number of language-specific files|Detected OS/i.test(l)) return 'Pakete werden geprüft'
      if (/Secret scanning|secret/i.test(l) && /INFO/.test(l)) return 'Suche nach Secrets'
    }
    if (key === 'zap-baseline' || key === 'zap-full') {
      const urls = /Total of (\d+) URLs/i.exec(l)
      if (urls) return `${urls[1]} URLs gecrawlt`
      const active = /Active Scan progress[^\d]*(\d+)%/i.exec(l)
      if (active) return `Aktiver Scan: ${active[1]} %`
      if (/spider/i.test(l)) return 'Seite wird gecrawlt'
    }
    if (key === 'nuclei') {
      const tpl = /Templates loaded for (?:current )?scan:\s*(\d+)/i.exec(l)
      if (tpl) return `${tpl[1]} Vorlagen geladen`
      if (/nuclei-templates|Downloading templates|templates are being/i.test(l)) return 'Vorlagen werden geladen'
    }
  }
  return null
}

/** Die letzten Zeilen für die einklappbare Live-Ausgabe. */
export function tailOf(text: string, n = 12): string[] {
  return logLines(text).slice(-n).map((l) => (l.length > 240 ? `${l.slice(0, 240)} …` : l))
}

/* --- Zusammenfassung --------------------------------------------------------------- */

/** Kurzer Stand für Log und MCP: «3 von 6 Stufen fertig, läuft: ZAP». */
export function summary(stages: ScanStages): string {
  const all = Object.entries(stages)
  const done = all.filter(([, s]) => s.state && s.state !== 'waiting' && s.state !== 'running').length
  const running = all.find(([, s]) => s.state === 'running')
  return `${done} von ${all.length} Stufen erledigt${running ? `, läuft: ${infoOf(running[0]).label}` : ''}`
}

/**
 * Kopf eines Scans für MCP, wie in der Oberfläche: Start, Laufzeit, Auslöser,
 * Position in der Warteschlange, Stand der Stufen.
 */
export function describeScan(
  s: Omit<ScanReportDto['scan'], 'status' | 'level' | 'grade' | 'score' | 'stages'> & { status: string; level: string; stages: ScanStages },
  now = Date.now(),
) {
  const running = s.status === 'queued' || s.status === 'running'
  const end = s.finishedAt ? new Date(s.finishedAt).getTime() : now
  const secs = Math.max(0, Math.round((end - new Date(s.startedAt).getTime()) / 1000))
  return {
    id: s.id,
    status: s.status,
    level: s.level,
    started: s.startedAt,
    finished: s.finishedAt,
    ...(running ? { running_for_s: secs } : { duration_s: secs }),
    triggered_by: s.trigger ? `${TRIGGER_LABEL[s.trigger]}${s.actor ? ` (${s.actor})` : ''}` : null,
    ...(s.queue ? { queue_position: s.queue.position, scans_ahead: s.queue.ahead } : {}),
    progress: summary(s.stages),
    error: s.error,
  }
}

/** Stufen für MCP: Zustand, Dauer, was geprüft wird bzw. wurde, Fortschritt. */
export function describeStages(stages: ScanStages) {
  return Object.entries(stages).map(([name, s]) => ({
    stage: name,
    label: infoOf(name).label,
    state: s.state ?? (s.ran ? 'done' : s.failed ? 'failed' : 'skipped'),
    checks: s.checks ?? infoOf(name).checks,
    ...(s.checked ? { checked: s.checked } : {}),
    ...(s.findings !== undefined ? { findings: s.findings } : {}),
    ...(s.durationMs !== undefined ? { duration_s: Math.round(s.durationMs / 1000) } : {}),
    ...(s.state === 'running' && s.startedAt ? { running_since: s.startedAt } : {}),
    ...(s.timeoutMs ? { timeout_min: Math.round(s.timeoutMs / 60_000) } : {}),
    ...(s.progress ? { progress: s.progress } : {}),
    ...(s.note ? { note: s.note } : {}),
    ...(s.state === 'running' || s.state === 'failed' || s.state === 'timeout' ? { last_output: s.tail?.slice(-5) ?? [] } : {}),
  }))
}

/** Fehlertyp: Zeitlimit einer Stufe überschritten. */
export class StageTimeout extends Error {
  constructor(readonly limitMs: number) {
    super(`Zeitlimit von ${Math.round(limitMs / 60_000)} Min. überschritten – Stufe abgebrochen`)
  }
}

/** Fehlertyp: Scan wurde abgebrochen. */
export class ScanCancelled extends Error {
  constructor(by: string) {
    super(`Abgebrochen von ${by}`)
  }
}

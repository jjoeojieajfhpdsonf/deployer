import { createHash } from 'node:crypto'

/**
 * Bewertung laut SPEC. Reine Funktionen, ohne Datenbank.
 *
 * Score startet bei 100; pro offenem Befund: kritisch −25, hoch −10,
 * mittel −4, niedrig −1, Minimum 0. Note A ab 90, B ab 75, C ab 50, sonst D.
 * Schwelle für «öffentlich»: kein offener kritischer Befund.
 */

export const severities = ['critical', 'high', 'medium', 'low'] as const
export type Severity = (typeof severities)[number]

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'kritisch',
  high: 'hoch',
  medium: 'mittel',
  low: 'niedrig',
}

export const DEDUCTION: Record<Severity, number> = { critical: 25, high: 10, medium: 4, low: 1 }

export type Grade = 'A' | 'B' | 'C' | 'D'

/** Was ein Scanner liefert, bevor es gespeichert wird. */
export interface FindingInput {
  tool: string
  severity: Severity
  title: string
  location: string
  description: string
  fix: string
  /**
   * Stabiler Schlüssel für den Fingerabdruck, wenn Titel oder Ort von Lauf
   * zu Lauf schwanken (Anzahl CVEs im Titel, installierte Version, Image-Tag,
   * erste ZAP-Fundstelle). Ohne Schlüssel zählen Titel und Ort.
   */
  key?: string
}

export function score(open: { severity: Severity }[]): number {
  const total = open.reduce((s, f) => s + DEDUCTION[f.severity], 0)
  return Math.max(0, 100 - total)
}

export function grade(s: number): Grade {
  if (s >= 90) return 'A'
  if (s >= 75) return 'B'
  if (s >= 50) return 'C'
  return 'D'
}

/**
 * Fingerabdruck eines Befunds: Werkzeug, Titel, Stelle. Damit bleibt ein
 * akzeptierter Befund akzeptiert, wenn er im nächsten Scan wieder auftaucht.
 */
export function fingerprint(f: Pick<FindingInput, 'tool' | 'title' | 'location' | 'key'>): string {
  if (f.key) return createHash('sha256').update(`${f.tool}\0key\0${f.key.replace(/[a-z][a-z0-9+.-]*:\/\/[^/\s]+/gi, '')}`).digest('hex').slice(0, 32)
  return createHash('sha256').update(`${f.tool}\0${f.title}\0${stripOrigin(f.location)}`).digest('hex').slice(0, 32)
}

/**
 * Nur der Pfad einer URL zählt, nicht Schema und Host: die ändern sich mit
 * jedem Deploy (Containername) oder wenn die Basisdomain gesetzt wird. Eine
 * Akzeptanz soll das überleben.
 */
const stripOrigin = (s: string) => s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/\s]+/i, '')

/** Reihenfolge für "die wichtigsten Befunde". */
export function bySeverity<T extends { severity: Severity }>(a: T, b: T): number {
  return severities.indexOf(a.severity) - severities.indexOf(b.severity)
}

export function publishable(scanExists: boolean, open: { severity: Severity; title: string }[]): { ok: true } | { ok: false; reason: string } {
  if (!scanExists) return { ok: false, reason: 'Es liegt noch kein abgeschlossener Scan vor' }
  const critical = open.filter((f) => f.severity === 'critical')
  if (critical.length) {
    return {
      ok: false,
      reason: `Offene kritische Befunde: ${critical.map((f) => f.title).join('; ')}. Beheben oder mit Begründung akzeptieren.`,
    }
  }
  return { ok: true }
}

/** Gleiche Befunde (gleicher Fingerabdruck) nur einmal. */
export function dedupe(findings: FindingInput[]): FindingInput[] {
  const seen = new Map<string, FindingInput>()
  for (const f of findings) {
    const fp = fingerprint(f)
    const prev = seen.get(fp)
    if (!prev || bySeverity(f, prev) < 0) seen.set(fp, f)
  }
  return [...seen.values()]
}

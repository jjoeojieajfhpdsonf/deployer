import { severityRank, type IncidentSeverity, type IncidentStatus } from '@airlock/shared'
import { fingerprintOf, maxSeverity, type Signal } from './rules.js'

/**
 * Nacht 3, Etappe 5: Bündeln und Drosseln – reine Funktionen.
 *
 * Gleiche Hinweise (gleicher Fingerabdruck: Projekt, Art, Schlüssel) landen
 * im selben Vorfall, solange er nicht erledigt ist: Zähler hoch, letzte
 * Beispiele vorn, Schweregrad höchstens hinauf. Ist er erledigt, beginnt der
 * nächste Hinweis einen neuen Vorfall.
 */

export interface OpenIncident {
  id: string
  fingerprint: string
  severity: IncidentSeverity
  status: IncidentStatus
  count: number
  samples: string[]
  lastSeen: Date
  /** Wann zuletzt «erneut» in den Verlauf geschrieben (höchstens stündlich) */
  repeatLoggedAt: Date | null
}

export interface NewIncident {
  fingerprint: string
  signal: Signal
  count: number
  samples: string[]
}

export interface IncidentUpdate {
  id: string
  count: number
  severity: IncidentSeverity
  /** gesehen → offen, wenn der Schweregrad steigt */
  status: IncidentStatus
  samples: string[]
  lastSeen: Date
  /** Schweregrad vorher, wenn er gestiegen ist */
  escalatedFrom: IncidentSeverity | null
  /** «erneut» in den Verlauf schreiben */
  logRepeat: boolean
  added: number
}

export const MAX_SAMPLES = 20
const REPEAT_LOG_MS = 60 * 60_000

/** Neue Beispiele vorn, ohne Doppelte, höchstens 20 */
export function mergeSamples(fresh: readonly string[], old: readonly string[]): string[] {
  return [...new Set([...fresh, ...old])].slice(0, MAX_SAMPLES)
}

/** Hinweise derselben Runde mit gleichem Fingerabdruck zusammenlegen */
export function mergeSignals(signals: readonly Signal[]): Map<string, Signal> {
  const out = new Map<string, Signal>()
  for (const s of signals) {
    const fp = fingerprintOf(s)
    const prev = out.get(fp)
    if (!prev) { out.set(fp, { ...s, samples: [...s.samples] }); continue }
    if (s.initialCount !== undefined || prev.initialCount !== undefined) prev.initialCount = (prev.initialCount ?? prev.count) + (s.initialCount ?? s.count)
    prev.count += s.count
    // Titel der schwereren Art behalten
    if (severityRank(s.severity) > severityRank(prev.severity)) prev.title = s.title
    prev.severity = maxSeverity(prev.severity, s.severity)
    prev.samples = mergeSamples(s.samples, prev.samples)
    if (s.at > prev.at) prev.at = s.at
  }
  return out
}

export function bundleSignals(open: readonly OpenIncident[], signals: readonly Signal[]): { create: NewIncident[]; update: IncidentUpdate[] } {
  const byFp = new Map(open.filter((o) => o.status !== 'erledigt').map((o) => [o.fingerprint, o]))
  const create: NewIncident[] = []
  const update: IncidentUpdate[] = []
  for (const [fp, s] of mergeSignals(signals)) {
    if (s.count <= 0 && !s.initialCount) continue
    const o = byFp.get(fp)
    if (!o) {
      create.push({ fingerprint: fp, signal: s, count: Math.max(s.initialCount ?? 0, s.count), samples: s.samples.slice(0, MAX_SAMPLES) })
      continue
    }
    const severity = maxSeverity(o.severity, s.severity)
    const escalated = severityRank(severity) > severityRank(o.severity)
    update.push({
      id: o.id,
      count: o.count + s.count,
      severity,
      status: escalated && o.status === 'gesehen' ? 'offen' : o.status,
      samples: mergeSamples(s.samples, o.samples),
      lastSeen: s.at > o.lastSeen ? s.at : o.lastSeen,
      escalatedFrom: escalated ? o.severity : null,
      logRepeat: !escalated && (!o.repeatLoggedAt || s.at.getTime() - o.repeatLoggedAt.getTime() >= REPEAT_LOG_MS),
      added: s.count,
    })
  }
  return { create, update }
}

/* --- Benachrichtigen (ntfy/E-Mail) ------------------------------------------------------- */

/** Höchstens so viele Meldungen über Vorfälle pro Stunde (alle zusammen) */
export const NOTIFY_PER_HOUR = 5
/** Ein weiter laufender Vorfall wird frühestens nach einem Tag noch einmal gemeldet */
export const NOTIFY_REPEAT_MS = 24 * 60 * 60_000

export interface NotifyState {
  severity: IncidentSeverity
  notifiedAt: Date | null
  notifiedSeverity: IncidentSeverity | null
  /** Meldungen über Vorfälle in der letzten Stunde (alle) */
  sentLastHour: number
  now: Date
}

/**
 * Nur hoch und kritisch, je Vorfall einmal – wieder, wenn er schwerer wird
 * oder nach einem Tag noch läuft. Dazu eine Obergrenze für alle zusammen:
 * auch eine Flut neuer Vorfälle ergibt höchstens 5 Meldungen pro Stunde
 * (der Rest steht unter Security › Vorfälle).
 */
export function shouldNotify(s: NotifyState): boolean {
  if (severityRank(s.severity) < severityRank('hoch')) return false
  if (s.sentLastHour >= NOTIFY_PER_HOUR) return false
  if (!s.notifiedAt) return true
  if (s.notifiedSeverity && severityRank(s.severity) > severityRank(s.notifiedSeverity)) return true
  return s.now.getTime() - s.notifiedAt.getTime() >= NOTIFY_REPEAT_MS
}

/** Automatisch stoppen und pausieren: nur kritisch, nur mit Schalter, je Vorfall einmal */
export function shouldAutoStop(o: { severity: IncidentSeverity; autoStop: boolean; reactedAt: Date | null; projectId: string | null }): boolean {
  return o.autoStop && o.projectId !== null && o.severity === 'kritisch' && !o.reactedAt
}

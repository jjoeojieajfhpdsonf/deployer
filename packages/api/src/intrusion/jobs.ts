import { inArray, lt, and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { onEgressAttempts } from '../egress/service.js'
import type { EgressAttemptRow } from '../egress/events.js'
import { subscribe } from '../lib/events.js'
import { log } from '../lib/log.js'
import { checkSites, collectContainers, collectLogins, pruneContainers, type CollectOptions } from './collect.js'
import { evaluateEgress, type EgressRow, type Signal } from './rules.js'
import { recordSignals, type RecordResult } from './store.js'
import { webScans } from './web.js'

/**
 * Nacht 3, Etappe 5: die Runden der Einbruchserkennung.
 *
 * - jede Minute: Anmeldung, Prozesse und Neustarts aller laufenden
 *   Projekt-Container (docker top/inspect), Dateien (docker diff) beim
 *   Lernen jede Runde, danach alle 5 Minuten; Web-Scans (Zähler aus dem
 *   Besucher-Log)
 * - alle 15 s (Etappe 4 meldet sich): gesperrte Ausgangsversuche
 * - stündlich und kurz nach jedem Deploy: Dateien statischer Seiten
 */

let busy = false
let lastRound: { at: Date; containers: number; learning: number; errors: number } | null = null
export const lastIntrusionRound = () => lastRound

/** Eine Runde über Container und Anmeldung (auch für die CLI) */
export async function runIntrusionRound(o: CollectOptions & { logins?: boolean; notify?: boolean } = {}): Promise<{ signals: Signal[]; recorded: RecordResult; containers: number; learning: number; errors: string[]; projectIds: string[] }> {
  const now = o.now ?? new Date()
  const signals: Signal[] = []
  const errors: string[] = []
  if (o.logins !== false) signals.push(...(await collectLogins(now).catch((err) => { errors.push(`Anmeldung: ${String(err)}`); return [] })))
  const c = await collectContainers({ ...o, now })
  signals.push(...c.signals)
  errors.push(...c.errors)
  const recorded = await recordSignals(signals, { notify: o.notify })
  lastRound = { at: now, containers: c.containers, learning: c.learning, errors: errors.length }
  return { signals, recorded, containers: c.containers, learning: c.learning, errors, projectIds: c.projectIds }
}

/** Etappe 4 meldet neu gezählte Versuche; nur gesperrte zählen (beobachtete sperren nichts) */
export async function egressSignals(rows: readonly EgressAttemptRow[]): Promise<void> {
  const blocked: EgressRow[] = rows.filter((r) => r.verdict === 'gesperrt')
  if (!blocked.length) return
  const ids = [...new Set(blocked.map((r) => r.projectId))]
  const allow = await db.select().from(schema.intrusionAllow).where(and(inArray(schema.intrusionAllow.projectId, ids), eq(schema.intrusionAllow.kind, 'netz')))
  const byProject = new Map<string, Set<string>>()
  for (const a of allow) byProject.set(a.projectId, (byProject.get(a.projectId) ?? new Set()).add(a.value))
  await recordSignals(evaluateEgress(blocked, (id) => byProject.get(id) ?? new Set(), new Date()))
}

export function startIntrusionJobs(): NodeJS.Timeout[] {
  const minute = () => {
    if (busy) return
    busy = true
    void runIntrusionRound()
      .then(async () => {
        const web = webScans.drain(new Date())
        if (web.length) await recordSignals(web)
      })
      .catch((err) => log.warn('Runde der Einbruchserkennung gescheitert', { err: String(err) }))
      .finally(() => { busy = false })
  }
  const sites = (projectId?: string) => void checkSites({ projectId })
    .then((s) => recordSignals(s))
    .catch((err) => log.warn('Statische Seiten nicht geprüft', { err: String(err) }))
  const hourly = () => {
    sites()
    void pruneContainers().catch(() => {})
    // Erledigte Vorfälle nach einem Jahr entfernen (der Verlauf geht mit)
    void db.delete(schema.incidents).where(and(eq(schema.incidents.status, 'erledigt'), lt(schema.incidents.lastSeen, new Date(Date.now() - 365 * 86_400_000)))).catch(() => {})
  }
  onEgressAttempts((rows) => void egressSignals(rows).catch((err) => log.warn('Ausgangsversuche nicht bewertet', { err: String(err) })))
  // Nach einem Deploy: Prüfsummen der neuen Fassung bald festhalten (statische Seiten)
  subscribe((e) => {
    if (e.type !== 'deploy' || e.status !== 'active' || !e.projectId) return
    const id = e.projectId
    setTimeout(() => sites(id), 30_000).unref()
  })
  const first = setTimeout(minute, 30_000)
  const firstSites = setTimeout(() => sites(), 2 * 60_000)
  const a = setInterval(minute, 60_000)
  const b = setInterval(hourly, 60 * 60_000)
  for (const t of [first, firstSites, a, b]) t.unref()
  return [a, b]
}

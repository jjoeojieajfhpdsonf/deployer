import { createHash } from 'node:crypto'
import {
  availabilityOf, dayInZone, overallOf, statusDays, STATUS_DAYS, STATUS_PAST_DAYS,
  type IncidentState, type PublicProjectState, type PublicStatusIncident, type PublicStatusJson, type StatusDayCount,
} from '@airlock/shared'

/**
 * Etappe 5: Was öffentlich wird – rein, ohne Datenbank. Jedes Objekt wird
 * hier Feld für Feld neu gebaut (Erlaubnisliste): Was nicht ausdrücklich
 * übernommen wird, kann nicht auf die Seite rutschen – keine IDs, Kurznamen,
 * Hostnamen, IPs, Versionen oder Fehlertexte.
 */

export interface SnapshotProject {
  id: string
  name: string
  state: PublicProjectState
  counts: StatusDayCount[]
}

export interface SnapshotIncident {
  id: string
  title: string
  state: IncidentState
  createdAt: Date
  resolvedAt: Date | null
  projectIds: string[]
  /** Neueste zuerst */
  updates: { state: IncidentState; body: string; createdAt: Date }[]
}

/** Kurzer, nicht umkehrbarer Schlüssel für Anker und RSS (nie die Datenbank-ID) */
export const incidentKey = (id: string): string => createHash('sha256').update(`airlock-status:${id}`).digest('hex').slice(0, 12)

/** Eine Störung, wie sie öffentlich erscheint; nur Namen von Projekten auf der Seite. */
export function publicIncident(i: SnapshotIncident, shownNames: ReadonlyMap<string, string>): PublicStatusIncident {
  return {
    key: incidentKey(i.id),
    title: i.title,
    state: i.state,
    startedAt: i.createdAt.toISOString(),
    resolvedAt: i.resolvedAt?.toISOString() ?? null,
    projects: i.projectIds.map((id) => shownNames.get(id)).filter((n): n is string => Boolean(n)),
    updates: i.updates.map((u) => ({ at: u.createdAt.toISOString(), state: u.state, text: u.body })),
  }
}

/**
 * Auf der Seite: offene Störungen und die behobenen der letzten 14 Tage.
 * Eine automatische Störung zu einem Projekt, das nicht (mehr) auf der Seite
 * steht, bleibt weg – sie würde seinen Namen verraten.
 */
export function visibleIncidents(incidents: readonly SnapshotIncident[], shown: ReadonlySet<string>, now: Date, auto: ReadonlySet<string> = new Set()): SnapshotIncident[] {
  const since = now.getTime() - STATUS_PAST_DAYS * 86_400_000
  return incidents
    .filter((i) => !auto.has(i.id) || i.projectIds.every((p) => shown.has(p)))
    .filter((i) => i.state !== 'behoben' || (i.resolvedAt ?? i.createdAt).getTime() >= since)
    .sort((a, b) => Number(a.state === 'behoben') - Number(b.state === 'behoben') || b.createdAt.getTime() - a.createdAt.getTime())
}

/** RSS: die letzten `max` Störungen (neueste zuerst), dieselbe Regel für automatische wie auf der Seite. */
export function feedIncidents(incidents: readonly SnapshotIncident[], shownNames: ReadonlyMap<string, string>, auto: ReadonlySet<string>, max = 50): PublicStatusIncident[] {
  return [...incidents]
    .filter((i) => !auto.has(i.id) || i.projectIds.every((p) => shownNames.has(p)))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, max)
    .map((i) => publicIncident(i, shownNames))
}

export interface SnapshotInput {
  title: string
  now: Date
  timeZone: string
  /** Nur Projekte, die auf der Seite stehen */
  projects: SnapshotProject[]
  incidents: SnapshotIncident[]
  /** IDs automatisch angelegter Störungen */
  autoIncidents?: ReadonlySet<string>
}

export function buildPublicStatus(input: SnapshotInput): PublicStatusJson {
  const today = dayInZone(input.now, input.timeZone)
  const shownNames = new Map(input.projects.map((p) => [p.id, p.name]))
  const projects = [...input.projects]
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
    .map((p) => {
      const days = statusDays(p.counts, today, STATUS_DAYS)
      const inRange = new Set(days.map((d) => d.date))
      return {
        name: p.name,
        state: p.state,
        availability: availabilityOf(p.counts.filter((c) => inRange.has(c.date))),
        days,
      }
    })
  const incidents = visibleIncidents(input.incidents, new Set(shownNames.keys()), input.now, input.autoIncidents)
    .map((i) => publicIncident(i, shownNames))
  return {
    version: 1,
    title: input.title,
    generatedAt: input.now.toISOString(),
    timeZone: input.timeZone,
    overall: overallOf(projects, incidents),
    incidents,
    projects,
  }
}

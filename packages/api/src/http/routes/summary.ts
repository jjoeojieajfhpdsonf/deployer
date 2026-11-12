import type { FastifyInstance, FastifyRequest } from 'fastify'
import { and, gte, inArray } from 'drizzle-orm'
import { addDays, availabilityOf, dayInZone, type ProjectDto, type SummaryDto, type TrafficSourceDto } from '@airlock/shared'
import { db, schema } from '../../db/index.js'
import { listProjects } from '../../domain/projects.js'
import { environmentById } from '../../domain/environments.js'
import { displayTimeZone } from '../../domain/pause-page.js'
import { buildSummary } from '../../domain/summary.js'
import { currentCert } from '../../jobs/cert.js'
import { daysLeftOf } from '../../lib/cert.js'
import { trafficIngestState, trafficToday } from '../../traffic/service.js'
import { listScopeFor } from '../scope.js'

export interface SummaryRouteDeps {
  projects: (request: FastifyRequest) => Promise<{ environment: string; projects: ProjectDto[] }>
  visitors: () => Promise<Record<string, number>>
  ingest: () => TrafficSourceDto['ingest']
  uptime: (projectIds: string[], now: Date) => Promise<Map<string, { h24: number | null; d30: number | null }>>
  certificate: () => Promise<{ expiresAt: string | null; daysLeft: number | null } | null>
  now: () => Date
}

/** Verfügbarkeit aus der Messung der Statusseite (Tagesauflösung): heute + gestern, 30 Tage */
async function uptimeOf(projectIds: string[], now: Date): Promise<Map<string, { h24: number | null; d30: number | null }>> {
  const out = new Map<string, { h24: number | null; d30: number | null }>()
  if (!projectIds.length) return out
  const today = dayInZone(now, displayTimeZone())
  const from30 = addDays(today, -29)
  const from2 = addDays(today, -1)
  const rows = await db.select().from(schema.statusDaily)
    .where(and(inArray(schema.statusDaily.projectId, projectIds), gte(schema.statusDaily.day, from30)))
  for (const id of projectIds) {
    const mine = rows.filter((r) => r.projectId === id)
    if (!mine.length) continue
    out.set(id, { h24: availabilityOf(mine.filter((r) => r.day >= from2)), d30: availabilityOf(mine) })
  }
  return out
}

const realDeps: SummaryRouteDeps = {
  projects: async (request) => {
    const scope = listScopeFor(request)
    return { environment: environmentById(scope.envId)?.name ?? '', projects: await listProjects(scope) }
  },
  visitors: async () => (await trafficToday()).visitors,
  ingest: trafficIngestState,
  uptime: uptimeOf,
  certificate: async () => {
    const c = await currentCert().catch(() => null)
    return c ? { expiresAt: c.validTo, daysLeft: daysLeftOf(c) } : null
  },
  now: () => new Date(),
}

/**
 * Abgrenzung HomeBento – lesende Übersicht für Dashboards.
 *
 * GET /summary (auch /environments/:env/summary)
 *      Projekte der Umgebung mit Zustand, Hauptadresse, öffentlich ja/nein,
 *      Note, offenen Befunden, «braucht Aufmerksamkeit» samt Grund, Besuchern
 *      heute, Verfügbarkeit (24 h / 30 Tage), Zertifikat-Ablauf und laufenden
 *      Deploys (SummaryDto). Erreichbar mit Anmeldung, einem vollen Token und
 *      als EINZIGE Route mit einem Token «lesen» (http/auth.ts).
 */
export async function summaryRoutes(app: FastifyInstance, opts: { deps?: Partial<SummaryRouteDeps> } = {}): Promise<void> {
  const d: SummaryRouteDeps = { ...realDeps, ...opts.deps }
  const summary = async (request: FastifyRequest): Promise<SummaryDto> => {
    const now = d.now()
    const { environment, projects } = await d.projects(request)
    const [visitors, uptime, certificate] = await Promise.all([
      d.visitors().catch(() => ({})),
      d.uptime(projects.map((p) => p.id), now),
      d.certificate(),
    ])
    const ids = new Set(projects.map((p) => p.id))
    return buildSummary({
      now, environment, projects, ingest: d.ingest(), uptime, certificate,
      // nur Projekte dieser Umgebung
      visitors: Object.fromEntries(Object.entries(visitors).filter(([id]) => ids.has(id))),
    })
  }
  app.get('/summary', summary)
  app.get('/environments/:env/summary', summary)
}

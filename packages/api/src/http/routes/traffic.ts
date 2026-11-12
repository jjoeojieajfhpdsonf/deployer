import type { FastifyInstance, FastifyRequest } from 'fastify'
import { TRAFFIC_WAYS, isTrafficRange, type TrafficTodayDto, type TrafficWay } from '@airlock/shared'
import { findProject, listProjectRows } from '../../domain/projects.js'
import { audit } from '../../domain/audit.js'
import { badRequest } from '../../lib/errors.js'
import { trackStream } from '../../lib/events.js'
import { CITY_DB_SOURCE } from '../../traffic/geo.js'
import { cityDb, onTrafficLive, trafficIngestState, trafficSummary, trafficToday } from '../../traffic/service.js'
import { listScopeFor } from '../scope.js'

interface IdParams {
  id: string
}

/** Austauschbar für Tests (ohne Datenbank) */
export interface TrafficRouteDeps {
  findProject: (request: FastifyRequest, id: string) => Promise<{ id: string }>
  summary: typeof trafficSummary
  onLive: typeof onTrafficLive
  /** IDs der Projekte, die die Anfrage sehen darf (Umgebung, Token) */
  visibleProjects: (request: FastifyRequest) => Promise<Set<string>>
  today: typeof trafficToday
  ingestState: typeof trafficIngestState
}

const realDeps: TrafficRouteDeps = {
  ingestState: trafficIngestState,
  findProject: (request, id) => findProject(request.scope, id),
  summary: trafficSummary,
  onLive: onTrafficLive,
  visibleProjects: async (request) => new Set((await listProjectRows(listScopeFor(request))).map((p) => p.id)),
  today: trafficToday,
}

/**
 * Etappe 3 «Besucher und Herkunft».
 *
 * GET  /projects/:id/traffic?range=24h|7d|30d&way=all|public|tailnet|lan
 *      Auswertung (TrafficSummaryDto)
 * GET  /projects/:id/traffic/live
 *      Live-Strom (Server-Sent Events): je Anfrage eine Nachricht
 *      `data: <TrafficLiveEventDto als JSON>`, zu Beginn der Kommentar
 *      `: verbunden`, danach alle 20 s `: ping`. Ohne IP, Pfad, User-Agent.
 * GET  /traffic/today (auch /environments/:env/traffic/today)
 *      Aufrufe heute je Projekt der Umgebung (Projektliste)
 * GET  /system/traffic/city-db, POST …/city-db, DELETE …/city-db
 *      Städte-Datenbank (DB-IP) – laden und entfernen nur mit Anmeldung (auth.ts)
 */
export async function trafficRoutes(app: FastifyInstance, opts: { heartbeatMs?: number; deps?: Partial<TrafficRouteDeps> } = {}): Promise<void> {
  const d: TrafficRouteDeps = { ...realDeps, ...opts.deps }

  app.get<{ Params: IdParams; Querystring: { range?: string; way?: string } }>('/projects/:id/traffic', async (request) => {
    const project = await d.findProject(request, request.params.id)
    const range = request.query.range ?? '24h'
    if (!isTrafficRange(range)) throw badRequest('range: 24h, 7d oder 30d')
    const way = (request.query.way ?? 'all') as TrafficWay | 'all'
    if (way !== 'all' && !TRAFFIC_WAYS.includes(way)) throw badRequest('way: all, public, tailnet oder lan')
    return d.summary(project.id, range, way)
  })

  app.get<{ Params: IdParams }>('/projects/:id/traffic/live', async (request, reply) => {
    const project = await d.findProject(request, request.params.id)
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    reply.raw.write(': verbunden\n\n')
    let closed = false
    const off = d.onLive(project.id, (e) => { if (!closed) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`) })
    const keepalive = setInterval(() => { if (!closed) reply.raw.write(': ping\n\n') }, opts.heartbeatMs ?? 20_000)
    const close = () => {
      if (closed) return
      closed = true
      clearInterval(keepalive)
      off()
      untrack()
      reply.raw.end()
    }
    // Beim Herunterfahren schliessen (sonst wartet app.close())
    const untrack = trackStream(close)
    request.raw.on('close', close)
    return reply
  })

  const today = async (request: FastifyRequest): Promise<TrafficTodayDto> => {
    const ids = await d.visibleProjects(request)
    const all = await d.today()
    return { views: Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id))), ingest: d.ingestState() }
  }
  app.get('/traffic/today', today)
  app.get('/environments/:env/traffic/today', today)

  app.get('/system/traffic/city-db', async () => ({ ...CITY_DB_SOURCE, month: cityDb.month, downloadedAt: cityDb.current?.downloadedAt ?? null }))
  app.post('/system/traffic/city-db', async (request) => {
    try {
      const info = await cityDb.download()
      await audit({ actor: request.actor, action: 'traffic.city_db', targetType: 'system', targetId: null, params: { month: info.month }, result: 'ok' })
      return { ...CITY_DB_SOURCE, month: info.month, downloadedAt: info.downloadedAt }
    } catch (err) {
      await audit({ actor: request.actor, action: 'traffic.city_db', targetType: 'system', targetId: null, params: {}, result: 'error', error: (err as Error).message })
      throw badRequest((err as Error).message)
    }
  })
  app.delete('/system/traffic/city-db', async (request) => {
    await cityDb.remove()
    await audit({ actor: request.actor, action: 'traffic.city_db.remove', targetType: 'system', targetId: null, params: {}, result: 'ok' })
    return { ...CITY_DB_SOURCE, month: null, downloadedAt: null }
  })
}

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { TRAFFIC_RANGES, TRAFFIC_WAYS, isTrafficRange, type TrafficRecentDto, type TrafficTodayDto, type TrafficWay } from '@airlock/shared'
import { findProject, listProjectRows } from '../../domain/projects.js'
import { audit } from '../../domain/audit.js'
import { badRequest } from '../../lib/errors.js'
import { trackStream } from '../../lib/events.js'
import { ASN_DB_SOURCE, CITY_DB_SOURCE, type DbipDb } from '../../traffic/geo.js'
import { asnDb, cityDb, onTrafficLive, trafficGeoSources, trafficIngestState, trafficRecent, trafficSummary, trafficToday } from '../../traffic/service.js'
import { listScopeFor } from '../scope.js'

interface IdParams {
  id: string
}

/** Austauschbar für Tests (ohne Datenbank) */
export interface TrafficRouteDeps {
  findProject: (request: FastifyRequest, id: string) => Promise<{ id: string }>
  summary: typeof trafficSummary
  onLive: typeof onTrafficLive
  recent: typeof trafficRecent
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
  recent: trafficRecent,
  visibleProjects: async (request) => new Set((await listProjectRows(listScopeFor(request))).map((p) => p.id)),
  today: trafficToday,
}

/**
 * Etappe 3 «Besucher und Herkunft», erweitert mit «Besucher neu».
 *
 * GET  /projects/:id/traffic?range=today|24h|7d|30d|12m&way=all|public|tailnet|lan
 *      Auswertung (TrafficSummaryDto)
 * GET  /projects/:id/traffic/live
 *      Live-Strom (Server-Sent Events): je Anfrage eine Nachricht
 *      `data: <TrafficLiveEventDto als JSON>`, zu Beginn der Kommentar
 *      `: verbunden`, danach alle 20 s `: ping`. Ohne IP, ohne User-Agent,
 *      ohne Kennung; Pfad und Herkunft nur bei gezählten Seitenaufrufen.
 * GET  /projects/:id/traffic/recent
 *      Letzte gezählte Seitenaufrufe aus dem Speicher («Gerade eben»)
 * GET  /traffic/today (auch /environments/:env/traffic/today)
 *      Aufrufe heute je Projekt der Umgebung (Projektliste)
 * GET  /system/traffic/sources
 *      Stand der DB-IP-Dateien und ob Cloudflare Städte schickt
 * GET  /system/traffic/city-db, POST …/city-db, DELETE …/city-db
 * GET  /system/traffic/asn-db,  POST …/asn-db,  DELETE …/asn-db
 *      Städte- bzw. Provider-Datenbank (DB-IP) – laden und entfernen nur mit Anmeldung (auth.ts)
 */
export async function trafficRoutes(app: FastifyInstance, opts: { heartbeatMs?: number; deps?: Partial<TrafficRouteDeps> } = {}): Promise<void> {
  const d: TrafficRouteDeps = { ...realDeps, ...opts.deps }

  app.get<{ Params: IdParams; Querystring: { range?: string; way?: string } }>('/projects/:id/traffic', async (request) => {
    const project = await d.findProject(request, request.params.id)
    const range = request.query.range ?? '24h'
    if (!isTrafficRange(range)) throw badRequest(`range: ${TRAFFIC_RANGES.map((r) => r.key).join(', ')}`)
    const way = (request.query.way ?? 'all') as TrafficWay | 'all'
    if (way !== 'all' && !TRAFFIC_WAYS.includes(way)) throw badRequest('way: all, public, tailnet oder lan')
    return d.summary(project.id, range, way)
  })

  app.get<{ Params: IdParams }>('/projects/:id/traffic/recent', async (request): Promise<TrafficRecentDto> => {
    const project = await d.findProject(request, request.params.id)
    return { events: d.recent(project.id) }
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

  app.get('/system/traffic/sources', async () => trafficGeoSources())

  // Städte- und Provider-Datenbank: gleiche Routen, eigene Audit-Aktion
  const dbipRoutes = (path: string, file: DbipDb, source: { name: string; license: string; url: string }, action: string) => {
    app.get(`/system/traffic/${path}`, async () => ({ ...source, month: file.month, downloadedAt: file.current?.downloadedAt ?? null }))
    app.post(`/system/traffic/${path}`, async (request) => {
      try {
        const info = await file.download()
        await audit({ actor: request.actor, action, targetType: 'system', targetId: null, params: { month: info.month }, result: 'ok' })
        return { ...source, month: info.month, downloadedAt: info.downloadedAt }
      } catch (err) {
        await audit({ actor: request.actor, action, targetType: 'system', targetId: null, params: {}, result: 'error', error: (err as Error).message })
        throw badRequest((err as Error).message)
      }
    })
    app.delete(`/system/traffic/${path}`, async (request) => {
      await file.remove()
      await audit({ actor: request.actor, action: `${action}.remove`, targetType: 'system', targetId: null, params: {}, result: 'ok' })
      return { ...source, month: null, downloadedAt: null }
    })
  }
  dbipRoutes('city-db', cityDb, CITY_DB_SOURCE, 'traffic.city_db')
  dbipRoutes('asn-db', asnDb, ASN_DB_SOURCE, 'traffic.asn_db')
}

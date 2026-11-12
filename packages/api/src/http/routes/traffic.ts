import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  LOG_RANGES, TRAFFIC_RANGES, TRAFFIC_WAYS, isTrafficRange, rangeMinutes,
  type AccessListDto, type TrafficRecentDto, type TrafficTodayDto, type TrafficWay,
} from '@airlock/shared'
import { findProject, listProjectRows } from '../../domain/projects.js'
import { audit } from '../../domain/audit.js'
import { badRequest } from '../../lib/errors.js'
import { trackStream } from '../../lib/events.js'
import { ASN_DB_SOURCE, CITY_DB_SOURCE, type DbipDb } from '../../traffic/geo.js'
import {
  accessSince, asnDb, cityDb, onAccessLive, onTrafficLive, projectAccess, trafficGeoSources, trafficIngestState, trafficRecent, trafficSummary, trafficToday,
} from '../../traffic/service.js'
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
  /** Zugriffe neu */
  access: typeof projectAccess
  onAccess: typeof onAccessLive
  accessSince: typeof accessSince
}

const realDeps: TrafficRouteDeps = {
  access: projectAccess,
  onAccess: onAccessLive,
  accessSince,
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
 * GET  /projects/:id/access?range=15m|1h|24h
 *      Zugriffe neu: einzelne Anfragen aus visits.log (AccessListDto), IP gekürzt
 * GET  /projects/:id/access/stream?since=<ISO>
 *      Neue Anfragen live (`data: <AccessEntryDto>`), mit since lückenloser Anschluss
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

  /** SSE-Antwort mit Herzschlag; subscribe bekommt die Schreibfunktion und gibt die Abmeldung zurück */
  const sse = (request: FastifyRequest, reply: FastifyReply, subscribe: (write: (data: unknown) => void) => () => void) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    reply.raw.write(': verbunden\n\n')
    let closed = false
    const off = subscribe((e) => { if (!closed) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`) })
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
  }

  // Zugriffe neu: einzelne Anfragen aus visits.log (15m | 1h | 24h, Standard 24h), IP gekürzt
  app.get<{ Params: IdParams; Querystring: { range?: string } }>('/projects/:id/access', async (request): Promise<AccessListDto> => {
    const project = await d.findProject(request, request.params.id)
    const range = request.query.range ?? '24h'
    if (!LOG_RANGES.some((r) => r.key === range)) throw badRequest(`range: ${LOG_RANGES.map((r) => r.key).join(', ')}`)
    return d.access(project.id, Date.now() - rangeMinutes(range) * 60_000)
  })

  // Neue Anfragen live; ?since= (Zeit der neuesten bekannten) schliesst lückenlos aus dem Speicher an
  app.get<{ Params: IdParams; Querystring: { since?: string } }>('/projects/:id/access/stream', async (request, reply) => {
    const project = await d.findProject(request, request.params.id)
    const sinceMs = request.query.since ? Date.parse(request.query.since) : NaN
    return sse(request, reply, (write) => {
      if (Number.isFinite(sinceMs)) for (const e of d.accessSince(project.id, new Date(sinceMs).toISOString())) write(e)
      return d.onAccess(project.id, write)
    })
  })

  app.get<{ Params: IdParams }>('/projects/:id/traffic/live', async (request, reply) => {
    const project = await d.findProject(request, request.params.id)
    return sse(request, reply, (write) => d.onLive(project.id, write))
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

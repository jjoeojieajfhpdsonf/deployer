import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { TrafficLiveEventDto, TrafficRange, TrafficSourceDto, TrafficSummaryDto, TrafficWay } from '@airlock/shared'
import { config } from '../config.js'
import { db, getSetting, schema, setSetting } from '../db/index.js'
import { effectiveKind } from '../domain/deployments.js'
import { aliasesForHost } from '../domain/routes.js'
import { displayTimeZone } from '../domain/pause-page.js'
import { publish, subscribe } from '../lib/events.js'
import { log } from '../lib/log.js'
import { VISITS_LOG_FILE } from '../drivers/caddy-config.js'
import { TrafficAggregator } from './aggregate.js'
import { CityDb, cityDbDue } from './geo.js'
import { TrafficProcessor, type HostInfo } from './ingest.js'
import { startTrafficRetentionJob } from './retention.js'
import { pgTrafficStore, type TrafficStore } from './store.js'
import { rangeStart, startOfToday, summarize } from './summary.js'
import { LogTail, type TailPosition } from './tail.js'
import { VisitorCounter } from './visitor.js'
import { webScans } from '../intrusion/web.js'

/**
 * Besucher-Ingest im Betrieb: liest Caddys Zugriffs-Log (Datei im Volume
 * caddy_access) fortlaufend, verteilt jede Anfrage an den Live-Strom des
 * Projekts und schreibt die Stundenzähler einmal pro Minute in die
 * Datenbank. Dazu Abfragen für Oberfläche und MCP.
 */

const POLL_MS = 1_000
const FLUSH_MS = 60_000
const HOSTS_MS = 60_000
const POS_KEY = 'traffic_ingest_pos'

const store: TrafficStore = pgTrafficStore
const aggregator = new TrafficAggregator()
const visitors = new VisitorCounter(displayTimeZone())
export const cityDb = new CityDb(join(config.DATA_DIR, 'geoip'))
const hasPages = new Set<string>()
let hosts = new Map<string, HostInfo>()
let state: TrafficSourceDto['ingest'] = config.ACCESS_LOG_DIR ? 'waiting' : 'off'

const bus = new EventEmitter()
bus.setMaxListeners(0)

/** Live-Strom eines Projekts abonnieren; gibt die Abmeldung zurück */
export function onTrafficLive(projectId: string, fn: (e: TrafficLiveEventDto) => void): () => void {
  bus.on(projectId, fn)
  return () => bus.off(projectId, fn)
}

const processor = new TrafficProcessor({
  aggregator,
  visitors,
  hosts: () => hosts,
  city: (ip) => cityDb.lookup(ip),
  hasPages,
  emit: (projectId, e) => bus.emit(projectId, e),
  // Nacht 3, Etappe 5: Scanner-Pfade und 4xx je Projekt zählen (nur im Arbeitsspeicher, keine IP gespeichert)
  observe: (projectId, a) => webScans.add(projectId, a),
})

/** Namen → Projekt, Dienst, Healthcheck (aus Routen, Projekt und aktivem Deployment) */
export async function loadHosts(): Promise<Map<string, HostInfo>> {
  const rows = await db
    .select({
      projectId: schema.projects.id, slug: schema.projects.slug, envId: schema.projects.environmentId,
      sourceType: schema.projects.sourceType, sourceConfig: schema.projects.sourceConfig, healthPath: schema.projects.healthcheckPath,
      hostname: schema.routes.hostname, target: schema.routes.target, pausedAt: schema.routes.pausedAt,
      artifact: schema.deployments.artifact,
    })
    .from(schema.routes)
    .innerJoin(schema.projects, eq(schema.routes.projectId, schema.projects.id))
    .leftJoin(schema.deployments, and(eq(schema.deployments.projectId, schema.projects.id), eq(schema.deployments.isActive, true)))
  const byProject = new Map<string, Set<string>>()
  const next = new Map<string, HostInfo>()
  for (const r of rows) {
    const names = r.target === 'public' ? [r.hostname] : [r.hostname, ...aliasesForHost(r.hostname, r.envId)]
    const own = byProject.get(r.projectId) ?? new Set<string>()
    for (const n of names) own.add(n.toLowerCase())
    byProject.set(r.projectId, own)
    const kind = effectiveKind(r.sourceType, r.artifact)
    const webService = (r.sourceConfig as { webService?: string } | null)?.webService ?? 'web'
    const paused = r.target === 'public' && r.pausedAt !== null
    const service = paused ? null : kind === 'compose' ? webService : r.slug
    for (const n of names) {
      next.set(n.toLowerCase(), { projectId: r.projectId, public: r.target === 'public', service, healthPath: r.healthPath, ownHosts: own })
    }
  }
  return next
}

async function refreshHosts(): Promise<void> {
  hosts = await loadHosts()
}

let tail: LogTail | null = null

async function pollOnce(): Promise<void> {
  if (!tail) return
  if (!(await tail.exists())) {
    state = 'waiting'
    return
  }
  state = 'ok'
  const lines = await tail.poll()
  for (const l of lines) processor.handle(l)
}

async function flush(): Promise<void> {
  const rows = aggregator.drain()
  try {
    await store.write(rows)
  } catch (err) {
    aggregator.restore(rows)
    throw err
  }
  if (tail?.position) await setSetting(POS_KEY, JSON.stringify(tail.position))
  // Oberfläche lädt Besucherzahlen nach (statt sie jede Minute abzufragen)
  const ids = [...new Set(rows.filter((r) => !r.bot).map((r) => r.projectId))]
  if (ids.length) publish({ type: 'traffic', projectIds: ids })
}

let started = false

export async function startTrafficIngest(): Promise<void> {
  if (started) return
  started = true
  startTrafficRetentionJob(store)
  await cityDb.load().catch((err) => log.warn('Städte-Datenbank nicht lesbar, nur Länder', { err: String(err) }))
  startCityDbJob()
  if (!config.ACCESS_LOG_DIR) {
    log.info('Besucher-Auswertung aus (ACCESS_LOG_DIR leer)')
    return
  }
  const saved = await getSetting(POS_KEY).then((v) => (v ? (JSON.parse(v) as TailPosition) : null)).catch(() => null)
  tail = new LogTail(join(config.ACCESS_LOG_DIR, VISITS_LOG_FILE), saved)
  // Seiten-Projekte der letzten 30 Tage: statische Dateien zählen dort von Anfang an nicht
  for (const id of await store.projectsWithPages(Date.now() - 30 * 24 * 60 * 60_000).catch(() => new Set<string>())) hasPages.add(id)
  await refreshHosts().catch((err) => log.warn('Namen für die Besucher-Auswertung nicht geladen', { err: String(err) }))
  // Neue oder geänderte Projekte: Namen neu laden (gebündelt)
  let pending: NodeJS.Timeout | null = null
  subscribe((e) => {
    if (e.type !== 'project' && e.type !== 'public') return
    if (pending) return
    pending = setTimeout(() => { pending = null; void refreshHosts().catch(() => {}) }, 2_000)
    pending.unref()
  })
  setInterval(() => void refreshHosts().catch(() => {}), HOSTS_MS).unref()

  let busy = false
  let lastPollError = ''
  setInterval(() => {
    if (busy) return
    busy = true
    pollOnce()
      .then(() => { lastPollError = '' })
      .catch((err) => {
        // Einmal melden, nicht jede Sekunde
        if (String(err) !== lastPollError) log.warn('Zugriffs-Log nicht gelesen', { err: String(err) })
        lastPollError = String(err)
      })
      .finally(() => { busy = false })
  }, POLL_MS).unref()
  setInterval(() => void flush().catch((err) => log.warn('Besucher-Zähler nicht gespeichert', { err: String(err) })), FLUSH_MS).unref()
  log.info('Besucher-Auswertung liest das Zugriffs-Log von Caddy', { datei: join(config.ACCESS_LOG_DIR, VISITS_LOG_FILE) })
}

/** Beim Herunterfahren: Ausstehendes noch schreiben */
export async function stopTrafficIngest(): Promise<void> {
  if (!started) return
  await flush().catch((err) => log.warn('Besucher-Zähler beim Beenden nicht gespeichert', { err: String(err) }))
}

/** Monatlich aktualisieren – nur wenn die Datei schon einmal geladen wurde */
function startCityDbJob(): void {
  const tick = () => {
    if (!cityDbDue(cityDb.current, Date.now())) return
    void cityDb.download()
      .then((i) => log.info('Städte-Datenbank (DB-IP) aktualisiert', { stand: i.month }))
      .catch((err) => log.warn('Städte-Datenbank (DB-IP) nicht aktualisiert', { err: String(err) }))
  }
  setInterval(tick, 24 * 60 * 60_000).unref()
  setTimeout(tick, 10 * 60_000).unref()
}

/* --- Abfragen ---------------------------------------------------------------- */

/** Liest Airlock das Zugriffs-Log? (ok, waiting: Datei fehlt noch, off: nicht eingerichtet) */
export const trafficIngestState = (): TrafficSourceDto['ingest'] => state

export async function trafficSource(projectId: string): Promise<TrafficSourceDto> {
  const oldest = await store.oldest(projectId)
  const mem = aggregator.peek(projectId).reduce<number | null>((m, r) => (m === null || r.hour < m ? r.hour : m), null)
  const first = [oldest, mem].filter((x): x is number => x !== null)
  return { ingest: state, since: first.length ? new Date(Math.min(...first)).toISOString() : null, cityDb: cityDb.month }
}

export async function trafficSummary(projectId: string, range: TrafficRange, way: TrafficWay | 'all', now = Date.now()): Promise<TrafficSummaryDto> {
  const tz = displayTimeZone()
  const from = rangeStart(range, now, tz)
  const rows = [...(await store.read(projectId, from)), ...aggregator.peek(projectId)]
  return summarize(rows, { range, way, now, timeZone: tz, source: await trafficSource(projectId) })
}

/** Aufrufe heute (Ortszeit) je Projekt, inklusive der letzten Minute */
export async function trafficToday(now = Date.now()): Promise<Record<string, number>> {
  const from = startOfToday(now, displayTimeZone())
  const views = await store.viewsSince(from)
  for (const r of aggregator.peek()) if (!r.bot && r.hour >= from) views.set(r.projectId, (views.get(r.projectId) ?? 0) + r.views)
  return Object.fromEntries(views)
}

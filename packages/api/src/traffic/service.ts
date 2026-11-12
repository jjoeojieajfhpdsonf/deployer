import { EventEmitter } from 'node:events'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, isNotNull } from 'drizzle-orm'
import {
  ACCESS_MAX, DOCKER_BLOCK_WINDOW_MS, dockerBlockWarning, isDatacenterAsn, isDockerNet,
  type AccessEntryDto, type AccessListDto, type DockerBlockWarningDto,
  UI_HOST_LABEL, trafficRange, daysBefore, rangeStart, startOfToday, summarize,
  type TrafficGeoSourcesDto, type TrafficLiveEventDto, type TrafficRange, type TrafficSourceDto, type TrafficSummaryDto, type TrafficWay,
} from '@airlock/shared'
import { aliasHosts, config, primaryHost } from '../config.js'
import { db, getSetting, schema, setSetting } from '../db/index.js'
import { effectiveKind } from '../domain/deployments.js'
import { aliasesForHost } from '../domain/routes.js'
import { displayTimeZone } from '../domain/pause-page.js'
import { publish, subscribe } from '../lib/events.js'
import { log } from '../lib/log.js'
import { VISITS_LOG_FILE } from '../drivers/caddy-config.js'
import { TrafficAggregator, TrafficDimAggregator } from './aggregate.js'
import { blockOf, readAccessLog, toAccessEntry, type AccessLookups } from './access.js'
import type { AccessLine } from './parse.js'
import { AsnDb, CityDb, dbipDue, type DbipDb } from './geo.js'
import { TrafficProcessor, type HostInfo } from './ingest.js'
import { startTrafficRetentionJob } from './retention.js'
import { pgTrafficStore, type TrafficStore } from './store.js'
import { LogTail, type TailPosition } from './tail.js'
import { VisitorCounter } from './visitor.js'

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
/** «Gerade eben»: so viele Seitenaufrufe je Projekt im Speicher (ohne IP, ohne Kennung) */
const RECENT_MAX = 50

const store: TrafficStore = pgTrafficStore
const aggregator = new TrafficAggregator()
const dimAggregator = new TrafficDimAggregator()
const visitors = new VisitorCounter(displayTimeZone())
export const cityDb = new CityDb(join(config.DATA_DIR, 'geoip'))
export const asnDb = new AsnDb(join(config.DATA_DIR, 'geoip'))
const hasPages = new Set<string>()
let hosts = new Map<string, HostInfo>()
let state: TrafficSourceDto['ingest'] = config.ACCESS_LOG_DIR ? 'waiting' : 'off'
/** Cloudflare schickt Städte (cf-ipcity) – seit dem Start gesehen */
let cfLocationSeen = false

/** Messbeginn je Projekt (ms) und noch nicht gespeicherte Änderungen */
const since = new Map<string, number>()
const sincePending = new Map<string, number>()
let sinceLoaded = false

function markMeasured(projectId: string, at: number): void {
  const cur = since.get(projectId)
  if (cur !== undefined && cur <= at) return
  // Vor dem Laden aus der Datenbank nichts überschreiben (least() in markSince regelt es ohnehin)
  since.set(projectId, at)
  sincePending.set(projectId, Math.min(at, sincePending.get(projectId) ?? at))
}

const recent = new Map<string, TrafficLiveEventDto[]>()

const bus = new EventEmitter()
bus.setMaxListeners(0)

/** Live-Strom eines Projekts abonnieren; gibt die Abmeldung zurück */
export function onTrafficLive(projectId: string, fn: (e: TrafficLiveEventDto) => void): () => void {
  bus.on(projectId, fn)
  return () => bus.off(projectId, fn)
}

/** Letzte gezählte Seitenaufrufe eines Projekts (neueste zuerst), nur aus dem Speicher */
export function trafficRecent(projectId: string, limit = RECENT_MAX): TrafficLiveEventDto[] {
  return (recent.get(projectId) ?? []).slice(0, limit)
}

/* --- Zugriffe neu: einzelne Anfragen live, Docker-Netz-Warnung ---------------- */

const accessBus = new EventEmitter()
accessBus.setMaxListeners(0)
/** Letzte Anfragen je Projekt (für den Anschluss des Live-Stroms an den geladenen Stand) */
const ACCESS_RECENT_MAX = 200
const accessRecent = new Map<string, AccessEntryDto[]>()
/** Abweisungen aus dem Docker-Netz (Zeit, Name) der letzten Stunde, seit dem Start */
let dockerBlocks: { at: number; host: string }[] = []

const accessLookups: AccessLookups = { asn: (ip) => asnDb.lookup(ip), city: (ip) => cityDb.lookup(ip), isDatacenter: isDatacenterAsn }

function tapAccess(a: AccessLine, host: HostInfo): void {
  const block = blockOf(a)
  if (!host.public && block && block !== 'pause' && isDockerNet(a.remoteIp)) {
    const cutoff = a.at - DOCKER_BLOCK_WINDOW_MS
    dockerBlocks = [...dockerBlocks.filter((e) => e.at > cutoff), { at: a.at, host: a.host }].slice(-1000)
  }
  const entry = toAccessEntry(a, host.public, accessLookups)
  const list = accessRecent.get(host.projectId) ?? []
  list.unshift(entry)
  if (list.length > ACCESS_RECENT_MAX) list.length = ACCESS_RECENT_MAX
  accessRecent.set(host.projectId, list)
  accessBus.emit(host.projectId, entry)
}

/** Neue Anfragen eines Projekts abonnieren (Reiter «Zugriffe», Live); gibt die Abmeldung zurück */
export function onAccessLive(projectId: string, fn: (e: AccessEntryDto) => void): () => void {
  accessBus.on(projectId, fn)
  return () => accessBus.off(projectId, fn)
}

/** Anfragen aus dem Speicher nach einem Zeitpunkt (ISO), älteste zuerst – Anschluss ohne Lücke */
export function accessSince(projectId: string, sinceIso: string): AccessEntryDto[] {
  return (accessRecent.get(projectId) ?? []).filter((e) => e.at > sinceIso).reverse()
}

/** Warnung für Server › Übersicht: mehr als 3 Abweisungen aus dem Docker-Netz in der letzten Stunde */
export const dockerBlockState = (now = Date.now()): DockerBlockWarningDto | null => dockerBlockWarning(dockerBlocks, now)

/** Namen eines Projekts (für das Lesen des Logs); ohne laufenden Ingest frisch aus der Datenbank */
async function projectHosts(projectId: string): Promise<Map<string, { public: boolean }>> {
  const all = hosts.size ? hosts : await loadHosts()
  const out = new Map<string, { public: boolean }>()
  for (const [name, h] of all) if (h.projectId === projectId) out.set(name, { public: h.public })
  return out
}

/** Reiter «Zugriffe»: Anfragen eines Projekts seit sinceMs aus visits.log (und rotierten Dateien) */
export async function projectAccess(projectId: string, sinceMs: number): Promise<AccessListDto> {
  const since = new Date(sinceMs).toISOString()
  if (!config.ACCESS_LOG_DIR) return { entries: [], since, ingest: 'off', capped: false, error: null }
  try {
    const h = await projectHosts(projectId)
    const { entries, capped } = h.size
      ? await readAccessLog(config.ACCESS_LOG_DIR, { hosts: h, sinceMs, limit: ACCESS_MAX, lookups: accessLookups })
      : { entries: [], capped: false }
    const exists = await stat(join(config.ACCESS_LOG_DIR, VISITS_LOG_FILE)).then((s) => s.isFile()).catch(() => false)
    return { entries, since, ingest: exists ? 'ok' : 'waiting', capped, error: null }
  } catch (err) {
    return { entries: [], since, ingest: state, capped: false, error: `Zugriffs-Log nicht lesbar: ${(err as Error).message.slice(0, 160)}` }
  }
}

const processor = new TrafficProcessor({
  tap: tapAccess,
  aggregator,
  dims: dimAggregator,
  visitors,
  hosts: () => hosts,
  city: (ip) => cityDb.lookup(ip),
  asn: (ip) => asnDb.lookup(ip),
  hasPages,
  measured: markMeasured,
  cfLocation: () => { cfLocationSeen = true },
  emit: (projectId, e) => {
    if (e.page) {
      const list = recent.get(projectId) ?? []
      list.unshift(e)
      if (list.length > RECENT_MAX) list.length = RECENT_MAX
      recent.set(projectId, list)
    }
    bus.emit(projectId, e)
  },
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

/** Namen von Airlock selbst (Oberfläche, Statusseiten) – als Referrer ausgeblendet */
let airlockHostsCache: { at: number; hosts: Set<string> } | null = null
export async function airlockHosts(now = Date.now()): Promise<Set<string>> {
  if (airlockHostsCache && now - airlockHostsCache.at < 60_000) return airlockHostsCache.hosts
  const names = [primaryHost(UI_HOST_LABEL), ...aliasHosts(UI_HOST_LABEL)]
  const status = await db.select({ hostname: schema.statusPages.hostname }).from(schema.statusPages).where(isNotNull(schema.statusPages.hostname)).catch(() => [])
  for (const s of status) if (s.hostname) names.push(s.hostname)
  // Wie referrerOf: klein, ohne «www.»
  const hosts = new Set(names.map((n) => n.toLowerCase().replace(/^www\./, '')))
  airlockHostsCache = { at: now, hosts }
  return hosts
}

let hostsMarked = false

async function refreshHosts(): Promise<void> {
  hosts = await loadHosts()
  hostsMarked = false
}

/** Messbeginn für Projekte, die das Log gerade erstmals mitliest (auch ohne Aufrufe) */
function markHostsMeasured(now: number): void {
  if (hostsMarked || !sinceLoaded) return
  hostsMarked = true
  for (const h of hosts.values()) if (!since.has(h.projectId)) markMeasured(h.projectId, now)
}

let tail: LogTail | null = null

async function pollOnce(): Promise<void> {
  if (!tail) return
  if (!(await tail.exists())) {
    state = 'waiting'
    return
  }
  state = 'ok'
  markHostsMeasured(Date.now())
  const lines = await tail.poll()
  for (const l of lines) processor.handle(l)
}

async function flush(): Promise<void> {
  processor.sweep()
  const rows = aggregator.drain()
  const dims = dimAggregator.drain()
  try {
    await store.write(rows, dims)
  } catch (err) {
    aggregator.restore(rows)
    dimAggregator.restore(dims)
    throw err
  }
  if (sincePending.size) {
    const marks = new Map(sincePending)
    sincePending.clear()
    await store.markSince(marks).catch((err) => {
      for (const [k, v] of marks) sincePending.set(k, Math.min(v, sincePending.get(k) ?? v))
      throw err
    })
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
  await asnDb.load().catch((err) => log.warn('Provider-Datenbank nicht lesbar, ohne «Netz»', { err: String(err) }))
  startDbipJob(cityDb, 'Städte-Datenbank')
  startDbipJob(asnDb, 'Provider-Datenbank')
  if (!config.ACCESS_LOG_DIR) {
    log.info('Besucher-Auswertung aus (ACCESS_LOG_DIR leer)')
    return
  }
  const saved = await getSetting(POS_KEY).then((v) => (v ? (JSON.parse(v) as TailPosition) : null)).catch(() => null)
  tail = new LogTail(join(config.ACCESS_LOG_DIR, VISITS_LOG_FILE), saved)
  // Seiten-Projekte der letzten 30 Tage: statische Dateien zählen dort von Anfang an nicht
  for (const id of await store.projectsWithPages(Date.now() - 30 * 24 * 60 * 60_000).catch(() => new Set<string>())) hasPages.add(id)
  // Gespeicherter Messbeginn (vorher gesehene Zeilen ziehen ihn höchstens vor)
  try {
    for (const [id, at] of await store.allSince()) if (!since.has(id) || at < since.get(id)!) since.set(id, at)
    sinceLoaded = true
  } catch (err) {
    log.warn('Messbeginn der Besucher-Auswertung nicht geladen', { err: String(err) })
  }
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

/** Beim Herunterfahren: offene Besuche als beendet zählen, Ausstehendes noch schreiben */
export async function stopTrafficIngest(): Promise<void> {
  if (!started) return
  processor.closeAll()
  await flush().catch((err) => log.warn('Besucher-Zähler beim Beenden nicht gespeichert', { err: String(err) }))
}

/** Monatlich aktualisieren – nur wenn die Datei schon einmal geladen wurde */
function startDbipJob(file: DbipDb, label: string): void {
  const tick = () => {
    if (!dbipDue(file.current, Date.now())) return
    void file.download()
      .then((i) => log.info(`${label} (DB-IP) aktualisiert`, { stand: i.month }))
      .catch((err) => log.warn(`${label} (DB-IP) nicht aktualisiert`, { err: String(err) }))
  }
  setInterval(tick, 24 * 60 * 60_000).unref()
  setTimeout(tick, 10 * 60_000).unref()
}

/* --- Abfragen ---------------------------------------------------------------- */

/** Liest Airlock das Zugriffs-Log? (ok, waiting: Datei fehlt noch, off: nicht eingerichtet) */
export const trafficIngestState = (): TrafficSourceDto['ingest'] => state

export function trafficGeoSources(): TrafficGeoSourcesDto {
  return {
    city: { month: cityDb.month, downloadedAt: cityDb.current?.downloadedAt ?? null },
    asn: { month: asnDb.month, downloadedAt: asnDb.current?.downloadedAt ?? null },
    cfLocation: cfLocationSeen,
  }
}

/** Messbeginn: gespeichert bzw. im Speicher; ältere Daten ohne Eintrag: ältester Zähler */
async function measuredSince(projectId: string): Promise<number | null> {
  const mem = since.get(projectId)
  if (mem !== undefined) return mem
  const saved = await store.since(projectId).catch(() => null)
  if (saved !== null) return saved
  const oldest = await store.oldest(projectId)
  const pending = aggregator.peek(projectId).reduce<number | null>((m, r) => (m === null || r.hour < m ? r.hour : m), null)
  const first = [oldest, pending].filter((x): x is number => x !== null)
  return first.length ? Math.min(...first) : null
}

export async function trafficSource(projectId: string): Promise<TrafficSourceDto> {
  const s = await measuredSince(projectId)
  return { ingest: state, since: s === null ? null : new Date(s).toISOString(), cityDb: cityDb.month, asnDb: asnDb.month, cfLocation: cfLocationSeen }
}

export async function trafficSummary(projectId: string, range: TrafficRange, way: TrafficWay | 'all', now = Date.now()): Promise<TrafficSummaryDto> {
  const tz = displayTimeZone()
  const from = rangeStart(range, now, tz)
  // Für den Vergleich auch den gleich langen Zeitraum davor lesen (12 Monate: keiner, Aufbewahrung 13 Monate)
  const readFrom = range === '12m' ? from : daysBefore(from, trafficRange(range).days, tz) - 60 * 60_000
  const [rows, dims, source, hidden] = await Promise.all([
    store.read(projectId, readFrom),
    store.readDims(projectId, readFrom),
    trafficSource(projectId),
    airlockHosts(now),
  ])
  return summarize(
    [...rows, ...aggregator.peek(projectId)],
    [...dims, ...dimAggregator.peek(projectId)],
    { range, way, now, timeZone: tz, source, hiddenReferrers: hidden },
  )
}

/** Aufrufe heute (Ortszeit, nur 2xx/3xx) je Projekt, inklusive der letzten Minute */
export async function trafficToday(now = Date.now()): Promise<Record<string, number>> {
  const from = startOfToday(now, displayTimeZone())
  const views = await store.viewsSince(from)
  for (const r of aggregator.peek()) {
    if (!r.bot && r.hour >= from && r.status > 0 && r.status < 400) views.set(r.projectId, (views.get(r.projectId) ?? 0) + r.views)
  }
  return Object.fromEntries(views)
}

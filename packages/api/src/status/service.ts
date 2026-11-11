import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import {
  addDays, dayInZone, showsOnStatusPage, STATUS_DAYS, STATUS_DEFAULT_TITLE, STATUS_HOST_LABEL,
  type IncidentCreateInput, type IncidentDto, type IncidentUpdateInput, type PublicProjectState,
  type StatusPageDto, type StatusSettingsInput,
} from '@airlock/shared'
import { db, schema } from '../db/index.js'
import { config } from '../config.js'
import { allEnvironments, environmentById } from '../domain/environments.js'
import { ensureStatusDns, publicEnabled, reconcileTunnelFor, removeStatusDns } from '../domain/public.js'
import { reconcileCaddy } from '../domain/routes.js'
import { displayTimeZone } from '../domain/pause-page.js'
import { audit } from '../domain/audit.js'
import { projectHealth } from '../jobs/monitor.js'
import { badRequest, notFound } from '../lib/errors.js'
import { log } from '../lib/log.js'
import { autoIncidentText, planAutoIncidents, type Observation, type Observed } from './auto-incidents.js'
import { buildPublicStatus, feedIncidents, type SnapshotIncident } from './snapshot.js'
import { removeStatusDir, statusFiles, writeStatusDir } from './files.js'

/**
 * Etappe 5 «Statusseite»: Einstellungen je Umgebung, Störungen, Messung und
 * das Schreiben der Dateien. Jede Minute: jedes Projekt auf einer
 * Statusseite beobachten (wie der Healthcheck der Übersicht), Tageswerte
 * hochzählen, automatische Störungen anlegen oder beheben, die Seiten der
 * eingeschalteten Umgebungen neu schreiben.
 */

const TICK_MS = 60_000
const FEED_MAX = 50

const statusHostOf = (zone: string) => `${STATUS_HOST_LABEL}.${zone}`

/** Zuletzt beobachteter Zustand je Projekt (für sofortiges Schreiben nach einer Änderung) */
const lastObserved = new Map<string, Observed>()
/** «gestört seit» je Projekt (ms); nach einem Neustart von Airlock beginnt die Uhr neu */
let downSince = new Map<string, number>()
/** Zuletzt geschrieben je Umgebung */
const writtenAt = new Map<string, string>()

const PUBLIC_STATE: Record<Observed, PublicProjectState> = { up: 'ok', down: 'stoerung', paused: 'pausiert', unknown: 'unbekannt' }

/* --- Einstellungen ----------------------------------------------------------------- */

async function pageRow(envId: string) {
  return (await db.select().from(schema.statusPages).where(eq(schema.statusPages.environmentId, envId)).limit(1))[0] ?? null
}

function requireEnv(envId: string) {
  const env = environmentById(envId)
  if (!env) throw notFound('Umgebung')
  return env
}

type ProjectRow = { id: string; name: string; environmentId: string; desiredState: string; showOnStatus: boolean | null }

async function projectsWithVisibility(envIds?: string[]): Promise<(ProjectRow & { isPublic: boolean; paused: boolean; shown: boolean })[]> {
  const rows = await db.select({
    id: schema.projects.id, name: schema.projects.name, environmentId: schema.projects.environmentId,
    desiredState: schema.projects.desiredState, showOnStatus: schema.projects.showOnStatus,
  }).from(schema.projects).where(envIds ? inArray(schema.projects.environmentId, envIds) : undefined)
  const pub = await db.select({ projectId: schema.routes.projectId, pausedAt: schema.routes.pausedAt }).from(schema.routes).where(eq(schema.routes.target, 'public'))
  const byProject = new Map(pub.map((r) => [r.projectId, r]))
  return rows.map((p) => {
    const route = byProject.get(p.id)
    return { ...p, isPublic: Boolean(route), paused: Boolean(route?.pausedAt), shown: showsOnStatusPage(p.showOnStatus, Boolean(route)) }
  })
}

/** Warum die Seite (noch) nicht öffentlich erreichbar ist; null: alles da */
function problemFor(envId: string): string | null {
  const env = requireEnv(envId)
  if (!env.zoneName) return 'Noch keine Hauptzone gewählt (Einstellungen › Cloudflare & HTTPS).'
  if (!publicEnabled(envId)) return 'Öffentlich ist in dieser Umgebung nicht eingerichtet: Cloudflare-Token und Tunnel fehlen (Einstellungen › Cloudflare & HTTPS).'
  if (!config.STATUS_DIR) return 'Airlock läuft ohne die Ablage der Statusseite (Volume status_site). Den Stack mit der neuen compose.yaml neu starten.'
  return null
}

export async function statusPageDto(envId: string): Promise<StatusPageDto> {
  const env = requireEnv(envId)
  const row = await pageRow(envId)
  const projects = (await projectsWithVisibility([envId])).sort((a, b) => a.name.localeCompare(b.name, 'de'))
  return {
    enabled: Boolean(row?.enabled),
    title: row?.title ?? STATUS_DEFAULT_TITLE,
    hostname: row?.hostname ?? (env.zoneName ? statusHostOf(env.zoneName) : null),
    publicReady: Boolean(env.zoneName) && publicEnabled(envId),
    problem: problemFor(envId),
    writtenAt: writtenAt.get(envId) ?? null,
    storage: Boolean(config.STATUS_DIR),
    projects: projects.map((p) => ({ id: p.id, name: p.name, shown: p.shown, explicit: p.showOnStatus !== null, public: p.isPublic })),
  }
}

/**
 * Titel ändern, ein- oder ausschalten. Einschalten: CNAME status.<zone> auf
 * den Tunnel, Tunnel-Regel und Caddy-Route; Ausschalten räumt alles wieder
 * ab und löscht die Dateien. Ohne Cloudflare und Tunnel lässt sie sich nicht
 * einschalten (sie wäre nirgends erreichbar).
 */
export async function setStatusSettings(envId: string, input: StatusSettingsInput, actor: string): Promise<StatusPageDto> {
  const env = requireEnv(envId)
  const before = await pageRow(envId)
  const title = input.title ?? before?.title ?? STATUS_DEFAULT_TITLE
  const wasOn = Boolean(before?.enabled)
  const on = input.enabled ?? wasOn
  let hostname = before?.hostname ?? null
  let recordId = before?.cfDnsRecordId ?? null

  if (on && !wasOn) {
    if (!env.zoneName) throw badRequest('Für die Statusseite braucht die Umgebung eine Hauptzone (Einstellungen › Cloudflare & HTTPS).')
    if (!publicEnabled(envId)) throw badRequest('Öffentlich ist in dieser Umgebung nicht eingerichtet: zuerst Cloudflare-Token und Tunnel unter Einstellungen › Cloudflare & HTTPS.')
    hostname = statusHostOf(env.zoneName)
    recordId = (await ensureStatusDns(envId, hostname)).recordId
  }
  if (!on && wasOn && hostname) {
    await removeStatusDns(envId, hostname, recordId).catch((err) => log.warn('DNS-Eintrag der Statusseite nicht entfernt', { hostname, err: String(err) }))
    recordId = null
  }

  await db.insert(schema.statusPages)
    .values({ environmentId: envId, enabled: on, title, hostname, cfDnsRecordId: recordId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.statusPages.environmentId, set: { enabled: on, title, hostname, cfDnsRecordId: recordId, updatedAt: new Date() } })

  if (on !== wasOn) {
    await reconcileTunnelFor(envId).catch((err) => log.warn('Tunnel-Abgleich (Statusseite) fehlgeschlagen', { err: String(err) }))
    await reconcileCaddy().catch((err) => log.warn('Caddy-Abgleich (Statusseite) fehlgeschlagen', { err: String(err) }))
    if (!on && config.STATUS_DIR) {
      await removeStatusDir(config.STATUS_DIR, env.slug).catch(() => {})
      writtenAt.delete(envId)
    }
  }
  if (on) await writeEnvironment(envId).catch((err) => log.warn('Statusseite nicht geschrieben', { err: String(err) }))
  await audit({
    actor, action: on !== wasOn ? (on ? 'status.enable' : 'status.disable') : 'status.settings',
    targetType: 'environment', targetId: envId, environmentId: envId, params: { title, hostname }, result: 'ok',
  })
  return statusPageDto(envId)
}

/* --- Störungen -------------------------------------------------------------------- */

type IncidentRow = typeof schema.statusIncidents.$inferSelect
type UpdateRow = typeof schema.statusIncidentUpdates.$inferSelect

async function incidentsWithUpdates(envIds: string[], opts: { limit?: number } = {}): Promise<{ row: IncidentRow; updates: UpdateRow[] }[]> {
  if (!envIds.length) return []
  const q = db.select().from(schema.statusIncidents).where(inArray(schema.statusIncidents.environmentId, envIds)).orderBy(desc(schema.statusIncidents.createdAt))
  const rows = opts.limit ? await q.limit(opts.limit) : await q
  if (!rows.length) return []
  const updates = await db.select().from(schema.statusIncidentUpdates)
    .where(inArray(schema.statusIncidentUpdates.incidentId, rows.map((r) => r.id)))
    .orderBy(desc(schema.statusIncidentUpdates.createdAt))
  return rows.map((row) => ({ row, updates: updates.filter((u) => u.incidentId === row.id) }))
}

const toSnapshot = ({ row, updates }: { row: IncidentRow; updates: UpdateRow[] }): SnapshotIncident => ({
  id: row.id, title: row.title, state: row.state, createdAt: row.createdAt, resolvedAt: row.resolvedAt, projectIds: row.projectIds,
  updates: updates.map((u) => ({ state: u.state, body: u.body, createdAt: u.createdAt })),
})

export async function listIncidents(envId: string): Promise<IncidentDto[]> {
  requireEnv(envId)
  const list = await incidentsWithUpdates([envId], { limit: 100 })
  const projects = new Map((await projectsWithVisibility([envId])).map((p) => [p.id, p]))
  return list.map(({ row, updates }) => ({
    id: row.id,
    title: row.title,
    state: row.state,
    auto: row.auto,
    projects: row.projectIds.map((id) => projects.get(id)).filter((p): p is NonNullable<typeof p> => Boolean(p)).map((p) => ({ id: p.id, name: p.name, shown: p.shown })),
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    updates: updates.map((u) => ({ id: u.id, state: u.state, body: u.body, at: u.createdAt.toISOString(), actor: u.actor })),
  }))
}

async function incidentIn(envId: string, id: string): Promise<IncidentRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Störung')
  const row = (await db.select().from(schema.statusIncidents)
    .where(and(eq(schema.statusIncidents.id, id), eq(schema.statusIncidents.environmentId, envId))).limit(1))[0]
  if (!row) throw notFound('Störung')
  return row
}

export async function createIncident(envId: string, input: IncidentCreateInput, actor: string): Promise<IncidentDto[]> {
  requireEnv(envId)
  const ids = [...new Set(input.projectIds)]
  if (ids.length) {
    const own = await db.select({ id: schema.projects.id }).from(schema.projects).where(and(inArray(schema.projects.id, ids), eq(schema.projects.environmentId, envId)))
    if (own.length !== ids.length) throw badRequest('Ein gewähltes Projekt gehört nicht zu dieser Umgebung')
  }
  const now = new Date()
  const resolved = input.state === 'behoben' ? now : null
  await db.transaction(async (tx) => {
    const [row] = await tx.insert(schema.statusIncidents).values({ environmentId: envId, title: input.title, state: input.state, projectIds: ids, createdAt: now, updatedAt: now, resolvedAt: resolved }).returning()
    await tx.insert(schema.statusIncidentUpdates).values({ incidentId: row!.id, state: input.state, body: input.body, actor, createdAt: now })
  })
  await audit({ actor, action: 'status.incident', targetType: 'environment', targetId: envId, environmentId: envId, params: { title: input.title, state: input.state }, result: 'ok' })
  await writeEnvironment(envId).catch((err) => log.warn('Statusseite nicht geschrieben', { err: String(err) }))
  return listIncidents(envId)
}

export async function addIncidentUpdate(envId: string, id: string, input: IncidentUpdateInput, actor: string): Promise<IncidentDto[]> {
  const row = await incidentIn(envId, id)
  const now = new Date()
  await db.transaction(async (tx) => {
    await tx.insert(schema.statusIncidentUpdates).values({ incidentId: row.id, state: input.state, body: input.body, actor, createdAt: now })
    await tx.update(schema.statusIncidents).set({
      state: input.state, updatedAt: now,
      resolvedAt: input.state === 'behoben' ? (row.resolvedAt ?? now) : null,
    }).where(eq(schema.statusIncidents.id, row.id))
  })
  await audit({ actor, action: 'status.incident.update', targetType: 'environment', targetId: envId, environmentId: envId, params: { title: row.title, state: input.state }, result: 'ok' })
  await writeEnvironment(envId).catch((err) => log.warn('Statusseite nicht geschrieben', { err: String(err) }))
  return listIncidents(envId)
}

/** Löschen (etwa ein Fehleintrag) – verschwindet auch aus Seite und RSS */
export async function deleteIncident(envId: string, id: string, actor: string): Promise<IncidentDto[]> {
  const row = await incidentIn(envId, id)
  await db.delete(schema.statusIncidents).where(eq(schema.statusIncidents.id, row.id))
  await audit({ actor, action: 'status.incident.delete', targetType: 'environment', targetId: envId, environmentId: envId, params: { title: row.title }, result: 'ok' })
  await writeEnvironment(envId).catch((err) => log.warn('Statusseite nicht geschrieben', { err: String(err) }))
  return listIncidents(envId)
}

/* --- Messen ----------------------------------------------------------------------- */

/** Zustand eines Projekts wie der Healthcheck der Übersicht (ein Versuch, frisch). */
async function observe(p: { id: string; desiredState: string; paused: boolean }): Promise<Observed> {
  if (p.desiredState === 'stopped' || p.paused) return 'paused'
  const h = await projectHealth(p.id, { fresh: true }).catch(() => null)
  if (!h || h.kind === null) return 'unknown'
  if (h.kind === 'static') return 'up'
  if (h.container && !h.container.running) return 'down'
  if (h.health && !h.health.ok) return 'down'
  return 'up'
}

async function countMinute(day: string, observed: Map<string, Observed>): Promise<void> {
  for (const [projectId, state] of observed) {
    if (state === 'unknown') continue
    const up = state === 'up' ? 1 : 0
    const down = state === 'down' ? 1 : 0
    const paused = state === 'paused' ? 1 : 0
    await db.insert(schema.statusDaily).values({ projectId, day, upMinutes: up, downMinutes: down, pausedMinutes: paused })
      .onConflictDoUpdate({
        target: [schema.statusDaily.projectId, schema.statusDaily.day],
        set: {
          upMinutes: sql`${schema.statusDaily.upMinutes} + ${up}`,
          downMinutes: sql`${schema.statusDaily.downMinutes} + ${down}`,
          pausedMinutes: sql`${schema.statusDaily.pausedMinutes} + ${paused}`,
        },
      })
  }
}

async function enabledEnvironments(): Promise<string[]> {
  const rows = await db.select({ env: schema.statusPages.environmentId }).from(schema.statusPages).where(eq(schema.statusPages.enabled, true))
  const known = new Set(allEnvironments().map((e) => e.id))
  return rows.map((r) => r.env).filter((id) => known.has(id))
}

async function runAutoIncidents(now: Date, projects: { id: string; name: string; environmentId: string }[], enabled: Set<string>): Promise<Set<string>> {
  const changed = new Set<string>()
  const observations: Observation[] = projects.map((p) => ({ projectId: p.id, name: p.name, state: lastObserved.get(p.id) ?? 'unknown' }))
  const open = await db.select({ id: schema.statusIncidents.id, projectIds: schema.statusIncidents.projectIds, env: schema.statusIncidents.environmentId })
    .from(schema.statusIncidents).where(and(eq(schema.statusIncidents.auto, true), ne(schema.statusIncidents.state, 'behoben')))
  const plan = planAutoIncidents({
    now: now.getTime(), observations, downSince,
    openAuto: open.filter((o) => o.projectIds[0]).map((o) => ({ id: o.id, projectId: o.projectIds[0]! })),
  })
  downSince = plan.downSince
  const envOf = new Map(projects.map((p) => [p.id, p.environmentId]))
  for (const c of plan.create) {
    const envId = envOf.get(c.projectId)
    if (!envId || !enabled.has(envId)) continue
    const since = new Date(c.since)
    await db.transaction(async (tx) => {
      const [row] = await tx.insert(schema.statusIncidents).values({
        environmentId: envId, title: autoIncidentText.title(c.name), state: 'untersucht', auto: true, projectIds: [c.projectId], createdAt: since, updatedAt: now,
      }).returning()
      await tx.insert(schema.statusIncidentUpdates).values({ incidentId: row!.id, state: 'untersucht', body: autoIncidentText.body(c.name), actor: 'system', createdAt: now })
    })
    log.warn('Statusseite: Störung automatisch angelegt', { projekt: c.name })
    changed.add(envId)
  }
  for (const r of plan.resolve) {
    await db.transaction(async (tx) => {
      await tx.insert(schema.statusIncidentUpdates).values({ incidentId: r.incidentId, state: 'behoben', body: autoIncidentText.resolved(r.name), actor: 'system', createdAt: now })
      await tx.update(schema.statusIncidents).set({ state: 'behoben', resolvedAt: now, updatedAt: now }).where(eq(schema.statusIncidents.id, r.incidentId))
    })
    log.info('Statusseite: Störung automatisch behoben', { projekt: r.name })
    const env = open.find((o) => o.id === r.incidentId)?.env
    if (env) changed.add(env)
  }
  return changed
}

/** Eine Runde: messen, zählen, automatische Störungen, Seiten schreiben. */
export async function statusTick(now = new Date()): Promise<void> {
  const projects = (await projectsWithVisibility()).filter((p) => p.shown)
  const observed = new Map<string, Observed>()
  for (const p of projects) observed.set(p.id, await observe(p))
  for (const id of lastObserved.keys()) if (!observed.has(id)) lastObserved.delete(id)
  for (const [id, s] of observed) lastObserved.set(id, s)
  await countMinute(dayInZone(now, displayTimeZone()), observed)

  const enabled = new Set(await enabledEnvironments())
  await runAutoIncidents(now, projects, enabled)
  for (const envId of enabled) await writeEnvironment(envId, now).catch((err) => log.warn('Statusseite nicht geschrieben', { env: envId, err: String(err) }))
}

/** Seite einer Umgebung jetzt schreiben (nach jeder Runde und nach jeder Änderung). */
export async function writeEnvironment(envId: string, now = new Date()): Promise<void> {
  if (!config.STATUS_DIR) return
  const env = environmentById(envId)
  const row = await pageRow(envId)
  if (!env || !row?.enabled || !row.hostname) return
  const tz = displayTimeZone()
  const shown = (await projectsWithVisibility([envId])).filter((p) => p.shown)
  const from = addDays(dayInZone(now, tz), -(STATUS_DAYS - 1))
  const counts = shown.length
    ? await db.select().from(schema.statusDaily).where(and(inArray(schema.statusDaily.projectId, shown.map((p) => p.id)), gte(schema.statusDaily.day, from)))
    : []
  const incidents = await incidentsWithUpdates([envId], { limit: 200 })
  const auto = new Set(incidents.filter((i) => i.row.auto).map((i) => i.row.id))
  const snap = incidents.map(toSnapshot)
  const data = buildPublicStatus({
    title: row.title, now, timeZone: tz, autoIncidents: auto, incidents: snap,
    projects: shown.map((p) => ({
      id: p.id, name: p.name,
      state: PUBLIC_STATE[p.desiredState === 'stopped' || p.paused ? 'paused' : lastObserved.get(p.id) ?? 'unknown'],
      counts: counts.filter((c) => c.projectId === p.id).map((c) => ({ date: c.day, upMinutes: c.upMinutes, downMinutes: c.downMinutes, pausedMinutes: c.pausedMinutes })),
    })),
  })
  // RSS: die letzten 50, auch ältere behobene (dieselbe Regel für automatische Störungen)
  const feed = feedIncidents(snap, new Map(shown.map((p) => [p.id, p.name])), auto, FEED_MAX)
  await writeStatusDir(config.STATUS_DIR, env.slug, statusFiles(data, feed, `https://${row.hostname}`))
  writtenAt.set(envId, now.toISOString())
}

let running = false
export function startStatusJob(): void {
  const run = () => {
    if (running) return
    running = true
    void statusTick().catch((e) => log.warn('Statusseite: Runde fehlgeschlagen', { err: String(e) })).finally(() => { running = false })
  }
  setTimeout(run, 15_000)
  setInterval(run, TICK_MS).unref()
}

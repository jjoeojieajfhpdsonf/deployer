import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, gt, gte, inArray, lte, lt, ne, sql } from 'drizzle-orm'
import { INTRUSION_LEARN_MINUTES } from '@airlock/shared'
import { config, net } from '../config.js'
import { db, getSetting, schema, setSetting } from '../db/index.js'
import * as docker from '../drivers/docker.js'
import { accessOf, deviceLabel } from '../auth/client.js'
import { effectiveKind } from '../domain/deployments.js'
import { log } from '../lib/log.js'
import {
  addedFiles, diffManifest, evaluateContainer, evaluateFiles, evaluateLogins, evaluateProcesses, evaluateSessions, evaluateSite,
  execCandidates, healthcheckPrograms, parseTop, LOGIN_WINDOW_MS, type LoginEvent, type Signal,
} from './rules.js'

/**
 * Nacht 3, Etappe 5: Hinweise einsammeln – Docker (Prozesse, Dateien,
 * Neustarts), statische Seiten und die Anmeldung. Bewertet wird in rules.ts.
 *
 * Docker nur lesend über den Socket-Proxy (GET …/top, …/changes, …/json,
 * HEAD …/archive – alles unter CONTAINERS, kein exec).
 */

export const LEARN_MS = INTRUSION_LEARN_MINUTES * 60_000
/** Dateien (docker diff) nach dem Lernen nur alle 5 Minuten – auf grossen Containern teurer als top */
export const FILES_EVERY_MS = 5 * 60_000
const MAX_REPORTED = 2000
const PARALLEL = 4

type ContainerRow = typeof schema.intrusionContainers.$inferSelect

export interface CollectOptions {
  /** Nur Container mit diesem Label (Smoke-Test, CLI) */
  only?: { key: string; value: string } | null
  /** Lernzeit neuer Container (Standard 10 Min.) */
  learnMs?: number
  /** Dateien jetzt prüfen, egal wann zuletzt */
  forceFiles?: boolean
  now?: Date
}

export interface ContainerRound { signals: Signal[]; containers: number; learning: number; errors: string[]; projectIds: string[] }

/** Schon gemeldete Dateien gegen erneute Prüfung auf «ausführbar» merken (je Container) */
const execCache = new Map<string, Map<string, boolean>>()

async function inBatches<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(fn))
}

const keep = (list: string[]) => list.slice(-MAX_REPORTED)

/**
 * Eine Runde über alle laufenden Projekt-Container: Prozesse (immer),
 * Neustarts (immer), Dateien (beim Lernen jede Runde, danach alle 5 Min.).
 */
export async function collectContainers(o: CollectOptions = {}): Promise<ContainerRound> {
  const now = o.now ?? new Date()
  const learnMs = o.learnMs ?? LEARN_MS
  const running = await docker.listRuntimeContainers(o.only ?? null)
  const out: ContainerRound = { signals: [], containers: 0, learning: 0, errors: [], projectIds: [] }
  if (!running.length) return out
  const projects = await db.select({ id: schema.projects.id, slug: schema.projects.slug, previewOf: schema.projects.previewOf })
    .from(schema.projects).where(inArray(schema.projects.slug, [...new Set(running.map((c) => c.slug))]))
  const bySlug = new Map(projects.map((p) => [p.slug, p]))
  const rows = new Map((await db.select().from(schema.intrusionContainers)
    .where(inArray(schema.intrusionContainers.containerId, running.map((c) => c.id)))).map((r) => [r.containerId, r]))
  const owners = [...new Set(projects.map((p) => p.previewOf ?? p.id))]
  const allow = owners.length ? await db.select().from(schema.intrusionAllow).where(inArray(schema.intrusionAllow.projectId, owners)) : []

  await inBatches(running, PARALLEL, async (c) => {
    const p = bySlug.get(c.slug)
    if (!p) return
    const owner = p.previewOf ?? p.id
    const service = p.previewOf ? `Vorschau ${p.slug}${c.service ? ` / ${c.service}` : ''}` : c.service
    try {
      const r = await checkContainer(c, p.id, owner, service, rows.get(c.id) ?? null, allow.filter((a) => a.projectId === owner && (a.service === '' || a.service === (service ?? ''))), learnMs, now, o.forceFiles === true)
      out.containers++
      if (!out.projectIds.includes(owner)) out.projectIds.push(owner)
      if (r.learning) out.learning++
      out.signals.push(...r.signals)
    } catch (err) {
      out.errors.push(`${c.name}: ${(err as Error).message}`)
      log.warn('Einbruchserkennung: Container nicht geprüft', { container: c.name, err: String(err) })
    }
  })
  return out
}

async function checkContainer(
  c: docker.RuntimeContainer, projectId: string, owner: string, service: string | null, row: ContainerRow | null,
  allow: (typeof schema.intrusionAllow.$inferSelect)[], learnMs: number, now: Date, forceFiles: boolean,
): Promise<{ learning: boolean; signals: Signal[] }> {
  const info = await docker.inspectForIntrusion(c.id)
  if (!info) return { learning: false, signals: [] }
  if (!row) {
    // Erste Begegnung: Lernzeit beginnt, Programme des Healthchecks gehören von Anfang an dazu
    const [created] = await db.insert(schema.intrusionContainers).values({
      containerId: c.id, projectId, deploymentId: c.deploymentId, service,
      firstSeen: now, learnUntil: new Date(now.getTime() + learnMs), lastSeen: now,
      processes: healthcheckPrograms(info.healthcheck),
      restartCount: info.restartCount, startedAt: info.startedAt,
    }).onConflictDoNothing().returning()
    row = created ?? (await db.select().from(schema.intrusionContainers).where(eq(schema.intrusionContainers.containerId, c.id)).limit(1))[0] ?? null
    if (!row) return { learning: true, signals: [] }
  }
  // Eine kürzere Lernzeit (CLI --learn-minutes) gilt auch für schon bekannte Container
  const learnUntil = Math.min(row.learnUntil.getTime(), row.firstSeen.getTime() + learnMs)
  const learning = now.getTime() < learnUntil
  const signals: Signal[] = []
  const set: Partial<ContainerRow> = { lastSeen: now, lastCheckAt: now }

  // Prozesse
  const top = await docker.containerTop(c.id)
  if (top) {
    const pr = evaluateProcesses({
      projectId: owner, service, processes: parseTop(top),
      learned: new Set(row.processes), allowed: new Set(allow.filter((a) => a.kind === 'prozess').map((a) => a.value)),
      learning, reported: new Set(row.reportedPids), at: now,
    })
    signals.push(...pr.signals)
    if (pr.learn.length) set.processes = [...row.processes, ...pr.learn].slice(0, 500)
    if (pr.reported.length) set.reportedPids = keep([...row.reportedPids, ...pr.reported])
  }

  // Neustarts und Speichergrenze
  const st = evaluateContainer(owner, service, row.restartCount === null ? null : { restartCount: row.restartCount, startedAt: row.startedAt, oomFor: row.oomFor }, info, now)
  signals.push(...st.signals)
  set.restartCount = st.next.restartCount
  set.startedAt = st.next.startedAt
  set.oomFor = st.next.oomFor

  // Dateien
  const filesDue = forceFiles || learning || !row.lastFilesAt || now.getTime() - row.lastFilesAt.getTime() >= FILES_EVERY_MS
  if (filesDue) {
    const changes = await docker.containerChanges(c.id)
    if (changes) {
      const learned = new Set(row.files)
      const reported = new Set(row.reportedFiles)
      const allowed = allow.filter((a) => a.kind === 'datei').map((a) => a.value)
      const cache = execCache.get(c.id) ?? new Map<string, boolean>()
      execCache.set(c.id, cache)
      const known = (path: string) => learned.has(path) || reported.has(path) || cache.has(path) || allowed.some((a) => (a.endsWith('/') ? path.startsWith(a) : path === a))
      for (const path of execCandidates(addedFiles(changes), known)) {
        cache.set(path, (await docker.isExecutableInContainer(c.id, path)) === true)
      }
      const fr = evaluateFiles({ projectId: owner, service, changes, learned, learning, allowed, reported, exec: cache, at: now })
      signals.push(...fr.signals)
      if (fr.learn.length) set.files = [...row.files, ...fr.learn].slice(0, MAX_REPORTED)
      if (fr.reported.length) set.reportedFiles = keep([...row.reportedFiles, ...fr.reported])
      set.lastFilesAt = now
    }
  }
  await db.update(schema.intrusionContainers).set(set).where(eq(schema.intrusionContainers.containerId, c.id))
  return { learning, signals }
}

/** Grundlinien verschwundener Container nach einer Woche vergessen */
export async function pruneContainers(now = new Date()): Promise<void> {
  await db.delete(schema.intrusionContainers).where(lt(schema.intrusionContainers.lastSeen, new Date(now.getTime() - 7 * 86_400_000)))
  for (const id of execCache.keys()) if (execCache.size > 500) execCache.delete(id)
}

/* --- Statische Seiten ------------------------------------------------------------------- */

const SITE_MAX_FILES = 20_000
const SITE_MAX_BYTES = 1024 ** 3

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

/** Datei → SHA-256 (Verweise als «link:<ziel>»); null bei zu vielen/zu grossen Dateien */
export async function hashTree(root: string): Promise<Record<string, string> | null> {
  const out: Record<string, string> = {}
  let files = 0
  let bytes = 0
  const walk = async (dir: string, rel: string): Promise<boolean> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) { out[r] = `link:${await readlink(full)}`; continue }
      if (e.isDirectory()) { if (!(await walk(full, r))) return false; continue }
      if (!e.isFile()) continue
      if (++files > SITE_MAX_FILES) return false
      bytes += (await lstat(full)).size
      if (bytes > SITE_MAX_BYTES) return false
      out[r] = await sha256File(full)
    }
    return true
  }
  return (await walk(root, '')) ? out : null
}

/**
 * Stündlich: ausgelieferte Dateien jeder statischen Seite gegen die
 * Prüfsummen ihrer Fassung. Die Prüfsummen hält Airlock beim ersten Prüfen
 * nach dem Deploy fest (kurz nach dem Deploy angestossen).
 */
export async function checkSites(o: { projectId?: string; now?: Date } = {}): Promise<Signal[]> {
  const now = o.now ?? new Date()
  const rows = await db.select({ id: schema.projects.id, slug: schema.projects.slug, sourceType: schema.projects.sourceType, artifact: schema.deployments.artifact })
    .from(schema.projects)
    .innerJoin(schema.deployments, and(eq(schema.deployments.projectId, schema.projects.id), eq(schema.deployments.isActive, true)))
    .where(o.projectId ? eq(schema.projects.id, o.projectId) : undefined)
  const signals: Signal[] = []
  for (const p of rows) {
    if (effectiveKind(p.sourceType, p.artifact) !== 'static') continue
    const base = join(config.SITES_DIR, p.slug)
    const version = await readlink(join(base, 'current')).catch(() => null)
    if (!version || version.includes('/')) continue
    try {
      const actual = await hashTree(join(base, version))
      if (!actual) { log.warn('Statische Seite zu gross für die Prüfsummen', { project: p.slug }); continue }
      const known = (await db.select().from(schema.intrusionSites).where(and(eq(schema.intrusionSites.projectId, p.id), eq(schema.intrusionSites.version, version))).limit(1))[0]
      if (!known) {
        await db.insert(schema.intrusionSites).values({ projectId: p.id, version, files: actual, checkedAt: now }).onConflictDoNothing()
        // Ältere Fassungen vergessen (bei einem Rollback werden sie neu festgehalten)
        await db.delete(schema.intrusionSites).where(and(eq(schema.intrusionSites.projectId, p.id), ne(schema.intrusionSites.version, version)))
        continue
      }
      const r = evaluateSite(p.id, diffManifest(known.files, actual), new Set(known.reported), now)
      if (r.signal) signals.push(r.signal)
      await db.update(schema.intrusionSites).set({ checkedAt: now, ...(r.reported.length ? { reported: keep([...known.reported, ...r.reported]) } : {}) })
        .where(and(eq(schema.intrusionSites.projectId, p.id), eq(schema.intrusionSites.version, version)))
    } catch (err) {
      log.warn('Statische Seite nicht geprüft', { project: p.slug, err: String(err) })
    }
  }
  return signals
}

/* --- Anmeldung ------------------------------------------------------------------------- */

const AUDIT_CURSOR = 'intrusion_audit_cursor'
const SESSION_CURSOR = 'intrusion_session_cursor'

/**
 * Fehlversuche, Sperren (Audit-Log, Etappe 1) und neue Geräte/Zugänge
 * (Sitzungen). Beim ersten Lauf beginnt Airlock ab jetzt – alte Einträge
 * ergeben keine Vorfälle.
 */
export async function collectLogins(now = new Date()): Promise<Signal[]> {
  const t = schema.auditEvents
  const rawCursor = await getSetting(AUDIT_CURSOR)
  if (rawCursor === null) {
    const max = (await db.select({ m: sql<string>`coalesce(max(${t.id}), 0)::text` }).from(t))[0]?.m ?? '0'
    await setSetting(AUDIT_CURSOR, max)
    await setSetting(SESSION_CURSOR, now.toISOString())
    return []
  }
  const cursor = Number(rawCursor) || 0
  const rows = await db.select().from(t)
    .where(and(inArray(t.action, ['auth.login', 'auth.lockout']), gte(t.at, new Date(now.getTime() - LOGIN_WINDOW_MS)), eq(t.result, 'error')))
    .orderBy(t.id).limit(5000)
  const events: LoginEvent[] = rows.map((r) => {
    const p = (r.paramsMasked ?? {}) as Record<string, unknown>
    return { id: r.id, at: r.at, action: r.action, result: r.result, ip: typeof p.ip === 'string' ? p.ip : null, reason: typeof p.reason === 'string' ? p.reason : null, scope: typeof p.scope === 'string' ? p.scope : null }
  })
  const signals = evaluateLogins(events, cursor, now)
  const maxId = rows.reduce((m, r) => Math.max(m, r.id), cursor)
  if (maxId > cursor) await setSetting(AUDIT_CURSOR, String(maxId))

  // Neue Sitzungen gegen die bekannten (die Tabelle hält 30 Tage)
  const s = schema.authSessions
  const since = new Date((await getSetting(SESSION_CURSOR)) ?? now.toISOString())
  const fresh = await db.select().from(s).where(and(gt(s.createdAt, since), lte(s.createdAt, now))).orderBy(s.createdAt)
  if (fresh.length) {
    const known = await db.select().from(s).where(lte(s.createdAt, since))
    const lan = net.lanCidr()
    const seen = (r: typeof s.$inferSelect) => ({ device: deviceLabel(r.userAgent) ?? 'Unbekanntes Gerät', access: accessOf(r.ip, lan), ip: r.ip, at: r.createdAt })
    signals.push(...evaluateSessions(fresh.map(seen), known.map(seen), now))
    await setSetting(SESSION_CURSOR, fresh[fresh.length - 1]!.createdAt.toISOString())
  }
  return signals
}

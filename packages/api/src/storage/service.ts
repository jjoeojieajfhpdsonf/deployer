import { lstat, opendir, readdir, readlink, rm, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { desc, eq, inArray } from 'drizzle-orm'
import {
  BUILD_CACHE_MAX_AGE_DAYS, DISK_BLOCK_PERCENT, DISK_NOTIFY_PERCENT, STORAGE_CLEANUP_INTERVAL_DAYS, STORAGE_DEFAULT_KEEP_VERSIONS,
  diskLevel, diskPercentOf, storageSettingsSchema,
  type CleanupResultDto, type CleanupRunDto, type DiskDto, type StorageCategoryDto, type StorageDto, type StorageSettingsDto,
} from '@airlock/shared'
import { db, schema, getSetting, setSetting } from '../db/index.js'
import { config } from '../config.js'
import * as docker from '../drivers/docker.js'
import { audit } from '../domain/audit.js'
import { notify } from '../notify/send.js'
import { AppError, badRequest } from '../lib/errors.js'
import { log } from '../lib/log.js'
import {
  findOrphanVolumes, planCleanup, planToDto,
  type DeploymentRow, type FileEntry, type FileListing, type Plan, type ProjectRow, type ScopeLabel,
} from './plan.js'

/**
 * Nacht 3, Etappe 3: Server › Speicher. Misst die Belegung (Platte, `docker
 * system df`, Ablagen von Airlock), plant und führt das Aufräumen aus
 * (wöchentlich und «Jetzt aufräumen»), warnt bei voller Platte und sperrt
 * Deploys ab 95 %. Was weg darf, entscheidet storage/plan.ts (rein, getestet).
 */

const DAY = 86_400_000
const SETTINGS_KEY = 'storage_settings'
const LAST_RUN_KEY = 'storage_cleanup_last'
const FIRST_SEEN_KEY = 'storage_cleanup_first_seen'
const DISK_NOTIFIED_KEY = 'disk_warning_notified_at'
/** Grössen bleiben so lange zwischengespeichert (Volumes auszumessen dauert) */
const CACHE_MS = 10 * 60_000

/* --- Einstellungen --------------------------------------------------------- */

export const DEFAULT_STORAGE_SETTINGS: StorageSettingsDto = { keepVersions: STORAGE_DEFAULT_KEEP_VERSIONS, pruneBuildCache: true }

export async function getStorageSettings(): Promise<StorageSettingsDto> {
  const raw = await getSetting(SETTINGS_KEY)
  if (!raw) return { ...DEFAULT_STORAGE_SETTINGS }
  try {
    const parsed = storageSettingsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : { ...DEFAULT_STORAGE_SETTINGS }
  } catch {
    return { ...DEFAULT_STORAGE_SETTINGS }
  }
}

export async function putStorageSettings(input: unknown, actor: string): Promise<StorageSettingsDto> {
  const s = storageSettingsSchema.parse(input)
  const before = await getStorageSettings()
  await setSetting(SETTINGS_KEY, JSON.stringify(s))
  cache = null
  await audit({
    actor, action: 'storage.settings', targetType: 'system', targetId: 'storage', environmentId: null,
    params: { keepVersions: s.keepVersions, pruneBuildCache: s.pruneBuildCache, before: before.keepVersions }, result: 'ok',
  })
  return s
}

/** Für pruneOldDeployments (nach jedem Deploy): wie viele frühere Fassungen bleiben */
export async function keepVersionsSetting(): Promise<number> {
  return (await getStorageSettings().catch(() => DEFAULT_STORAGE_SETTINGS)).keepVersions
}

/* --- Platte ------------------------------------------------------------------ */

type DiskReader = () => Promise<DiskDto | null>

/**
 * Platte, auf der die Daten von Airlock liegen (Volume unter /var/lib/docker,
 * in aller Regel dieselbe wie die von Docker). null: nicht lesbar.
 */
const statfsDisk: DiskReader = async () => {
  try {
    const s = await statfs(config.DATA_DIR)
    const blocks = Number(s.blocks)
    const bfree = Number(s.bfree)
    const bavail = Number(s.bavail)
    const bsize = Number(s.bsize)
    const percent = diskPercentOf({ blocks, bfree, bavail })
    if (percent === null) return null
    return { usedBytes: (blocks - bfree) * bsize, totalBytes: blocks * bsize, percent, level: diskLevel(percent) }
  } catch {
    return null
  }
}

let diskReader: DiskReader = statfsDisk

/** Tests: Platte vorgeben (null = wieder echt) */
export function setDiskReader(fn: DiskReader | null): void {
  diskReader = fn ?? statfsDisk
}

export const readDisk = (): Promise<DiskDto | null> => diskReader()

export function diskFullMessage(percent: number): string {
  return `Der Server ist zu ${percent} % belegt. Ab ${DISK_BLOCK_PERCENT} % nimmt Airlock keine Deploys an, damit die Platte nicht vollläuft. ` +
    'Unter Server › Speicher aufräumen; ein Rollback auf eine frühere Fassung geht weiterhin.'
}

/** Vor jedem Deploy (nicht vor Rollback, Start, Stopp): ab 95 % ablehnen. Platte nicht lesbar: nicht sperren. */
export async function assertDiskRoom(): Promise<void> {
  const d = await readDisk().catch(() => null)
  if (d && d.percent >= DISK_BLOCK_PERCENT) throw new AppError('disk_full', diskFullMessage(d.percent), 409)
}

/** Alle 10 Minuten: ab 90 % eine Benachrichtigung (ntfy/E-Mail), höchstens eine pro Tag */
export async function checkDiskAndNotify(now = Date.now()): Promise<boolean> {
  const d = await readDisk()
  if (!d || d.percent < DISK_NOTIFY_PERCENT) return false
  const last = Date.parse((await getSetting(DISK_NOTIFIED_KEY)) ?? '')
  if (Number.isFinite(last) && now - last < DAY) return false
  await notify('disk_space', {
    percent: d.percent,
    used: gb(d.usedBytes),
    total: gb(d.totalBytes),
    blocked: d.percent >= DISK_BLOCK_PERCENT,
    reclaimable: cache ? gb(cache.dto.plan.bytes) : null,
  })
  await setSetting(DISK_NOTIFIED_KEY, new Date(now).toISOString())
  return true
}

const gb = (n: number) => `${(n / 1e9).toLocaleString('de-CH', { maximumFractionDigits: 1 })} GB`

/* --- Messen ------------------------------------------------------------------ */

/** Grösse eines Ordners (Dateigrössen, Verweise nicht verfolgt) und seine Änderungszeit */
async function du(path: string): Promise<{ bytes: number; mtimeMs: number }> {
  const st = await lstat(path).catch(() => null)
  if (!st) return { bytes: 0, mtimeMs: 0 }
  if (!st.isDirectory()) return { bytes: st.isFile() ? st.size : 0, mtimeMs: st.mtimeMs }
  let bytes = 0
  const dir = await opendir(path).catch(() => null)
  if (!dir) return { bytes: 0, mtimeMs: st.mtimeMs }
  for await (const e of dir) {
    const p = join(path, e.name)
    if (e.isDirectory()) bytes += (await du(p)).bytes
    else if (e.isFile()) bytes += (await lstat(p).catch(() => null))?.size ?? 0
  }
  return { bytes, mtimeMs: st.mtimeMs }
}

async function entries(dir: string, o: { dirs: boolean }): Promise<FileEntry[]> {
  const names = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: FileEntry[] = []
  for (const e of names) {
    if (o.dirs ? !e.isDirectory() : !e.isFile()) continue
    const { bytes, mtimeMs } = await du(join(dir, e.name))
    out.push({ name: e.name, bytes, mtimeMs })
  }
  return out
}

const uploadsDir = () => join(config.DATA_DIR, 'uploads')
const artifactsDir = () => join(config.DATA_DIR, 'deployments')
const deployLogsDir = () => join(config.DATA_DIR, 'logs', 'deployments')

async function listFiles(): Promise<FileListing> {
  const sites: FileListing['sites'] = []
  for (const e of await readdir(config.SITES_DIR, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue
    const base = join(config.SITES_DIR, e.name)
    const versions = await entries(base, { dirs: true })
    const current = await readlink(join(base, 'current')).catch(() => null)
    const st = await lstat(base).catch(() => null)
    sites.push({
      slug: e.name, current: current ? current.replace(/\/+$/, '').split('/').pop() ?? null : null, versions,
      bytes: versions.reduce((s, v) => s + v.bytes, 0), mtimeMs: st?.mtimeMs ?? 0,
    })
  }
  return {
    sites,
    uploads: await entries(uploadsDir(), { dirs: false }),
    artifacts: await entries(artifactsDir(), { dirs: true }),
    logs: await entries(deployLogsDir(), { dirs: false }),
  }
}

async function loadRows(): Promise<{ projects: ProjectRow[]; deployments: DeploymentRow[] }> {
  const projects = (await db.select({ id: schema.projects.id, slug: schema.projects.slug, sourceConfig: schema.projects.sourceConfig }).from(schema.projects))
    .map((p) => ({ id: p.id, slug: p.slug, uploadId: (p.sourceConfig as { uploadId?: string } | null)?.uploadId ?? null }))
  const deployments = (await db.select().from(schema.deployments).orderBy(desc(schema.deployments.startedAt))).map((d) => ({
    id: d.id,
    projectId: d.projectId,
    status: d.status,
    isActive: d.isActive,
    startedAt: d.startedAt.getTime(),
    imageRef: d.imageRef,
    builtImages: d.artifact?.builtImages ?? [],
    siteVersion: d.artifact?.siteVersion ?? d.version ?? null,
  }))
  return { projects, deployments }
}

export interface CleanupOptions {
  /** Nur Docker-Objekte mit diesem Label zusätzlich (Smoke-Test); dann auch kein Build-Cache und keine Dateien */
  scope?: ScopeLabel | null
  /** Mindestalter für Images, Container, Versionsordner (Standard 1 Stunde) */
  minAgeMs?: number
}

interface Snapshot {
  df: docker.SystemDf | null
  dfError: string | null
  rows: Awaited<ReturnType<typeof loadRows>>
  files: FileListing | null
  plan: Plan
  settings: StorageSettingsDto
}

async function takeSnapshot(o: CleanupOptions = {}): Promise<Snapshot> {
  const [rows, settings] = await Promise.all([loadRows(), getStorageSettings()])
  let df: docker.SystemDf | null = null
  let dfError: string | null = null
  try {
    df = await docker.systemDf()
  } catch (err) {
    dfError = dockerDfProblem(err)
  }
  // Im Smoke-Test (scope) keine Dateien: die gehören der Installation, nicht dem Test
  const files = o.scope ? null : await listFiles()
  const plan = planCleanup({
    now: Date.now(),
    projects: rows.projects,
    deployments: rows.deployments,
    images: df?.images ?? [],
    containers: df?.containers ?? [],
    buildCache: df?.buildCache ?? [],
    settings,
    minAgeMs: o.minAgeMs,
    scope: o.scope ?? null,
    ...(files ? { files } : {}),
  })
  // Ohne Docker-Sicht nichts an Fassungen ändern: deren Images liessen sich nicht prüfen
  if (!df) plan.deployments = []
  return { df, dfError, rows, files, plan, settings }
}

function dockerDfProblem(err: unknown): string {
  const status = (err as { statusCode?: number }).statusCode
  if (status === 403) {
    return 'Die Docker-Belegung ist nicht lesbar: der Socket-Proxy erlaubt /system/df nicht. In compose.yaml beim Dienst socket-proxy SYSTEM: 1 setzen und «docker compose up -d socket-proxy» ausführen.'
  }
  return `Die Docker-Belegung ist nicht lesbar: ${(err as Error).message}`
}

/* --- Übersicht --------------------------------------------------------------- */

let cache: { at: number; dto: StorageDto } | null = null
let running = false

function categories(s: Snapshot): StorageCategoryDto[] {
  const out: StorageCategoryDto[] = []
  const planned = (kind: string) => planToDto(s.plan).byKind.find((k) => k.kind === kind)?.bytes ?? 0
  if (s.df) {
    const df = s.df
    out.push({
      key: 'images', label: 'Images', bytes: df.layersSize || df.images.reduce((a, i) => a + i.size - Math.max(0, i.sharedSize), 0),
      reclaimableBytes: planned('image'), count: df.images.length,
      note: 'Nur Images mit Airlock-Label. Das aktive Image eines Projekts und Images fremder Container bleiben immer.',
    })
    out.push({
      key: 'build-cache', label: 'Build-Cache', bytes: df.buildCache.filter((b) => !b.shared).reduce((a, b) => a + b.size, 0),
      reclaimableBytes: s.plan.buildCache?.bytes ?? 0, count: df.buildCache.length,
      note: s.settings.pruneBuildCache ? `Unbenutzt und älter als ${BUILD_CACHE_MAX_AGE_DAYS} Tage.` : 'Aufräumen des Build-Caches ist ausgeschaltet.',
    })
    out.push({
      key: 'containers', label: 'Container', bytes: df.containers.reduce((a, c) => a + c.sizeRw, 0),
      reclaimableBytes: planned('container'), count: df.containers.length,
      note: 'Nur gestoppte Wegwerf-Container von Airlock (Build, Scan, Backup). Container-Logs begrenzt Docker auf 50 MB je Container.',
    })
    out.push({
      key: 'volumes', label: 'Volumes', bytes: df.volumes.reduce((a, v) => a + (v.size ?? 0), 0),
      reclaimableBytes: 0, count: df.volumes.length,
      note: 'Nie automatisch. Enthält auch die Ablagen von Airlock (Seiten, Daten, Backup-Staging).',
    })
  }
  if (s.files) {
    const f = s.files
    out.push({ key: 'sites', label: 'Statische Seiten', bytes: f.sites.reduce((a, x) => a + x.bytes, 0), reclaimableBytes: planned('site-version'), count: null, note: 'Ausgelieferte Fassungen; die aktive und die für ein Rollback bleiben.' })
    out.push({ key: 'uploads', label: 'Uploads', bytes: f.uploads.reduce((a, x) => a + x.bytes, 0), reclaimableBytes: planned('upload'), count: f.uploads.length, note: 'Hochgeladene ZIP- und Compose-Dateien; die eines Projekts bleiben.' })
    out.push({ key: 'artifacts', label: 'Deploy-Artefakte', bytes: f.artifacts.reduce((a, x) => a + x.bytes, 0), reclaimableBytes: planned('artifact'), count: f.artifacts.length, note: 'Compose-Dateien der aufbewahrten Fassungen (für ein Rollback).' })
  }
  return out
}

async function extraSizes(s: Snapshot, out: StorageCategoryDto[]): Promise<void> {
  if (s.files) {
    const [logs, access] = await Promise.all([du(join(config.DATA_DIR, 'logs')), du(config.ACCESS_LOG_DIR)])
    const planned = planToDto(s.plan).byKind.find((k) => k.kind === 'log')?.bytes ?? 0
    out.push({ key: 'logs', label: 'Logs', bytes: logs.bytes + access.bytes, reclaimableBytes: planned, count: null, note: 'Deploy-Logs und Zugriffs-Log von Caddy (rotiert, höchstens 2 Tage).' })
  }
  const staging = s.df?.volumes.find((v) => v.name === config.BACKUP_STAGING_VOLUME)
  if (staging && staging.size !== null) {
    out.push({ key: 'backup-staging', label: 'Backup-Staging', bytes: staging.size, reclaimableBytes: 0, count: null, note: 'Zwischenablage des Backups; leert der Backup-Lauf selbst.' })
  }
}

async function lastRun(): Promise<CleanupRunDto | null> {
  const raw = await getSetting(LAST_RUN_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as CleanupRunDto
  } catch {
    return null
  }
}

/** Nächster automatischer Lauf: eine Woche nach dem letzten; ohne Lauf eine Woche nach dem Update */
export async function nextRunAt(): Promise<Date> {
  const last = await lastRun()
  if (last) return new Date(Date.parse(last.at) + STORAGE_CLEANUP_INTERVAL_DAYS * DAY)
  let first = await getSetting(FIRST_SEEN_KEY)
  if (!first) {
    first = new Date().toISOString()
    await setSetting(FIRST_SEEN_KEY, first)
  }
  return new Date(Date.parse(first) + STORAGE_CLEANUP_INTERVAL_DAYS * DAY)
}

export async function storageOverview(o: { refresh?: boolean } = {}): Promise<StorageDto> {
  const disk = await readDisk()
  if (!o.refresh && cache && Date.now() - cache.at < CACHE_MS) {
    return { ...cache.dto, disk, deploysBlocked: !!disk && disk.percent >= DISK_BLOCK_PERCENT, running, lastRun: await lastRun(), nextRunAt: (await nextRunAt()).toISOString() }
  }
  const s = await takeSnapshot()
  const cats = categories(s)
  await extraSizes(s, cats)
  const knownSlugs = new Set(s.rows.projects.map((p) => p.slug))
  const dto: StorageDto = {
    disk,
    categories: cats,
    plan: planToDto(s.plan),
    orphanVolumes: s.df ? findOrphanVolumes(s.df.volumes, knownSlugs, s.df.containers) : [],
    settings: s.settings,
    lastRun: await lastRun(),
    nextRunAt: (await nextRunAt()).toISOString(),
    deploysBlocked: !!disk && disk.percent >= DISK_BLOCK_PERCENT,
    measuredAt: new Date().toISOString(),
    running,
    problems: s.dfError ? [s.dfError] : [],
  }
  cache = { at: Date.now(), dto }
  return dto
}

/* --- Aufräumen --------------------------------------------------------------- */

export interface CleanupReport extends CleanupResultDto {
  /** Was der Lauf vorhatte (für die CLI) */
  plan: ReturnType<typeof planToDto>
}

/** Nur planen, nichts löschen (CLI ohne --apply) */
export async function previewCleanup(o: CleanupOptions = {}): Promise<{ plan: ReturnType<typeof planToDto>; problems: string[]; orphanVolumes: ReturnType<typeof findOrphanVolumes> }> {
  const s = await takeSnapshot(o)
  const knownSlugs = new Set(s.rows.projects.map((p) => p.slug))
  return {
    plan: planToDto(s.plan),
    problems: s.dfError ? [s.dfError] : [],
    orphanVolumes: s.df ? findOrphanVolumes(s.df.volumes, knownSlugs, s.df.containers, o.scope) : [],
  }
}

/**
 * Räumt genau das auf, was der Plan nennt – Reihenfolge: Wegwerf-Container,
 * Images (nie erzwungen), Dateien, Fassungen in der Liste, Build-Cache.
 * Fehler einzelner Posten brechen nicht ab; sie stehen im Ergebnis und im Audit.
 */
export async function runStorageCleanup(actor: string, trigger: CleanupRunDto['trigger'], o: CleanupOptions = {}): Promise<CleanupReport> {
  if (running) throw new AppError('conflict', 'Das Aufräumen läuft schon', 409)
  running = true
  try {
    const s = await takeSnapshot(o)
    if (!s.df) throw new AppError('docker_df', s.dfError ?? 'Die Docker-Belegung ist nicht lesbar', 502)
    const plan = s.plan
    let freed = 0
    let removed = 0
    const errors: string[] = []
    const fail = (what: string, err: unknown) => {
      const status = (err as { statusCode?: number }).statusCode
      errors.push(`${what}: ${status === 409 ? 'wird gerade benutzt' : (err as Error).message}`)
    }

    for (const c of plan.containers) {
      try {
        await docker.removeStoppedContainer(c.id)
        freed += c.bytes
        removed++
      } catch (err) { fail(`Container ${c.name}`, err) }
    }
    for (const img of plan.images) {
      try {
        // Über die (eigenen) Tags: ein Image mit mehreren Tags verschwindet mit dem letzten
        if (img.tags.length) for (const t of img.tags) await docker.removeImage(t)
        else await docker.removeImage(img.id)
        freed += img.bytes
        removed++
      } catch (err) { fail(`Image ${img.tags[0] ?? img.id.slice(7, 19)}`, err) }
    }
    const bases: Record<string, string> = { 'site-version': config.SITES_DIR, upload: uploadsDir(), artifact: artifactsDir(), log: deployLogsDir() }
    for (const f of plan.files) {
      try {
        await rm(join(bases[f.kind]!, ...f.path), { recursive: true, force: true })
        if (f.kind === 'upload' && f.uploadId) await db.delete(schema.uploads).where(eq(schema.uploads.id, f.uploadId))
        freed += f.bytes
        removed++
      } catch (err) { fail(f.name, err) }
    }
    if (plan.deployments.length) {
      try {
        const ids = plan.deployments.map((d) => d.id)
        for (const id of ids) await rm(join(config.DATA_DIR, 'scan-src', id), { recursive: true, force: true }).catch(() => {})
        await db.delete(schema.deployments).where(inArray(schema.deployments.id, ids))
        removed += ids.length
      } catch (err) { fail('Fassungen in der Liste', err) }
    }
    let buildCacheFreed = 0
    if (plan.buildCache && plan.buildCache.count > 0) {
      try {
        buildCacheFreed = await docker.pruneBuildCache(BUILD_CACHE_MAX_AGE_DAYS * 24)
        freed += buildCacheFreed
      } catch (err) { fail('Build-Cache', err) }
    }

    const run: CleanupRunDto = { at: new Date().toISOString(), actor, trigger, ok: errors.length === 0, freedBytes: freed, removed, failed: errors.length }
    const dto = planToDto(plan)
    // Smoke-Test (scope): nichts an der Übersicht der Installation ändern
    if (!o.scope) await setSetting(LAST_RUN_KEY, JSON.stringify(run))
    await audit({
      actor, action: 'storage.cleanup', targetType: 'system', targetId: 'storage', environmentId: null,
      params: {
        trigger, freedBytes: freed, removed, failed: errors.length, buildCacheBytes: buildCacheFreed,
        kinds: Object.fromEntries(dto.byKind.map((k) => [k.kind, k.count])),
        ...(o.scope ? { scope: `${o.scope.key}=${o.scope.value}` } : {}),
      },
      result: errors.length ? 'error' : 'ok',
      error: errors.length ? errors.slice(0, 5).join(' · ') : null,
    })
    cache = null
    return { run, errors, plan: dto }
  } finally {
    running = false
  }
}

/* --- Verwaiste Volumes ----------------------------------------------------- */

/**
 * Ein verwaistes Volume löschen: nur, wenn es jetzt noch verwaist und nicht
 * eingehängt ist, und nur mit eingetipptem Namen. Erneute Bestätigung
 * (sudo) verlangt der Wächter (http/auth.ts, SUDO_ROUTES).
 */
export async function deleteOrphanVolume(name: string, confirm: string, actor: string): Promise<void> {
  if (confirm.trim() !== name) throw badRequest('Zum Löschen den Namen des Volumes genau eintippen')
  const [df, rows] = await Promise.all([docker.systemDf(), loadRows()])
  const knownSlugs = new Set(rows.projects.map((p) => p.slug))
  const orphan = findOrphanVolumes(df.volumes, knownSlugs, df.containers).find((v) => v.name === name)
  if (!orphan) throw new AppError('not_found', 'Kein verwaistes Volume mit diesem Namen (vielleicht gehört es wieder zu einem Projekt)', 404)
  if (orphan.inUse) throw new AppError('conflict', 'Das Volume ist in einen Container eingehängt und bleibt', 409)
  try {
    await docker.removeVolume(name)
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode
    await audit({ actor, action: 'storage.volume.delete', targetType: 'system', targetId: 'storage', environmentId: null, params: { volume: name, project: orphan.project }, result: 'error', error: (err as Error).message })
    if (status === 409) throw new AppError('conflict', 'Das Volume wird gerade benutzt und bleibt', 409)
    throw err
  }
  cache = null
  await audit({ actor, action: 'storage.volume.delete', targetType: 'system', targetId: 'storage', environmentId: null, params: { volume: name, project: orphan.project, bytes: orphan.bytes }, result: 'ok' })
}

/* --- Zeitplan ---------------------------------------------------------------- */

export async function runScheduledCleanupIfDue(now = Date.now()): Promise<boolean> {
  if (running) return false
  if ((await nextRunAt()).getTime() > now) return false
  const r = await runStorageCleanup('system', 'schedule')
  log.info('Wöchentliches Aufräumen', { freedBytes: r.run.freedBytes, removed: r.run.removed, failed: r.run.failed })
  return true
}

export function startStorageJobs(): NodeJS.Timeout[] {
  const weekly = () => runScheduledCleanupIfDue().catch((err) => log.warn('Wöchentliches Aufräumen fehlgeschlagen', { err: String(err) }))
  const disk = () => checkDiskAndNotify().catch((err) => log.warn('Prüfung der Platte fehlgeschlagen', { err: String(err) }))
  // Erster Blick kurz nach dem Start; nextRunAt legt beim ersten Mal das Datum fest
  setTimeout(() => { void disk(); void weekly() }, 2 * 60_000).unref()
  const a = setInterval(weekly, 60 * 60_000)
  const b = setInterval(disk, 10 * 60_000)
  a.unref()
  b.unref()
  return [a, b]
}

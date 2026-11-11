import { eq } from 'drizzle-orm'
import type { BackupProjectDto, BackupRunDto, BackupStatusDto } from '@airlock/shared'
import { db, schema, tryLockProject, type ProjectLock } from '../db/index.js'
import { config } from '../config.js'
import * as docker from '../drivers/docker.js'
import { AppError, badRequest, conflict } from '../lib/errors.js'
import { redactSecrets } from '../lib/redact.js'
import { log } from '../lib/log.js'
import { audit } from '../domain/audit.js'
import { allEnvironments, environmentById } from '../domain/environments.js'
import { notify } from '../notify/send.js'
import {
  backupArgs, forgetArgs, checkArgs, targetSecrets, errorTail, maskCredentials,
  parseBackupSummary, volumeCopyCmd, BACKUP_PARTIAL_EXIT, STAGING_DIR,
} from './restic.js'
import { checkDue, isStale, nextSlot } from './rules.js'
import { abandonJobs } from './dispatch.js'
import { keyStatus } from './key-service.js'
import { lastRestore, restoreRunning } from './restore.js'
import { resolveSettings, getBackupSettings, loadState, patchState, noteRepositoryReached, lastCheckFor, type ResolvedBackupSettings } from './settings.js'
import {
  T_PROBE, StepError, assertBackupContainer, contextFor, describeTarget, ensureRepository, failText, inBackup, lastBackupSuccess, listRuns, restic, runDto,
} from './service.js'

/**
 * Meilenstein Backup, Etappe 2: ein Lauf – Sperre, pg_dump ins Staging,
 * Projekt-Volumes (live, mit kurzem Stopp oder gar nicht), restic backup mit
 * Tags, Aufbewahrung (forget --prune), einmal pro Woche restic check;
 * danach Audit, bei Fehlschlag Benachrichtigung.
 *
 * restic, pg_dump und das Staging laufen als Aufträge im Backup-Container
 * (backup/dispatch.ts, kein exec). Projekt-Volumes kopiert ein kurzlebiger
 * Hilfscontainer im Projekt-Netz ins Staging; er geht über die Create-API
 * wie jeder andere Container durch die Erlaubnisliste (drivers/policy.ts),
 * mit dem Staging-Volume als ausdrücklich erlaubtem Zusatz-Volume. Den
 * Backup-Container selbst die Projekt-Volumes einbinden zu lassen ginge
 * nicht: sie entstehen zur Laufzeit, compose.yaml kennt sie nicht. Stopp und
 * Start der Projekt-Container im Modus «stop» macht Airlock selbst über den
 * Socket-Proxy (CONTAINERS, POST).
 */

const MIN = 60_000
const HOUR = 60 * MIN
const T_DUMP = 30 * MIN
const T_COPY = 30 * MIN
const T_BACKUP = 6 * HOUR
const T_FORGET = 2 * HOUR
const T_CHECK = 6 * HOUR
/** Kleines Image für die Volume-Kopie (wie beim Übergang aus der deployer-Zeit) */
const VOLUME_COPY_IMAGE = 'alpine:3.20'
/** Schlüssel der Sperre (pg_advisory_lock): nie zwei Läufe gleichzeitig, auch nicht aus zwei Prozessen */
export const BACKUP_LOCK_ID = 'airlock:backup'
const LOCK_ID = BACKUP_LOCK_ID

let running: string | null = null

export const backupRunning = (): boolean => running !== null

const fmt = (d: Date | null) => (d ? d.toLocaleString('de-CH', { timeZone: process.env.TZ || 'Europe/Zurich', dateStyle: 'medium', timeStyle: 'short' }) : null)

/* --- Projekt-Volumes ---------------------------------------------------------------- */

/**
 * Projekt-Volumes (Compose) ins Staging kopieren, je nach Einstellung live
 * oder mit kurzem Stopp. Gibt Hinweise zurück; ein einzelnes Projekt lässt
 * den Lauf nicht scheitern.
 */
async function copyProjectVolumes(modes: ResolvedBackupSettings['projects'], runId: string): Promise<string[]> {
  const warnings: string[] = []
  const projects = await db.select({ id: schema.projects.id, slug: schema.projects.slug }).from(schema.projects).orderBy(schema.projects.slug)
  let imageReady = false
  for (const p of projects) {
    const mode = modes[p.slug] ?? 'live'
    if (mode === 'skip') continue
    const network = docker.projectNetworkName(p.slug)
    const volumes = await docker.listComposeVolumes(network)
    if (!volumes.length) continue
    if (!imageReady) {
      if (!(await docker.imageExists(VOLUME_COPY_IMAGE))) await docker.pullImage(VOLUME_COPY_IMAGE)
      imageReady = true
    }

    let lock: ProjectLock | null = null
    const stopped: string[] = []
    try {
      if (mode === 'stop') {
        // Kein Stopp mitten in einem Deploy: dann lieber live (mit Hinweis)
        lock = await tryLockProject(p.id)
        if (!lock) warnings.push(`${p.slug}: ein Deploy lief gerade – Volumes live statt gestoppt gesichert`)
        else {
          for (const c of await docker.listManagedContainers()) {
            if (c.labels[docker.LABEL_PROJECT] === p.slug && c.running && !c.legacy) {
              await docker.stopContainer(c.id, 30)
              stopped.push(c.id)
            }
          }
        }
      }
      await docker.ensureNetwork(network)
      for (const v of volumes) {
        const name = v.volume ?? v.name.slice(network.length + 1)
        try {
          await copyVolume(p.slug, network, v.name, name, runId)
        } catch (err) {
          warnings.push(`${p.slug}: Volume ${name} nicht gesichert – ${(err as Error).message}`)
        }
      }
    } catch (err) {
      warnings.push(`${p.slug}: Volumes nicht gesichert – ${(err as Error).message}`)
    } finally {
      // Gestoppt wurde nur der Container, nicht das Projekt (Soll-Zustand unverändert)
      for (const id of stopped) {
        await docker.startContainer(id).catch((err) => warnings.push(`${p.slug}: Container nach dem Backup nicht wieder gestartet – ${(err as Error).message}`))
      }
      await lock?.release().catch(() => {})
    }
  }
  return warnings
}

async function copyVolume(slug: string, network: string, source: string, volume: string, runId: string): Promise<void> {
  const id = await docker.createAndStart({
    name: `${network}_backup_${runId.replace(/-/g, '').slice(0, 10)}_${volume.replace(/[^a-zA-Z0-9_.-]/g, '-')}`,
    image: VOLUME_COPY_IMAGE,
    network,
    env: {},
    labels: { [docker.LABEL_MANAGED]: 'true', [docker.LABEL_PROJECT]: slug, [docker.LABEL.role]: 'backup-copy' },
    memoryLimitMb: 256,
    cpuLimit: 1,
    oneShot: true,
    cmd: volumeCopyCmd(slug, volume),
    volumes: [
      { source, target: '/from', readOnly: true },
      { source: config.BACKUP_STAGING_VOLUME, target: STAGING_DIR },
    ],
    extraVolumes: [{ name: config.BACKUP_STAGING_VOLUME }],
  })
  try {
    const r = await docker.waitForExit(id, T_COPY)
    if (r.timedOut || r.exitCode !== 0) {
      const tail = await docker.getLogs(id, { tail: 10 }).catch(() => '')
      throw new Error(`${r.timedOut ? 'Zeitlimit' : `Exit ${r.exitCode}`}${tail.trim() ? `: ${tail.trim()}` : ''}`)
    }
  } finally {
    await docker.removeContainer(id)
  }
}

/* --- Ein Lauf ---------------------------------------------------------------------- */

interface Outcome {
  status: 'ok' | 'warning' | 'failed'
  snapshotId: string | null
  bytesNew: number | null
  bytesTotal: number | null
  filesNew: number | null
  error: string | null
  warnings: string[]
}

async function execute(runId: string, s: ResolvedBackupSettings): Promise<Outcome> {
  const out: Outcome = { status: 'ok', snapshotId: null, bytesNew: null, bytesTotal: null, filesNew: null, error: null, warnings: [] }
  let secrets: string[] = targetSecrets(s.target, s.password)
  let staged = false
  try {
    const ctx = contextFor(s)
    secrets = ctx.secrets
    await assertBackupContainer()

    // 1. Repository (legt es an, falls es fehlt)
    await ensureRepository(ctx)

    // 2. Staging leeren, Datenbank abziehen (pg_dump über das interne Netz)
    staged = true
    const prep = await inBackup('staging-prepare', [], null, T_PROBE)
    if (prep.exitCode !== 0 || prep.timedOut) throw new StepError(failText('Staging nicht bereit', prep, secrets))
    const dump = await inBackup('pg-dump', [], null, T_DUMP)
    if (dump.exitCode !== 0 || dump.timedOut) throw new StepError(failText('Datenbank-Dump (pg_dump) gescheitert', dump, secrets))

    // 3. Projekt-Volumes nach Einstellung (live, Stopp, keine)
    out.warnings.push(...(await copyProjectVolumes(s.projects, runId)))

    // 4. Sichern
    const environments = allEnvironments().map((e) => e.slug)
    const b = await restic(backupArgs({ version: config.version, environments }), ctx, T_BACKUP)
    if (b.timedOut || (b.exitCode !== 0 && b.exitCode !== BACKUP_PARTIAL_EXIT)) throw new StepError(failText('restic backup gescheitert', b, secrets))
    const summary = parseBackupSummary(b.stdout)
    if (!summary?.snapshotId) throw new StepError(failText('restic backup hat keinen Stand gemeldet', b, secrets))
    Object.assign(out, { snapshotId: summary.snapshotId, bytesNew: summary.bytesNew, bytesTotal: summary.bytesTotal, filesNew: summary.filesNew })
    if (b.exitCode === BACKUP_PARTIAL_EXIT) out.warnings.push(`Einige Dateien waren nicht lesbar und fehlen im Stand: ${errorTail(b.stderr, secrets, 3)}`)
    await noteRepositoryReached(ctx.target)

    // 5. Aufbewahrung (ein Fehler hier lässt den neuen Stand gelten)
    const f = await restic(forgetArgs(s.retention), ctx, T_FORGET)
    if (f.timedOut || f.exitCode !== 0) out.warnings.push(failText('Aufbewahrung (restic forget --prune) gescheitert', f, secrets))

    // 6. Einmal pro Woche: Struktur des Repositorys prüfen
    if (checkDue(lastCheckFor(await loadState(), ctx.target), new Date())) {
      const c = await restic(checkArgs(), ctx, T_CHECK)
      if (c.timedOut || c.exitCode !== 0) throw new StepError(failText('Prüfung des Repositorys (restic check) gescheitert', c, secrets))
      await patchState({ lastCheckAt: new Date().toISOString() })
    }
    if (out.warnings.length) out.status = 'warning'
  } catch (err) {
    out.status = 'failed'
    out.error = redactSecrets(maskCredentials(err instanceof Error ? err.message : String(err), secrets))
    if (!(err instanceof StepError) && !(err instanceof AppError)) log.error('Backup: unerwarteter Fehler', { err: out.error })
  } finally {
    // Staging nicht stehen lassen: Dump und Volume-Kopien belegen sonst dauerhaft Platz
    if (staged) await inBackup('staging-clean', [], null, T_PROBE).catch(() => {})
  }
  out.warnings = out.warnings.map((w) => redactSecrets(maskCredentials(w, secrets)))
  return out
}

/**
 * Einen Lauf starten. Gibt sofort den angelegten Lauf zurück; `done` endet
 * mit dem Ergebnis. 409, wenn schon einer läuft (hier oder in einem zweiten
 * Prozess – die Sperre liegt in Postgres).
 */
export async function startBackup(trigger: 'schedule' | 'manual', actor: string): Promise<{ run: BackupRunDto; done: Promise<BackupRunDto> }> {
  if (running) throw conflict('Es läuft schon eine Sicherung')
  // Etappe 5: während ein Projekt zurückgeholt wird, nicht sichern (gleiche Sperre in Postgres)
  if (restoreRunning()) throw conflict('Es läuft gerade eine Wiederherstellung – danach erneut versuchen')
  const s = await resolveSettings()
  if (!s.configured) throw badRequest('Die Sicherung ist noch nicht eingerichtet: Ziel und Repository-Passwort fehlen')
  running = 'starting'
  let lock: ProjectLock | null
  try {
    lock = await tryLockProject(LOCK_ID)
  } catch (err) {
    running = null
    throw err
  }
  if (!lock) {
    running = null
    throw conflict('Es läuft schon eine Sicherung oder eine Wiederherstellung')
  }
  const [row] = await db.insert(schema.backupRuns).values({ trigger, actor }).returning()
  running = row!.id
  log.info('Backup gestartet', { trigger, run: row!.id })

  const done = (async (): Promise<BackupRunDto> => {
    const started = Date.now()
    try {
      const o = await execute(row!.id, s)
      const finishedAt = new Date()
      const [updated] = await db.update(schema.backupRuns).set({
        status: o.status, finishedAt, durationMs: finishedAt.getTime() - started,
        snapshotId: o.snapshotId, bytesNew: o.bytesNew, bytesTotal: o.bytesTotal, filesNew: o.filesNew,
        error: o.error, warnings: o.warnings,
      }).where(eq(schema.backupRuns.id, row!.id)).returning()
      const dto = runDto(updated!)
      // In der Glocke: Läufe des Zeitplans (Akteur «system») und jeder Fehlschlag
      await audit({
        actor, action: 'backup.run', environmentId: null,
        params: { trigger, status: o.status, snapshotId: o.snapshotId, bytesNew: o.bytesNew, bytesTotal: o.bytesTotal, durationMs: dto.durationMs, warnings: o.warnings },
        result: o.status === 'failed' ? 'error' : 'ok', error: o.error,
      })
      if (o.status === 'failed') {
        log.warn('Backup fehlgeschlagen', { run: row!.id, err: o.error })
        await notify('backup_failed', { trigger, target: describeTarget(s.target), error: o.error, lastSuccess: fmt(await lastBackupSuccess()) })
      } else {
        log.info('Backup fertig', { run: row!.id, status: o.status, snapshot: o.snapshotId, bytesNew: o.bytesNew })
      }
      return dto
    } finally {
      running = null
      await lock!.release().catch(() => {})
    }
  })()
  // Ein Fehler beim Schreiben des Ergebnisses darf den Prozess nicht umwerfen
  done.catch((err) => log.error('Backup: Ergebnis nicht gespeichert', { run: row!.id, err: String(err) }))
  return { run: runDto(row!), done }
}

/**
 * Beim Start: Läufe, die ein Neustart abgebrochen hat, als gescheitert
 * markieren; ihre Aufträge im Backup-Container abbrechen bzw. zurückziehen.
 */
export async function abandonUnfinishedBackups(): Promise<number> {
  const jobs = await abandonJobs(config.BACKUP_JOBS_DIR).catch(() => 0)
  if (jobs) log.warn('Backup: Aufträge eines früheren Prozesses abgebrochen', { aufträge: jobs })
  const rows = await db.update(schema.backupRuns)
    .set({ status: 'failed', finishedAt: new Date(), error: 'Abgebrochen: Airlock wurde während der Sicherung neu gestartet' })
    .where(eq(schema.backupRuns.status, 'running')).returning({ id: schema.backupRuns.id })
  return rows.length
}

/* --- Status ------------------------------------------------------------------------- */

/** Projekte aller Umgebungen: Compose-Projekte für live/stop/skip (nur sie haben Volumes), alle für den Restore */
async function allProjects(): Promise<BackupProjectDto[]> {
  const rows = await db.select({ slug: schema.projects.slug, name: schema.projects.name, environmentId: schema.projects.environmentId, sourceType: schema.projects.sourceType })
    .from(schema.projects).orderBy(schema.projects.slug)
  return rows.map((r) => ({ slug: r.slug, name: r.name, environment: environmentById(r.environmentId)?.name ?? '', sourceType: r.sourceType }))
}

export async function backupStatus(now = new Date()): Promise<BackupStatusDto> {
  const [settings, runs, success, s, projects, key] = await Promise.all([getBackupSettings(), listRuns(20), lastBackupSuccess(), resolveSettings(), allProjects(), keyStatus()])
  return {
    settings,
    projects,
    key,
    restore: lastRestore(),
    running: backupRunning(),
    lastRun: runs[0] ?? null,
    lastSuccessAt: success ? success.toISOString() : null,
    stale: isStale({ now, enabled: s.enabled, configured: s.configured, lastSuccessAt: success, configuredAt: s.activeSince }),
    nextRunAt: s.configured && s.enabled ? nextSlot(now, s.time, s.timeZone).toISOString() : null,
    runs,
  }
}

/** Für die Meldung «48 h ohne Erfolg»: letzter Erfolg (lesbar) und letzter Fehler */
export async function staleContext(): Promise<{ lastSuccess: string | null; lastError: string | null }> {
  const [success, runs] = await Promise.all([lastBackupSuccess(), listRuns(1)])
  const last = runs[0]
  return { lastSuccess: fmt(success), lastError: last?.status === 'failed' ? last.error : null }
}

import { randomUUID } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { eq, or } from 'drizzle-orm'
import type { BackupRestoreDto, BackupRestorePartDto, BackupRestorePreviewDto } from '@airlock/shared'
import { db, schema, tryLockProject, type ProjectLock } from '../db/index.js'
import { config } from '../config.js'
import * as docker from '../drivers/docker.js'
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js'
import { redactSecrets } from '../lib/redact.js'
import { extractTarSafely } from '../lib/untar.js'
import { log } from '../lib/log.js'
import { publish } from '../lib/events.js'
import { audit } from '../domain/audit.js'
import { siteDir } from '../deploy/sources/static.js'
import { localRepoPath } from '../deploy/sources/files.js'
import { maskCredentials, STAGING_DIR } from './restic.js'
import { resolveSettings } from './settings.js'
import { StepError, T_PROBE, assertBackupContainer, contextFor, failText, inBackup, listSnapshots, restic } from './service.js'
import { BACKUP_LOCK_ID, backupRunning } from './run.js'
import { lsArgs, parseLs, projectPaths, restoredPath, volumeRestoreCmd, SNAPSHOT_RE } from './restore-plan.js'

/**
 * Meilenstein Backup, Etappe 5: ein Projekt aus einem Stand zurückholen –
 * Compose-Volumes, statische Seite, lokales Repository. Zerstörerisch: was
 * jetzt dort liegt, wird ersetzt. Die Oberfläche fragt deshalb modal nach
 * (Slug eintippen); die API verlangt dieselbe Bestätigung. Kein Restore per
 * MCP und nicht mit einem API-Token (http/auth.ts).
 *
 * Ohne exec, wie das Sichern: restic läuft als fester Auftrag
 * «restore-project <stand> <slug>» im Backup-Container (backup/runner.sh) und
 * legt die Teile im Staging unter /staging/restore ab. Von dort kopiert ein
 * Wegwerf-Container (durch die Erlaubnisliste, Staging nur lesend) die
 * Volumes zurück; Seite und Repository holt Airlock als Tar aus diesem
 * Container (GET /archive) und entpackt sie mit denselben Regeln wie eine
 * Build-Ausgabe (keine Links, kein Pfad aus dem Ziel heraus).
 *
 * Ablauf: Sperre (keine Sicherung, kein zweiter Restore, kein Deploy des
 * Projekts) → Teile ins Staging → laufende Container des Projekts stoppen →
 * Volumes, Seite, Repository ersetzen → Staging leeren → Container wieder
 * starten. Audit «backup.restore» am Projekt (Aktivität, Glocke).
 */

const MIN = 60_000
const T_RESTORE = 2 * 60 * MIN
const T_COPY = 30 * MIN
const HELPER_IMAGE = 'alpine:3.20'
/** Seiten und Repositorys aus dem eigenen Backup: grosszügiger als ein Upload */
const LIMITS = { maxArchiveBytes: 20 * 1024 ** 3, maxTotalBytes: 20 * 1024 ** 3, maxEntries: 500_000, maxFileBytes: 5 * 1024 ** 3 }

type Project = typeof schema.projects.$inferSelect

let current: BackupRestoreDto | null = null
export const restoreRunning = (): boolean => current?.status === 'running'
/** Laufender oder letzter Restore (seit dem Start von Airlock) */
export const lastRestore = (): BackupRestoreDto | null => current

async function findAnyProject(ref: string): Promise<Project> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)
  const rows = await db.select().from(schema.projects)
    .where(isUuid ? or(eq(schema.projects.id, ref), eq(schema.projects.slug, ref)) : eq(schema.projects.slug, ref)).limit(1)
  if (!rows[0]) throw notFound('Projekt')
  return rows[0]
}

const runningContainers = async (slug: string) =>
  (await docker.listManagedContainers()).filter((c) => c.labels[docker.LABEL_PROJECT] === slug && c.running && !c.legacy && !c.labels[docker.LABEL.role]?.startsWith('backup-'))

export async function previewRestore(snapshotRef: string, projectRef: string): Promise<BackupRestorePreviewDto> {
  if (!/^[0-9a-f]{8,64}$/.test(snapshotRef)) throw badRequest('Ungültige Kennung eines Stands', [{ path: 'snapshot', message: 'Ungültige Kennung eines Stands' }])
  const project = await findAnyProject(projectRef)
  const s = await resolveSettings()
  const ctx = contextFor(s)
  await assertBackupContainer()
  const snap = (await listSnapshots()).find((x) => x.id === snapshotRef || x.shortId === snapshotRef || x.id.startsWith(snapshotRef))
  if (!snap) throw notFound('Stand')
  const r = await restic(lsArgs(snap.id, project.slug), ctx, T_PROBE, { maxLines: 1_000_000 })
  if (r.timedOut || r.exitCode !== 0) throw new AppError('backup_repository', failText('Inhalt des Stands nicht lesbar', r, ctx.secrets), 502)
  const { parts, truncated } = parseLs(r.stdout, project.slug)
  return {
    snapshot: { id: snap.id, shortId: snap.shortId, time: snap.time },
    project: { id: project.id, slug: project.slug, name: project.name },
    parts,
    truncated,
    runningContainers: (await runningContainers(project.slug).catch(() => [])).length,
  }
}

const describePart = (p: BackupRestorePartDto) => (p.kind === 'volume' ? `Volume ${p.name}` : p.kind === 'site' ? 'Statische Seite' : 'Repository')

async function helper(slug: string, network: string, cmd: string[], extra: { source: string; target: string }[] = []): Promise<string> {
  if (!(await docker.imageExists(HELPER_IMAGE))) await docker.pullImage(HELPER_IMAGE)
  return docker.createOnly({
    name: `${network}_restore_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
    image: HELPER_IMAGE,
    network,
    env: {},
    labels: { [docker.LABEL_MANAGED]: 'true', [docker.LABEL_PROJECT]: slug, [docker.LABEL.role]: 'backup-restore' },
    memoryLimitMb: 256,
    cpuLimit: 1,
    oneShot: true,
    cmd,
    volumes: [...extra, { source: config.BACKUP_STAGING_VOLUME, target: STAGING_DIR, readOnly: true }],
    extraVolumes: [{ name: config.BACKUP_STAGING_VOLUME, readOnly: true }],
  })
}

async function restoreVolume(slug: string, network: string, part: BackupRestorePartDto): Promise<void> {
  const existing = (await docker.listComposeVolumes(network)).find((v) => (v.volume ?? v.name.slice(network.length + 1)) === part.name)
  const name = existing?.name ?? `${network}_${part.name}`
  if (!existing) await docker.createComposeVolume(name, network, part.name)
  const id = await helper(slug, network, volumeRestoreCmd(slug, part.name), [{ source: name, target: '/to' }])
  try {
    await docker.startById(id)
    const r = await docker.waitForExit(id, T_COPY)
    if (r.timedOut || r.exitCode !== 0) {
      const tail = await docker.getLogs(id, { tail: 10 }).catch(() => '')
      throw new StepError(`Volume ${part.name}: ${r.timedOut ? 'Zeitlimit' : `Exit ${r.exitCode}`}${tail.trim() ? ` – ${tail.trim()}` : ''}`)
    }
  } finally {
    await docker.removeContainer(id)
  }
}

/** Ordner aus dem Staging (über den Wegwerf-Container) an `dest` legen; das Bisherige wird ersetzt */
async function restoreDir(slug: string, network: string, from: string, dest: string): Promise<void> {
  const id = await helper(slug, network, ['true'])
  const tmp = join(dirname(dest), `.restore-${randomUUID().slice(0, 8)}`)
  try {
    const tar = await docker.getArchive(id, restoredPath(from))
    await extractTarSafely(tar, tmp, { stripFirst: true, limits: LIMITS })
    await rm(dest, { recursive: true, force: true })
    await rename(tmp, dest)
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw new StepError(`${dest}: ${(err as Error).message}`)
  } finally {
    await docker.removeContainer(id)
  }
}

export interface StartRestoreInput {
  snapshot: string
  project: string
  /** Slug des Projekts, eingetippt im Dialog */
  confirm: string
}

/**
 * Restore starten. Gibt sofort den laufenden Restore zurück; `done` endet mit
 * dem Ergebnis. 409, wenn gerade gesichert oder schon zurückgeholt wird oder
 * ein Deploy des Projekts läuft.
 */
export async function startRestore(input: StartRestoreInput, actor: string): Promise<{ restore: BackupRestoreDto; done: Promise<BackupRestoreDto> }> {
  if (!SNAPSHOT_RE.test(input.snapshot)) throw badRequest('Ungültige Kennung eines Stands')
  if (backupRunning() || restoreRunning()) throw conflict('Es läuft gerade eine Sicherung oder ein Restore')
  const project = await findAnyProject(input.project)
  if (input.confirm.trim() !== project.slug) {
    throw badRequest(`Zur Bestätigung den Slug «${project.slug}» eintippen`, [{ path: 'confirm', message: `Tippe «${project.slug}» ein` }])
  }
  const preview = await previewRestore(input.snapshot, project.id)
  if (preview.parts.length === 0) throw badRequest(`Dieser Stand enthält nichts von ${project.slug}`)

  const backupLock = await tryLockProject(BACKUP_LOCK_ID)
  if (!backupLock) throw conflict('Es läuft gerade eine Sicherung')
  const projectLock = await tryLockProject(project.id)
  if (!projectLock) {
    await backupLock.release()
    throw conflict(`Für ${project.slug} läuft gerade ein Deploy – danach erneut versuchen`)
  }
  const started = new Date()
  current = {
    id: randomUUID(), status: 'running', actor,
    project: { id: project.id, slug: project.slug, name: project.name },
    snapshot: { id: preview.snapshot.id, shortId: preview.snapshot.shortId, time: preview.snapshot.time },
    startedAt: started.toISOString(), finishedAt: null, error: null, restored: [], warnings: [],
  }
  const run = current
  log.info('Restore gestartet', { project: project.slug, snapshot: preview.snapshot.shortId })
  const done = execute(run, project, preview, [backupLock, projectLock])
  done.catch((err) => log.error('Restore: Ergebnis nicht gespeichert', { err: String(err) }))
  return { restore: { ...run }, done }
}

async function execute(run: BackupRestoreDto, project: Project, preview: BackupRestorePreviewDto, locks: ProjectLock[]): Promise<BackupRestoreDto> {
  const s = await resolveSettings()
  let secrets: string[] = []
  const network = docker.projectNetworkName(project.slug)
  const stopped: string[] = []
  let staged = false
  let outcome: 'ok' | 'error' = 'error'
  try {
    const ctx = contextFor(s)
    secrets = ctx.secrets
    // 1. Teile des Projekts ins Staging (/staging/restore)
    staged = true
    const r = await inBackup('restore-project', [preview.snapshot.id, project.slug], ctx, T_RESTORE)
    if (r.timedOut || r.exitCode !== 0) throw new StepError(failText('restic restore gescheitert', r, secrets))

    // 2. Projekt anhalten (nur die Container; der Soll-Zustand bleibt)
    for (const c of await runningContainers(project.slug)) {
      await docker.stopContainer(c.id, 30)
      stopped.push(c.id)
    }

    // 3. Ersetzen
    await docker.ensureNetwork(network)
    const p = projectPaths(project.slug)
    for (const part of preview.parts) {
      if (part.kind === 'volume') await restoreVolume(project.slug, network, part)
      else if (part.kind === 'site') await restoreDir(project.slug, network, p.site, siteDir(project.slug))
      else {
        const repo = project.localRepoPath ?? localRepoPath(project.slug)
        if (repo !== localRepoPath(project.slug)) {
          run.warnings.push(`Repository liegt nicht unter ${localRepoPath(project.slug)} (${repo}) – nicht zurückgeholt`)
          continue
        }
        await restoreDir(project.slug, network, p.repo, repo)
        if (!project.localRepoPath) await db.update(schema.projects).set({ localRepoPath: repo }).where(eq(schema.projects.id, project.id))
      }
      run.restored.push(describePart(part))
    }
    outcome = 'ok'
  } catch (err) {
    run.error = redactSecrets(maskCredentials(err instanceof Error ? err.message : String(err), secrets))
    if (!(err instanceof StepError) && !(err instanceof AppError)) log.error('Restore: unerwarteter Fehler', { err: run.error })
  } finally {
    if (staged) await inBackup('restore-clean', [], null, T_PROBE).catch(() => {})
    for (const id of stopped) {
      await docker.startContainer(id).catch((e) => run.warnings.push(`Container nach dem Restore nicht wieder gestartet – ${(e as Error).message}`))
    }
    for (const l of locks) await l.release().catch(() => {})
  }
  await audit({
    actor: run.actor, action: 'backup.restore', environmentId: project.environmentId, targetType: 'project', targetId: project.id,
    params: { snapshot: preview.snapshot.shortId, snapshotTime: preview.snapshot.time, restored: run.restored, warnings: run.warnings },
    result: outcome, error: run.error,
  })
  // Erst nach dem Audit «fertig»: wer auf das Ende wartet, findet den Eintrag schon vor
  run.finishedAt = new Date().toISOString()
  run.status = outcome === 'ok' ? 'ok' : 'failed'
  publish({ type: 'project', projectId: project.id })
  if (run.status === 'ok') log.info('Restore fertig', { project: project.slug, restored: run.restored })
  else log.warn('Restore gescheitert', { project: project.slug, err: run.error })
  return { ...run }
}

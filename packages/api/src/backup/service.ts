import { desc } from 'drizzle-orm'
import type { BackupRunDto, BackupSnapshotDto, BackupTestResultDto } from '@airlock/shared'
import { db, schema } from '../db/index.js'
import { config } from '../config.js'
import * as docker from '../drivers/docker.js'
import { AppError, badRequest } from '../lib/errors.js'
import { redactSecrets } from '../lib/redact.js'
import { audit } from '../domain/audit.js'
import {
  catConfigArgs, initArgs, snapshotsArgs, resticEnv, targetSecrets, errorTail, maskCredentials, parseSnapshots, classifyRepoProbe,
  type ResolvedTarget,
} from './restic.js'
import { resolveSettings, noteRepositoryReached, type ResolvedBackupSettings } from './settings.js'
import { runJob } from './dispatch.js'
import type { JobOp, JobResult } from './jobs.js'

/**
 * Meilenstein Backup, Etappe 1: Verbindung zum Ziel testen (Repository
 * anlegen, falls es fehlt), Stände und Läufe lesen. Das Sichern selbst
 * steht in backup/run.ts.
 *
 * restic läuft im Backup-Container aus compose.yaml (Service backup). Airlock
 * hat dorthin kein exec: es legt Aufträge in das gemeinsame Auftrags-Volume
 * (BACKUP_JOBS_DIR), der Ausführer im Container (backup/runner.sh) führt sie
 * aus und schreibt das Ergebnis zurück (backup/{jobs,dispatch}.ts).
 * Geheimnisse reisen nur in der kurzlebigen Datei <id>.env (0600), nie in
 * Argumenten.
 */

const MIN = 60_000
export const T_PROBE = 2 * MIN

/* --- Hilfen ------------------------------------------------------------------------ */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

export function runDto(r: typeof schema.backupRuns.$inferSelect): BackupRunDto {
  return {
    id: r.id,
    trigger: r.trigger,
    actor: r.actor,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: iso(r.finishedAt),
    durationMs: r.durationMs,
    snapshotId: r.snapshotId,
    bytesNew: r.bytesNew,
    bytesTotal: r.bytesTotal,
    filesNew: r.filesNew,
    error: redactSecrets(r.error) ?? null,
    warnings: (r.warnings ?? []).map((w) => redactSecrets(w)),
  }
}

/** Fehler eines Schritts mit einer Meldung für Nutzer, Log und Audit (geschwärzt) */
export class StepError extends Error {}

/** Ziel ohne Zugangsdaten, für Meldungen und das Audit-Log */
export function describeTarget(t: ResolvedTarget | null): string | null {
  if (!t) return null
  return t.kind === 'local' ? `lokal ${t.path}` : `S3 ${t.endpoint.replace(/^https?:\/\//, '')}/${t.bucket}${t.prefix ? `/${t.prefix}` : ''}`
}

export async function assertBackupContainer(): Promise<void> {
  const c = await docker.inspectContainer(config.BACKUP_CONTAINER).catch(() => null)
  if (!c?.running) {
    throw new AppError(
      'backup_container',
      `Der Backup-Container (${config.BACKUP_CONTAINER}) läuft nicht. Auf dem Server: «docker compose up -d backup» im Ordner von Airlock.`,
      503,
    )
  }
}

export interface Ctx {
  env: Record<string, string>
  secrets: string[]
}

export function contextFor(s: ResolvedBackupSettings): Ctx & { target: ResolvedTarget; password: string } {
  if (!s.configured || !s.target || !s.password) {
    throw badRequest('Die Sicherung ist noch nicht eingerichtet: Ziel und Repository-Passwort fehlen')
  }
  return { target: s.target, password: s.password, env: resticEnv(s.target, s.password), secrets: targetSecrets(s.target, s.password) }
}

/**
 * Auftrag an den Backup-Container; beim Zeitlimit bricht der Ausführer den
 * Befehl selbst ab (sonst liefe restic weiter und hielte die Sperre im
 * Repository).
 */
export function inBackup(op: JobOp, args: string[], ctx: Ctx | null, timeoutMs: number): Promise<JobResult> {
  return runJob(config.BACKUP_JOBS_DIR, { op, args, env: ctx?.env ?? {}, timeoutMs })
}

export const restic = (args: string[], ctx: Ctx, timeoutMs: number) => inBackup('restic', args, ctx, timeoutMs)

export function failText(what: string, r: JobResult, secrets: string[]): string {
  if (r.timedOut) return `${what}: Zeitlimit überschritten`
  const tail = errorTail(r.stderr.length ? r.stderr : r.stdout, secrets)
  return redactSecrets(`${what} (Exit ${r.exitCode})${tail ? `: ${tail}` : ''}`)
}

/**
 * Repository erreichbar? Fehlt es, wird es angelegt (erster Test oder erster
 * Lauf). Gibt zurück, ob es neu angelegt wurde; wirft StepError mit klarer
 * Meldung.
 */
export async function ensureRepository(ctx: Ctx): Promise<{ initialized: boolean }> {
  const probe = await restic(catConfigArgs(), ctx, T_PROBE)
  const kind = probe.timedOut ? 'error' : classifyRepoProbe(probe.exitCode, probe.stderr.join('\n'))
  if (kind === 'ok' || kind === 'locked') return { initialized: false }
  if (kind === 'wrong_password') throw new StepError('Das Repository-Passwort passt nicht zu diesem Repository')
  if (kind === 'missing') {
    const init = await restic(initArgs(), ctx, T_PROBE)
    if (init.exitCode !== 0 || init.timedOut) throw new StepError(failText('Repository konnte nicht angelegt werden', init, ctx.secrets))
    return { initialized: true }
  }
  throw new StepError(failText('Repository nicht erreichbar', probe, ctx.secrets))
}

/* --- Verbindung testen --------------------------------------------------------------- */

export async function testConnection(actor: string): Promise<BackupTestResultDto> {
  const s = await resolveSettings()
  const ctx = contextFor(s)
  await assertBackupContainer()
  let result: BackupTestResultDto
  try {
    const { initialized } = await ensureRepository(ctx)
    await noteRepositoryReached(ctx.target)
    result = { ok: true, initialized, message: initialized ? 'Repository angelegt und erreichbar' : 'Repository erreichbar, Passwort stimmt' }
  } catch (err) {
    if (!(err instanceof StepError)) throw err
    result = { ok: false, initialized: false, message: redactSecrets(maskCredentials(err.message, ctx.secrets)) }
  }
  await audit({
    actor, action: 'backup.test', environmentId: null,
    params: { kind: ctx.target.kind, target: describeTarget(ctx.target), initialized: result.initialized },
    result: result.ok ? 'ok' : 'error', error: result.ok ? null : result.message,
  })
  return result
}

/* --- Lesen --------------------------------------------------------------------------- */

export async function listRuns(limit = 20): Promise<BackupRunDto[]> {
  const rows = await db.select().from(schema.backupRuns).orderBy(desc(schema.backupRuns.startedAt)).limit(Math.min(Math.max(limit, 1), 200))
  return rows.map(runDto)
}

/** Ende des letzten erfolgreichen Laufs (auch mit Hinweisen) */
export async function lastBackupSuccess(): Promise<Date | null> {
  const rows = await db.select({ at: schema.backupRuns.finishedAt, status: schema.backupRuns.status })
    .from(schema.backupRuns).orderBy(desc(schema.backupRuns.startedAt)).limit(200)
  return rows.find((r) => r.status === 'ok' || r.status === 'warning')?.at ?? null
}

/** Stände im Repository (restic snapshots) – fragt das Ziel live ab */
export async function listSnapshots(): Promise<BackupSnapshotDto[]> {
  const s = await resolveSettings()
  const ctx = contextFor(s)
  await assertBackupContainer()
  const r = await restic(snapshotsArgs(), ctx, T_PROBE)
  if (r.timedOut || r.exitCode !== 0) {
    throw new AppError('backup_repository', failText('Stände nicht lesbar', r, ctx.secrets), 502)
  }
  try {
    return parseSnapshots(r.stdout.join('\n'))
  } catch (err) {
    throw new AppError('backup_repository', `Antwort von restic nicht lesbar: ${(err as Error).message}`, 502)
  }
}

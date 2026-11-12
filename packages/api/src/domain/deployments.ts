import { eq, and, desc, gt, lte, count } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { DeploymentArtifact } from '../db/schema.js'
import { notFound } from '../lib/errors.js'
import type { DeploymentDto } from '@airlock/shared'
import { withHistory, type ReasonEvent } from './deploy-reason.js'

type Row = typeof schema.deployments.$inferSelect

/** Wie ein Projekt zur Laufzeit behandelt wird (Routing, Start, Abgleich). */
/** external: Bestehender Dienst – kein Container von Airlock, kein Deploy */
export type RuntimeKind = 'image' | 'dockerfile' | 'static' | 'compose' | 'external'

/**
 * Ein Chat-Projekt (Quelle files) läuft als das, als was seine aktive
 * Fassung erkannt wurde. Alle anderen Quellen sind, was sie sind.
 */
export function effectiveKind(sourceType: string, artifact: DeploymentArtifact | null | undefined): RuntimeKind {
  if (sourceType === 'files') {
    const k = artifact?.filesKind
    if (k === 'compose') return 'compose'
    if (k === 'dockerfile') return 'dockerfile'
    return 'static'
  }
  return sourceType as RuntimeKind
}

/**
 * Auf eine Fassung lässt sich zurückrollen, wenn sie einmal erfolgreich lief
 * (superseded), gerade nicht aktiv ist und ihr Artefakt noch verzeichnet ist.
 * Ob es auf der Platte noch existiert, prüft erst der Rollback selbst.
 */
export function canRollbackTo(d: Row): boolean {
  if (d.isActive || d.status !== 'superseded') return false
  const a = d.artifact ?? {}
  return Boolean(d.imageRef || a.composeFile || a.siteVersion)
}

export function toDeploymentDto(r: Row): DeploymentDto {
  return {
    id: r.id,
    projectId: r.projectId,
    version: r.version,
    sourceRef: r.sourceRef,
    status: r.status,
    errorMessage: r.errorMessage,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    isActive: r.isActive,
    durationMs: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
    trigger: r.trigger,
    rollbackOf: r.rollbackOf,
    canRollback: canRollbackTo(r),
    reason: r.reason ?? undefined,
    actor: r.actor ?? null,
    message: r.message ?? null,
    failure: r.failure ?? null,
  }
}

/** Audit-Einträge eines Projekts im Zeitraum (after, until] für die Ableitung des Grunds. */
export async function reasonEvents(projectId: string, after: Date, until: Date): Promise<ReasonEvent[]> {
  const rows = await db
    .select({ at: schema.auditEvents.at, actor: schema.auditEvents.actor, action: schema.auditEvents.action, params: schema.auditEvents.paramsMasked })
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.targetId, projectId), gt(schema.auditEvents.at, after), lte(schema.auditEvents.at, until), eq(schema.auditEvents.result, 'ok')))
    .orderBy(desc(schema.auditEvents.at))
    .limit(2000)
  return rows.map((r) => ({ at: r.at, actor: r.actor, action: r.action, params: (r.params ?? {}) as Record<string, unknown> }))
}


export async function listDeployments(projectId: string, limit = 20): Promise<DeploymentDto[]> {
  const rows = await db
    .select()
    .from(schema.deployments)
    .where(eq(schema.deployments.projectId, projectId))
    .orderBy(desc(schema.deployments.startedAt))
    .limit(limit)
  const total = Number((await db.select({ n: count() }).from(schema.deployments).where(eq(schema.deployments.projectId, projectId)))[0]?.n ?? rows.length)
  const old = rows.filter((r) => !r.reason || !r.actor)
  const events = old.length
    ? await reasonEvents(projectId, new Date(Math.min(...old.map((r) => r.startedAt.getTime())) - 30 * 86_400_000), new Date())
    : []
  return withHistory(rows, total, events, toDeploymentDto)
}

export async function getDeployment(id: string): Promise<Row> {
  const rows = await db.select().from(schema.deployments).where(eq(schema.deployments.id, id)).limit(1)
  const row = rows[0]
  if (!row) throw notFound('Deployment')
  return row
}

export async function activeDeployment(projectId: string): Promise<Row | null> {
  const rows = await db
    .select()
    .from(schema.deployments)
    .where(and(eq(schema.deployments.projectId, projectId), eq(schema.deployments.isActive, true)))
    .limit(1)
  return rows[0] ?? null
}

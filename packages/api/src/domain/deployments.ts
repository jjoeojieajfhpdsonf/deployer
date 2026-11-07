import { eq, and, desc } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { DeploymentArtifact } from '../db/schema.js'
import { notFound } from '../lib/errors.js'
import type { DeploymentDto } from '@deployer/shared'

type Row = typeof schema.deployments.$inferSelect

/** Wie ein Projekt zur Laufzeit behandelt wird (Routing, Start, Abgleich). */
export type RuntimeKind = 'image' | 'dockerfile' | 'static' | 'compose'

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
  }
}

export async function listDeployments(projectId: string, limit = 20): Promise<DeploymentDto[]> {
  const rows = await db
    .select()
    .from(schema.deployments)
    .where(eq(schema.deployments.projectId, projectId))
    .orderBy(desc(schema.deployments.startedAt))
    .limit(limit)
  return rows.map(toDeploymentDto)
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

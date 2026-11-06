import { eq, and, desc } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { notFound } from '../lib/errors.js'
import type { DeploymentDto } from '@deployer/shared'

type Row = typeof schema.deployments.$inferSelect

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

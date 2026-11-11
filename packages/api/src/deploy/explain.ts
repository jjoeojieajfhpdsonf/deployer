import { eq } from 'drizzle-orm'
import { explainFailure, type DeploymentDto, type FailureExplanation } from '@airlock/shared'
import { db, schema } from '../db/index.js'
import { listEnvDto } from '../domain/env.js'
import { readLog } from './journal.js'

/**
 * UI-Qualität 2: Erklärung eines gescheiterten Deploys – dieselbe Funktion
 * (shared/failure.ts) für Fehlerbox, Pille, Listen und das MCP-Ergebnis.
 *
 * Festgehalten wird sie beim Scheitern (Spalte deployments.failure): mit den
 * Variablen und dem Port von *diesem* Deploy. Wer danach «Hinzufügen» oder
 * «Port ändern» drückt, ändert die Erklärung des alten Deploys nicht, und die
 * Projektliste liest keine Logs.
 */
interface ProjectFacts {
  id: string
  port: number | null
  healthcheckPath: string | null
  memoryLimitMb: number | null
  sourceType: string
  sourceConfig: unknown
}

async function explainNow(p: ProjectFacts, dep: { id: string; errorMessage: string | null }, errorCode?: string | null): Promise<FailureExplanation> {
  const env = await listEnvDto(p.id).catch(() => [])
  return explainFailure({
    message: dep.errorMessage,
    log: readLog(dep.id),
    port: p.port ?? null,
    healthcheckPath: p.healthcheckPath,
    image: (p.sourceConfig as { image?: string } | null)?.image ?? null,
    memoryLimitMb: p.memoryLimitMb,
    envKeys: env.map((e) => e.key),
    sourceType: p.sourceType,
    errorCode: errorCode ?? null,
  })
}

/** Beim Scheitern (Pipeline): erklären und am Deployment festhalten */
export async function recordFailure(p: ProjectFacts, dep: { id: string; errorMessage: string | null }, errorCode?: string | null): Promise<FailureExplanation> {
  const e = await explainNow(p, dep, errorCode)
  await db.update(schema.deployments).set({ failure: e }).where(eq(schema.deployments.id, dep.id))
  return e
}

/** Gespeicherte Erklärung, sonst jetzt erklären und nachtragen (Deployments von vor Migration 0017) */
export async function explainDeployment(p: ProjectFacts, dep: { id: string; errorMessage: string | null; failure?: FailureExplanation | null }): Promise<FailureExplanation> {
  if (dep.failure) return dep.failure
  return recordFailure(p, dep).catch(() => explainNow(p, dep))
}

/** Gescheiterte ohne gespeicherte Erklärung bekommen sie (einmalig nachgetragen); alle anderen bleiben, wie sie sind. */
export async function withFailure<D extends DeploymentDto>(p: ProjectFacts, deps: D[]): Promise<D[]> {
  if (!deps.some((d) => d.status === 'failed' && !d.failure)) return deps
  return Promise.all(deps.map(async (d) => (d.status !== 'failed' || d.failure ? d : { ...d, failure: await explainDeployment(p, d) })))
}

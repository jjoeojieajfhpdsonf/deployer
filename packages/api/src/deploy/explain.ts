import { explainFailure, type DeploymentDto, type FailureExplanation } from '@airlock/shared'
import { listEnvDto } from '../domain/env.js'
import { readLog } from './journal.js'

/**
 * UI-Qualität 2: Erklärung eines gescheiterten Deploys – dieselbe Funktion
 * (shared/failure.ts) mit denselben Angaben wie die Fehlerbox der Oberfläche:
 * Fehlermeldung, Deploy-Log, Port, Healthcheck, Image, RAM-Grenze und Namen
 * der gesetzten Variablen. Für das MCP-Ergebnis von deploy und für den Titel,
 * den Pille, Banner und Deployments-Liste zeigen.
 */
interface ProjectFacts {
  id: string
  port: number | null
  healthcheckPath: string | null
  memoryLimitMb: number | null
  sourceConfig: unknown
}

function explainWith(p: ProjectFacts, dep: { id: string; errorMessage: string | null }, envKeys: string[]): FailureExplanation {
  return explainFailure({
    message: dep.errorMessage,
    log: readLog(dep.id),
    port: p.port ?? null,
    healthcheckPath: p.healthcheckPath,
    image: (p.sourceConfig as { image?: string } | null)?.image ?? null,
    memoryLimitMb: p.memoryLimitMb,
    envKeys,
  })
}

const envKeysOf = async (projectId: string) => (await listEnvDto(projectId).catch(() => [])).map((e) => e.key)

export async function explainDeployment(p: ProjectFacts, dep: { id: string; errorMessage: string | null }): Promise<FailureExplanation> {
  return explainWith(p, dep, await envKeysOf(p.id))
}

/** Gescheiterte Deployments bekommen den Titel der Erklärung (failure); die übrigen bleiben, wie sie sind. */
export async function withFailure<D extends DeploymentDto>(p: ProjectFacts, deps: D[]): Promise<D[]> {
  if (!deps.some((d) => d.status === 'failed')) return deps
  const keys = await envKeysOf(p.id)
  return deps.map((d) => {
    if (d.status !== 'failed') return d
    const e = explainWith(p, d, keys)
    return { ...d, failure: { kind: e.kind, title: e.title } }
  })
}

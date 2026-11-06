import { eq, and, ne, desc } from 'drizzle-orm'
import { db, schema, tryLockProject } from '../db/index.js'
import { config } from '../config.js'
import * as docker from '../drivers/docker.js'
import { findProject, setStatus, setDesiredState } from '../domain/projects.js'
import { resolveEnv } from '../domain/env.js'
import { reconcileCaddy } from '../domain/routes.js'
import { audit } from '../domain/audit.js'
import { toDeploymentDto } from '../domain/deployments.js'
import { appendLine, emitStatus, emitDone, logPathFor } from './journal.js'
import { waitForHealthy } from './healthcheck.js'
import { prepareImage, startImageContainer } from './sources/image.js'
import { prepareStatic, activateStatic } from './sources/static.js'
import { conflict } from '../lib/errors.js'
import { log } from '../lib/log.js'
import type { DeploymentDto } from '@deployer/shared'

/** Wie viele Versionen pro Projekt fuer ein Rollback aufgehoben werden. */
export const KEEP_VERSIONS = 5

/**
 * Startet einen Deploy und kehrt sofort zurueck. Der Fortschritt laeuft ueber
 * SSE (deploy/journal.ts).
 *
 * Die Sperre gegen parallele Deploys ist ein Postgres Advisory Lock:
 * sitzungsweit (ein Deploy dauert Minuten und umfasst viele Transaktionen),
 * nicht blockierend (der zweite Aufruf bekommt sofort 409) und selbstheilend
 * (stirbt der Prozess, gibt Postgres den Lock frei).
 */
export async function startDeploy(
  idOrSlug: string,
  actor: string,
  ref?: string,
): Promise<DeploymentDto> {
  const project = await findProject(idOrSlug)

  const lock = await tryLockProject(project.id)
  if (!lock) {
    throw conflict('Für dieses Projekt läuft bereits ein Deploy')
  }

  let deploymentId: string
  try {
    const inserted = await db
      .insert(schema.deployments)
      .values({ projectId: project.id, sourceRef: ref ?? null, status: 'pending' })
      .returning()
    const row = inserted[0]!
    deploymentId = row.id
    await db
      .update(schema.deployments)
      .set({ logRef: logPathFor(deploymentId) })
      .where(eq(schema.deployments.id, deploymentId))

    // Bewusst nicht awaiten: die API antwortet sofort.
    void run(project.id, deploymentId, actor, ref).finally(() => void lock.release())

    return toDeploymentDto({ ...row, logRef: logPathFor(deploymentId) })
  } catch (err) {
    await lock.release()
    throw err
  }
}

async function setDeployment(
  id: string,
  values: Partial<typeof schema.deployments.$inferInsert>,
): Promise<void> {
  await db.update(schema.deployments).set(values).where(eq(schema.deployments.id, id))
}

async function run(projectId: string, deploymentId: string, actor: string, ref?: string): Promise<void> {
  const started = Date.now()
  try {
    await setStatus(projectId, 'deploying')
    const project = await findProject(projectId)
    appendLine(deploymentId, `Deploy von "${project.name}" (${project.sourceType}) gestartet`)

    if (project.sourceType === 'static') {
      await runStatic(deploymentId, project)
    } else {
      await runImage(deploymentId, project, ref)
    }

    await setDesiredState(projectId, 'running')
    await setStatus(projectId, 'running')
    await setDeployment(deploymentId, { status: 'active', isActive: true, finishedAt: new Date() })

    // Erst jetzt den Verkehr umschalten. Bis hierher lief die alte Fassung.
    await reconcileCaddy()
    appendLine(deploymentId, 'Route aktiv')

    await removeSupersededContainers(project.slug, deploymentId)
    await pruneOldDeployments(projectId)

    appendLine(deploymentId, `Fertig in ${Math.round((Date.now() - started) / 1000)} s`)
    emitDone(deploymentId, true)
    await audit({
      actor, action: 'project.deploy', targetType: 'project', targetId: projectId,
      params: { deployment: deploymentId, ref }, result: 'ok',
    })
  } catch (err) {
    const message = (err as Error).message
    appendLine(deploymentId, `FEHLGESCHLAGEN: ${message}`)
    await setDeployment(deploymentId, {
      status: 'failed', errorMessage: message, finishedAt: new Date(), isActive: false,
    })

    // Die vorherige Fassung laeuft weiter; das Projekt ist nur dann "failed",
    // wenn es ueberhaupt keine aktive Fassung mehr gibt.
    const stillActive = await db
      .select()
      .from(schema.deployments)
      .where(and(eq(schema.deployments.projectId, projectId), eq(schema.deployments.isActive, true)))
      .limit(1)
    await setStatus(projectId, stillActive.length ? 'running' : 'failed')

    await cleanupFailed(projectId, deploymentId)
    emitDone(deploymentId, false)
    log.error('Deploy fehlgeschlagen', { projectId, deploymentId, err: message })
    await audit({
      actor, action: 'project.deploy', targetType: 'project', targetId: projectId,
      params: { deployment: deploymentId, ref }, result: 'error', error: message,
    })
  }
}

/* --- Image ---------------------------------------------------------------- */

async function runImage(
  deploymentId: string,
  project: typeof schema.projects.$inferSelect,
  ref?: string,
): Promise<void> {
  emitStatus(deploymentId, 'pulling')
  const prepared = await prepareImage(project, deploymentId, ref)
  await setDeployment(deploymentId, { status: 'pulling', version: prepared.version })

  emitStatus(deploymentId, 'starting')
  const env = await resolveEnv(project.id)
  const { containerId, containerName, network } = await startImageContainer({
    project, deploymentId, image: prepared.image, env,
  })
  await setDeployment(deploymentId, { status: 'starting', containerId })

  emitStatus(deploymentId, 'healthchecking')
  const url = `http://${containerName}:${project.port}${project.healthcheckPath}`
  appendLine(deploymentId, `Healthcheck gegen ${url}`)

  // Der deployer haengt sich NUR fuer den Healthcheck ins Projekt-Netz und
  // loest sich danach wieder. Das disconnect steht im finally, damit ein
  // fehlgeschlagener Healthcheck die Verbindung nicht stehen laesst.
  let result
  try {
    await docker.connectToNetwork(network, config.DEPLOYER_CONTAINER)
    result = await waitForHealthy({
      url,
      timeoutMs: 60_000,
      onAttempt: (n, detail) => {
        if (n === 1 || n % 5 === 0 || detail.includes('bereit')) {
          appendLine(deploymentId, `Healthcheck ${n}: ${detail}`)
        }
      },
    })
  } finally {
    await docker.disconnectFromNetwork(network, config.DEPLOYER_CONTAINER)
    appendLine(deploymentId, 'deployer aus dem Projekt-Netz getrennt')
  }

  if (!result.ok) {
    const tail = await docker.getLogs(containerId, { tail: 30 }).catch(() => '')
    if (tail) appendLine(deploymentId, `Letzte Container-Ausgabe:\n${tail}`)
    await docker.stopContainer(containerId)
    await docker.removeContainer(containerId)
    throw new Error(
      `Healthcheck nach ${result.attempts} Versuchen nicht bestanden ` +
        `(${result.lastError ?? 'keine Antwort'})`,
    )
  }

  await markActiveExclusively(project.id, deploymentId)
}

/* --- Statisch -------------------------------------------------------------- */

async function runStatic(
  deploymentId: string,
  project: typeof schema.projects.$inferSelect,
): Promise<void> {
  emitStatus(deploymentId, 'pulling')
  const { version } = await prepareStatic(project, deploymentId)
  await setDeployment(deploymentId, { status: 'pulling', version })

  emitStatus(deploymentId, 'starting')
  await activateStatic(project, version, deploymentId)
  await markActiveExclusively(project.id, deploymentId)
}

/* --- Gemeinsames ----------------------------------------------------------- */

/**
 * Setzt dieses Deployment aktiv und alle anderen auf superseded – in einer
 * Transaktion, weil der partielle Unique-Index sonst zuschlaegt.
 */
async function markActiveExclusively(projectId: string, deploymentId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.deployments)
      .set({ isActive: false, status: 'superseded' })
      .where(and(
        eq(schema.deployments.projectId, projectId),
        eq(schema.deployments.isActive, true),
        ne(schema.deployments.id, deploymentId),
      ))
    await tx
      .update(schema.deployments)
      .set({ isActive: true })
      .where(eq(schema.deployments.id, deploymentId))
  })
}

/** Container alter Fassungen entfernen; die Images bleiben fuer ein Rollback. */
async function removeSupersededContainers(slug: string, keepDeploymentId: string): Promise<void> {
  const managed = await docker.listManagedContainers()
  for (const c of managed) {
    if (c.labels[docker.LABEL_PROJECT] !== slug) continue
    if (c.labels[docker.LABEL_DEPLOYMENT] === keepDeploymentId) continue
    await docker.stopContainer(c.id)
    await docker.removeContainer(c.id)
  }
}

/** Nach einem Fehlschlag: alles entfernen, was dieser Versuch angelegt hat. */
async function cleanupFailed(projectId: string, deploymentId: string): Promise<void> {
  try {
    const managed = await docker.listManagedContainers()
    for (const c of managed) {
      if (c.labels[docker.LABEL_DEPLOYMENT] === deploymentId) {
        await docker.stopContainer(c.id)
        await docker.removeContainer(c.id)
      }
    }
    const project = await findProject(projectId)
    await docker.disconnectFromNetwork(
      docker.projectNetworkName(project.slug),
      config.DEPLOYER_CONTAINER,
    )
  } catch (err) {
    log.warn('Aufräumen nach Fehlschlag unvollständig', { deploymentId, err: String(err) })
  }
}

export async function pruneOldDeployments(projectId: string): Promise<void> {
  const rows = await db
    .select({ id: schema.deployments.id, isActive: schema.deployments.isActive })
    .from(schema.deployments)
    .where(eq(schema.deployments.projectId, projectId))
    .orderBy(desc(schema.deployments.startedAt))

  const toDelete = rows.filter((r) => !r.isActive).slice(KEEP_VERSIONS)
  for (const r of toDelete) {
    await db.delete(schema.deployments).where(eq(schema.deployments.id, r.id))
  }
}

import * as docker from '../drivers/docker.js'
import { findProject, setDesiredState, setStatus, touchActivity } from './projects.js'
import { activeDeployment, effectiveKind } from './deployments.js'
import { reconcileCaddy } from './routes.js'
import { audit } from './audit.js'
import { startDeploy } from '../deploy/pipeline.js'
import type { Scope } from '../lib/scope.js'
import { log } from '../lib/log.js'
import type { DeploymentDto } from '@airlock/shared'

/**
 * Start und Stopp setzen zuerst desired_state und fuehren dann aus. Nach
 * einem Serverneustart ist damit unterscheidbar, ob ein Container gewollt
 * gestoppt oder abgestuerzt ist (siehe jobs/reconcile.ts).
 */

export async function startProject(
  scope: Scope,
  idOrSlug: string,
  actor: string,
): Promise<{ started: boolean; deployment?: DeploymentDto }> {
  const project = await findProject(scope, idOrSlug)
  await setDesiredState(project.id, 'running')
  // Ein Start von Hand ist Aktivität: sonst stoppte der Ablauf-Job ein
  // abgelaufenes Chat-Projekt in der nächsten Stunde wieder.
  await touchActivity(project.id)

  const active = await activeDeployment(project.id)
  // Chat-Projekte laufen als das, als was ihre aktive Fassung erkannt wurde.
  const kind = effectiveKind(project.sourceType, active?.artifact)

  // Statische Seiten haben keinen Container; es reicht die Route.
  if (kind === 'static') {
    if (!active) {
      const deployment = await startDeploy(scope, project.id, actor)
      return { started: true, deployment }
    }
    await setStatus(project.id, 'running')
    await reconcileCaddy()
    await audit({ actor, action: 'project.start', targetType: 'project', targetId: project.id, result: 'ok' })
    return { started: true }
  }

  // Compose: alle Dienste des Projekts wieder starten; gibt es keine mehr,
  // neu deployen.
  if (kind === 'compose') {
    const services = (await docker.listManagedContainers()).filter(
      (c) => c.labels[docker.LABEL_PROJECT] === project.slug && c.labels[docker.LABEL.composeService],
    )
    if (!active || services.length === 0) {
      const deployment = await startDeploy(scope, project.id, actor)
      return { started: true, deployment }
    }
    for (const c of services) {
      if (!c.running && docker.isPersistentComposeService(c.labels)) await docker.startContainer(c.id)
    }
    await setStatus(project.id, 'running')
    await reconcileCaddy()
    await audit({ actor, action: 'project.start', targetType: 'project', targetId: project.id, result: 'ok' })
    return { started: true }
  }

  // Kein Container mehr da (z.B. nach einem Aufräumen): neu deployen.
  const state = active?.containerId ? await docker.inspectContainer(active.containerId) : null
  if (!active || !state) {
    const deployment = await startDeploy(scope, project.id, actor)
    return { started: true, deployment }
  }

  if (!state.running) await docker.startContainer(active.containerId!)
  await setStatus(project.id, 'running')
  await reconcileCaddy()
  await audit({ actor, action: 'project.start', targetType: 'project', targetId: project.id, result: 'ok' })
  log.info('Projekt gestartet', { slug: project.slug })
  return { started: true }
}

export async function stopProject(scope: Scope, idOrSlug: string, actor: string): Promise<void> {
  const project = await findProject(scope, idOrSlug)
  await setDesiredState(project.id, 'stopped')

  const managed = await docker.listManagedContainers()
  for (const c of managed) {
    if (c.labels[docker.LABEL_PROJECT] === project.slug && c.running) {
      await docker.stopContainer(c.id)
    }
  }

  await setStatus(project.id, 'stopped')
  // Route verschwindet, statt in einen toten Upstream zu zeigen.
  await reconcileCaddy()
  await audit({ actor, action: 'project.stop', targetType: 'project', targetId: project.id, result: 'ok' })
  log.info('Projekt gestoppt', { slug: project.slug })
}

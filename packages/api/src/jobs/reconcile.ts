import { eq, and } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { config } from '../config.js'
import * as docker from '../drivers/docker.js'
import { reconcileCaddy, rehostRoutes } from '../domain/routes.js'
import { setStatus } from '../domain/projects.js'
import { effectiveKind } from '../domain/deployments.js'
import { audit } from '../domain/audit.js'
import { log } from '../lib/log.js'

/**
 * Abgleich beim Start. Deckt das NFR "Alle aktiven Projekte starten von
 * selbst wieder" ab und raeumt auf, was ein Absturz hinterlassen hat.
 */
export async function reconcileOnBoot(): Promise<void> {
  await detachDeployerFromProjectNetworks()
  await restoreDesiredState()
  // Basisdomain gesetzt oder geaendert? Dann ziehen bestehende Adressen mit.
  await rehostRoutes()
  await reconcileCaddy()
}

/**
 * Der deployer haengt sich nur fuer den Healthcheck in Projekt-Netze. Stirbt
 * der Prozess mittendrin, bleibt die Verbindung stehen - genau der Zustand,
 * in dem dieses Muster sonst leise verrottet. Hier wird er aufgeraeumt.
 */
async function detachDeployerFromProjectNetworks(): Promise<void> {
  const nets = await docker.networksOfContainer(config.DEPLOYER_CONTAINER)
  for (const net of nets) {
    if (!net.startsWith('dep_')) continue
    await docker.disconnectFromNetwork(net, config.DEPLOYER_CONTAINER)
    log.warn('Übrig gebliebene Netzverbindung des deployers gelöst', { net })
  }
}

/**
 * Container, die laufen sollen, wieder hochfahren. desired_state ist genau
 * dafuer da: ohne das Feld waere nicht unterscheidbar, ob ein gestoppter
 * Container gewollt gestoppt oder abgestuerzt ist.
 */
async function restoreDesiredState(): Promise<void> {
  const rows = await db
    .select({
      id: schema.projects.id,
      slug: schema.projects.slug,
      sourceType: schema.projects.sourceType,
      containerId: schema.deployments.containerId,
      artifact: schema.deployments.artifact,
    })
    .from(schema.projects)
    .leftJoin(
      schema.deployments,
      and(eq(schema.deployments.projectId, schema.projects.id), eq(schema.deployments.isActive, true)),
    )
    .where(eq(schema.projects.desiredState, 'running'))

  const managed = await docker.listManagedContainers()

  for (const row of rows) {
    // Chat-Projekte (files) laufen als das, als was sie erkannt wurden.
    const kind = effectiveKind(row.sourceType, row.artifact)
    if (kind === 'static') {
      await setStatus(row.id, 'running')
      continue
    }
    if (kind === 'compose') {
      // Compose-Dienste haben keine einzelne Container-ID im Deployment.
      const services = managed.filter(
        (c) => c.labels[docker.LABEL_PROJECT] === row.slug && c.labels['deployer.compose-service'],
      )
      if (services.length === 0) {
        await setStatus(row.id, 'failed')
        log.warn('Compose-Projekt soll laufen, hat aber keine Dienste mehr', { slug: row.slug })
        continue
      }
      for (const c of services) {
        if (!c.running && docker.isPersistentComposeService(c.labels)) await docker.startContainer(c.id)
      }
      await setStatus(row.id, 'running')
      continue
    }
    if (!row.containerId) {
      await setStatus(row.id, 'failed')
      log.warn('Projekt soll laufen, hat aber kein aktives Deployment', { slug: row.slug })
      continue
    }
    const state = await docker.inspectContainer(row.containerId)
    if (!state) {
      await setStatus(row.id, 'failed')
      log.warn('Container des aktiven Deployments fehlt, neuer Deploy nötig', { slug: row.slug })
      await audit({
        actor: 'system', action: 'reconcile.container_missing', targetType: 'project',
        targetId: row.id, result: 'error', error: 'Container nicht mehr vorhanden',
      })
      continue
    }
    if (!state.running) {
      await docker.startContainer(row.containerId)
      log.info('Projekt nach Neustart wieder gestartet', { slug: row.slug })
    }
    await setStatus(row.id, 'running')
  }
}

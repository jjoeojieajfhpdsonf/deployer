import { db, schema } from '../db/index.js'
import { config } from '../config.js'
import * as docker from '../drivers/docker.js'
import { pruneOldDeployments } from '../deploy/pipeline.js'
import { log } from '../lib/log.js'

const EVERY_MS = 6 * 60 * 60 * 1000

/**
 * Raeumt auf, was Deploys und Abbrueche hinterlassen: alte Deployment-Zeilen,
 * verwaiste Container und Netze.
 */
export async function runCleanup(): Promise<void> {
  const projects = await db
    .select({ id: schema.projects.id, slug: schema.projects.slug })
    .from(schema.projects)
  const knownSlugs = new Set(projects.map((p) => p.slug))

  for (const p of projects) await pruneOldDeployments(p.id)

  // Container ohne Projekt
  const managed = await docker.listManagedContainers()
  for (const c of managed) {
    const slug = c.labels[docker.LABEL_PROJECT]
    if (slug && !knownSlugs.has(slug)) {
      await docker.stopContainer(c.id)
      await docker.removeContainer(c.id)
      log.info('Verwaisten Container entfernt', { slug, id: c.id.slice(0, 12) })
    }
  }

  // Netze ohne Projekt
  const nets = await docker.docker.listNetworks()
  for (const n of nets) {
    const name = n.Name
    if (!name?.startsWith('dep_')) continue
    if (knownSlugs.has(name.slice('dep_'.length))) continue
    await docker.disconnectFromNetwork(name, config.CADDY_CONTAINER)
    await docker.disconnectFromNetwork(name, config.DEPLOYER_CONTAINER)
    await docker.removeNetwork(name)
    log.info('Verwaistes Netz entfernt', { name })
  }
}

export function startCleanupJob(): NodeJS.Timeout {
  const timer = setInterval(() => {
    runCleanup().catch((err) => log.error('Aufräumen fehlgeschlagen', { err: String(err) }))
  }, EVERY_MS)
  timer.unref()
  return timer
}

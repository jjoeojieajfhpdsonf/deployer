import { db, schema } from '../db/index.js'
import { config } from '../config.js'
import * as docker from '../drivers/docker.js'
import { pruneOldDeployments } from '../deploy/pipeline.js'
import { log } from '../lib/log.js'
import { RESERVED_SLUGS } from '@airlock/shared'
import { isProjectScoped, isLegacyName, PROJECT_PREFIX, LEGACY_PROJECT_PREFIX } from '../lib/names.js'

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

  // Netze ohne Projekt. Übergang: Netze aus der deployer-Zeit (dep_<slug>)
  // auch dann, wenn das Projekt schon unter air_<slug> läuft.
  const legacy = docker.legacySnapshot()
  const nets = await docker.docker.listNetworks()
  for (const n of nets) {
    const name = n.Name
    if (!name || !isProjectScoped(name)) continue
    const old = isLegacyName(name)
    const slug = name.slice((old ? LEGACY_PROJECT_PREFIX : PROJECT_PREFIX).length)
    // Reservierte Namen sind keine Projekte, etwa air_ext-scan für externe
    // Scans (Review M6). Das alte dep_ext-scan darf weg.
    if (!old && (RESERVED_SLUGS as readonly string[]).includes(slug)) continue
    if (knownSlugs.has(slug) && (!old || legacy.slugs.has(slug))) continue
    try {
      await docker.disconnectFromNetwork(name, config.CADDY_CONTAINER)
      await docker.disconnectFromNetwork(name, config.AIRLOCK_CONTAINER)
      await docker.removeNetwork(name)
      log.info('Verwaistes Netz entfernt', { name })
    } catch (err) {
      // Ein Netz mit aktiven Teilnehmern bleibt; die übrigen trotzdem aufräumen.
      log.warn('Verwaistes Netz nicht entfernt', { name, err: String(err) })
    }
  }
}

export function startCleanupJob(): NodeJS.Timeout {
  const timer = setInterval(() => {
    runCleanup().catch((err) => log.error('Aufräumen fehlgeschlagen', { err: String(err) }))
  }, EVERY_MS)
  timer.unref()
  return timer
}

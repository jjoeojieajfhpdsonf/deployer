import * as docker from '../../drivers/docker.js'
import { appendLine } from '../journal.js'
import { projectHomebentoLabels } from '../../domain/homebento.js'
import { badRequest } from '../../lib/errors.js'
import type { schema } from '../../db/index.js'

type Project = typeof schema.projects.$inferSelect

export interface PreparedImage {
  image: string
  version: string
  runsAsRoot: boolean
}

/** Zieht das Image und haelt den Digest als Version fest. */
export async function prepareImage(
  project: Project,
  deploymentId: string,
  ref?: string,
): Promise<PreparedImage> {
  const cfg = project.sourceConfig as { image?: string }
  const base = cfg.image
  if (!base) throw badRequest('Dem Projekt fehlt eine Image-Referenz')

  // Ein uebergebener ref ersetzt den Tag: "1.3" oder ":1.3" oder voller Name.
  let image = base
  if (ref) {
    image = ref.includes('/') || ref.includes('@')
      ? ref
      : `${base.split('@')[0]!.replace(/:[^:/]+$/, '')}:${ref.replace(/^:/, '')}`
  }

  appendLine(deploymentId, `Image wird geholt: ${image}`)
  let lastProgress = ''
  await docker.pullImage(image, (line) => {
    // Fortschrittszeilen sind sehr gespraechig; nur Statuswechsel mitschreiben.
    const status = line.split(' ').slice(1, 3).join(' ')
    if (status !== lastProgress) {
      lastProgress = status
      appendLine(deploymentId, line)
    }
  })

  const info = await docker.inspectImage(image)
  const runsAsRoot = docker.runsAsRoot(info.user)
  appendLine(deploymentId, `Version: ${info.digest}`)
  if (runsAsRoot) {
    appendLine(deploymentId, 'Hinweis: Das Image läuft als root. Erlaubt, aber vermeidbar.')
  }
  return { image, version: info.digest, runsAsRoot }
}

/** Legt den Container an und startet ihn. Geht durch die Richtlinienprüfung. */
export async function startImageContainer(opts: {
  project: Project
  deploymentId: string
  image: string
  env: Record<string, string>
}): Promise<{ containerId: string; containerName: string; network: string }> {
  const { project, deploymentId, image, env } = opts
  const network = docker.projectNetworkName(project.slug)
  const name = docker.containerName(project.slug, deploymentId)

  await docker.ensureNetwork(network)
  appendLine(deploymentId, `Netz bereit: ${network}`)

  const containerId = await docker.createAndStart({
    name,
    image,
    network,
    env,
    labels: {
      // Abgrenzung HomeBento: Name, Hauptadresse, Icon (falls bekannt)
      ...(await projectHomebentoLabels(project, image)),
      [docker.LABEL_MANAGED]: 'true',
      [docker.LABEL_PROJECT]: project.slug,
      [docker.LABEL_DEPLOYMENT]: deploymentId,
    },
    memoryLimitMb: project.memoryLimitMb,
    cpuLimit: Number(project.cpuLimit),
  })

  appendLine(deploymentId, `Container gestartet: ${name}`)
  return { containerId, containerName: name, network }
}

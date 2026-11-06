import { relative } from 'node:path'
import * as docker from '../../drivers/docker.js'
import { resolveInRepo } from '../../lib/repo-files.js'
import { badRequest } from '../../lib/errors.js'
import { appendLine } from '../journal.js'
import { packDir } from '../workdir.js'
import { cloneForDeployment } from './repo.js'
import type { schema } from '../../db/index.js'

type Project = typeof schema.projects.$inferSelect

/** Grenzen für Builds: grosszügiger als zur Laufzeit, aber begrenzt. */
export const BUILD_MEMORY_MB = 2048
export const BUILD_TIMEOUT_MS = 10 * 60_000

export function builtTag(slug: string, deploymentId: string): string {
  return `deployer/${slug}:${deploymentId.replace(/-/g, '').slice(0, 12)}`
}

/**
 * Clone, Prüfung der Pfade, Build. Ergebnis ist ein lokaler Tag, der ab hier
 * wie ein fertiges Image behandelt wird.
 */
export async function buildFromRepo(
  project: Project,
  deploymentId: string,
  ref?: string,
): Promise<{ imageTag: string; commit: string }> {
  const cfg = project.sourceConfig as { repoUrl?: string; ref?: string; dockerfile?: string; context?: string }
  if (!cfg.repoUrl) throw badRequest('Dem Projekt fehlt die Repo-URL')

  const { dir, commit } = await cloneForDeployment(deploymentId, cfg.repoUrl, ref ?? cfg.ref)

  // Kontext und Dockerfile müssen nach dem Auflösen im Repo liegen.
  const context = await resolveInRepo(dir, cfg.context ?? '.')
  const dockerfileAbs = await resolveInRepo(dir, joinRel(cfg.context ?? '.', cfg.dockerfile ?? 'Dockerfile'))
  const dockerfileInContext = relative(context, dockerfileAbs)
  if (dockerfileInContext.startsWith('..')) {
    throw badRequest('Das Dockerfile muss innerhalb des Build-Kontexts liegen')
  }

  const tag = builtTag(project.slug, deploymentId)
  appendLine(deploymentId, `Build startet (${cfg.dockerfile ?? 'Dockerfile'}, Kontext ${cfg.context ?? '.'})`)
  await docker.buildImage(await packDir(context, { dockerignore: true, alwaysInclude: [dockerfileInContext] }), {
    tag,
    dockerfile: dockerfileInContext,
    labels: {
      [docker.LABEL_MANAGED]: 'true',
      [docker.LABEL_PROJECT]: project.slug,
      [docker.LABEL_DEPLOYMENT]: deploymentId,
    },
    memoryMb: BUILD_MEMORY_MB,
    timeoutMs: BUILD_TIMEOUT_MS,
    onLine: (l) => appendLine(deploymentId, l),
  })
  appendLine(deploymentId, `Image gebaut: ${tag}`)
  return { imageTag: tag, commit }
}

function joinRel(a: string, b: string): string {
  return a === '.' || a === '' ? b : `${a.replace(/\/+$/, '')}/${b}`
}

import { join } from 'node:path'
import { cloneRepo } from '../../lib/git.js'
import { repoUrlPolicy } from '../../domain/git-policy.js'
import { gitAuthFor } from '../../domain/git-access.js'
import { freshWorkDir } from '../workdir.js'
import { appendLine } from '../journal.js'
import { badRequest } from '../../lib/errors.js'
import type { schema } from '../../db/index.js'

type Project = typeof schema.projects.$inferSelect

/**
 * Klont das Repo einer Fassung in deren Arbeitsordner.
 *
 * Nacht 3, Etappe 2: mit dem Zugang des Projekts (GitHub-App-Token nur
 * lesend, Deploy-Key, Token) – ins Log kommt nur, welcher Weg, nie ein
 * Geheimnis. Nach dem Clone steht kein origin mehr in .git/config.
 */
export async function cloneForDeployment(
  project: Project,
  deploymentId: string,
  ref: string | undefined,
): Promise<{ dir: string; commit: string }> {
  const repoUrl = (project.sourceConfig as { repoUrl?: string } | null)?.repoUrl
  if (!repoUrl) throw badRequest('Dem Projekt fehlt die Repo-URL')
  const work = await freshWorkDir(deploymentId)
  const dir = join(work, 'repo')
  appendLine(deploymentId, `Repo wird geholt${ref ? ` (${ref})` : ''}`)
  const access = await gitAuthFor(project)
  if (access.note) appendLine(deploymentId, access.note)
  const r = await cloneRepo({
    url: repoUrl,
    ref,
    dest: dir,
    policy: await repoUrlPolicy(),
    auth: access.auth,
    onLine: (l) => {
      // Fortschrittszeilen von git sind gesprächig; nur die Kernaussagen.
      if (/^(Cloning|Receiving|Resolving|remote: Total|warning|fatal)/i.test(l)) appendLine(deploymentId, l)
    },
  })
  appendLine(deploymentId, `Commit ${r.commit} von ${r.displayUrl}`)
  return { dir, commit: r.commit }
}

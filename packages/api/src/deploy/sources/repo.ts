import { join } from 'node:path'
import { cloneRepo } from '../../lib/git.js'
import { repoUrlPolicy } from '../../domain/git-policy.js'
import { freshWorkDir } from '../workdir.js'
import { appendLine } from '../journal.js'

/** Klont das Repo einer Fassung in deren Arbeitsordner. */
export async function cloneForDeployment(
  deploymentId: string,
  repoUrl: string,
  ref: string | undefined,
): Promise<{ dir: string; commit: string }> {
  const work = await freshWorkDir(deploymentId)
  const dir = join(work, 'repo')
  appendLine(deploymentId, `Repo wird geholt${ref ? ` (${ref})` : ''}`)
  const r = await cloneRepo({
    url: repoUrl,
    ref,
    dest: dir,
    policy: await repoUrlPolicy(),
    onLine: (l) => {
      // Fortschrittszeilen von git sind gesprächig; nur die Kernaussagen.
      if (/^(Cloning|Receiving|Resolving|remote: Total|warning|fatal)/i.test(l)) appendLine(deploymentId, l)
    },
  })
  appendLine(deploymentId, `Commit ${r.commit} von ${r.displayUrl}`)
  return { dir, commit: r.commit }
}

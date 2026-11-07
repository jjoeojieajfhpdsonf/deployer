import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { config } from '../../config.js'
import { archiveTar, detectKind, headCommit, listFiles, type FilesKind } from '../../lib/local-repo.js'
import { extractTarSafely } from '../../lib/untar.js'
import { badRequest } from '../../lib/errors.js'
import { appendLine } from '../journal.js'
import { freshWorkDir } from '../workdir.js'
import type { schema } from '../../db/index.js'

type Project = typeof schema.projects.$inferSelect

export const localRepoPath = (slug: string) => join(config.DATA_DIR, 'repos', slug)

export interface FilesConfig {
  type: 'files'
  webService?: string
  outputDir?: string
  buildCommand?: string
}

/**
 * Holt einen Stand des lokalen Repos in den Arbeitsordner und erkennt die
 * Art. Auch der eigene Repo-Inhalt geht durch die sichere Tar-Strecke.
 * Die Art wird bei jedem Deploy neu erkannt: ein Chat-Projekt, das mit HTML
 * beginnt und später ein Dockerfile bekommt, wird ab dann gebaut.
 */
export async function checkoutFiles(
  project: Project,
  deploymentId: string,
  ref?: string,
): Promise<{ dir: string; commit: string; kind: FilesKind; composePath?: string }> {
  const repo = project.localRepoPath ?? localRepoPath(project.slug)
  const commit = ref ?? (await headCommit(repo))
  if (!commit) throw badRequest('Das Projekt hat noch keine Dateien')
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw badRequest('Ref muss ein Commit-Hash sein')

  const work = await freshWorkDir(deploymentId)
  const dir = join(work, 'repo')
  await extractTarSafely(archiveTar(repo, commit), dir)

  const paths = (await listFiles(repo, commit)).map((f) => f.path)
  const pkg = paths.includes('package.json') ? await readFile(join(dir, 'package.json'), 'utf8').catch(() => null) : null
  const { kind, composePath } = detectKind(paths, pkg)
  appendLine(deploymentId, `Commit ${commit.slice(0, 12)}, erkannt als ${KIND_LABEL[kind]}`)
  return { dir, commit, kind, composePath }
}

export const KIND_LABEL: Record<FilesKind, string> = {
  compose: 'Docker Compose',
  dockerfile: 'Dockerfile',
  'static-build': 'statische Seite mit Build',
  static: 'statische Seite',
}

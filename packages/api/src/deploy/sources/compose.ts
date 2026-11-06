import { eq } from 'drizzle-orm'
import { join, posix } from 'node:path'
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises'
import { db, schema } from '../../db/index.js'
import { config } from '../../config.js'
import { normalizeCompose, withServiceEnv, type NormalizedCompose } from '../../lib/compose.js'
import { readRepoFile, resolveInRepo } from '../../lib/repo-files.js'
import { resolveEnv } from '../../domain/env.js'
import { badRequest } from '../../lib/errors.js'
import * as docker from '../../drivers/docker.js'
import { appendLine } from '../journal.js'
import { ensureArtifactDir } from '../workdir.js'
import { cloneForDeployment } from './repo.js'

type Project = typeof schema.projects.$inferSelect

export const COMPOSE_MAX_BYTES = 256 * 1024

export const composeUploadPath = (uploadId: string) => join(config.DATA_DIR, 'uploads', `${uploadId}.yaml`)

interface ComposeConfig {
  repoUrl?: string
  ref?: string
  composePath?: string
  uploadId?: string
  webService: string
}

/**
 * Holt die compose.yaml (Repo oder Upload), prüft und normalisiert sie und
 * legt die normalisierte Datei als Artefakt dieser Fassung ab. Die CLI sieht
 * nur diese Datei.
 */
export async function prepareCompose(
  project: Project,
  deploymentId: string,
  ref?: string,
): Promise<{ file: string; normalized: NormalizedCompose; version: string }> {
  const cfg = project.sourceConfig as ComposeConfig
  let text: string
  let version: string
  let repo: Parameters<typeof normalizeCompose>[1]['repo'] = null

  if (cfg.repoUrl) {
    const { dir, commit } = await cloneForDeployment(deploymentId, cfg.repoUrl, ref ?? cfg.ref)
    const composePath = cfg.composePath ?? 'compose.yaml'
    text = await readRepoFile(dir, composePath, COMPOSE_MAX_BYTES)
    version = commit
    // Compose löst build und env_file relativ zum Ordner der Datei auf.
    const base = posix.dirname(composePath)
    const rel = (p: string) => posix.normalize(base === '.' ? p : `${base}/${p}`)
    repo = {
      resolvePath: (p) => resolveInRepo(dir, rel(p)),
      readFile: (p) => readRepoFile(dir, rel(p), 64 * 1024),
    }
  } else if (cfg.uploadId) {
    const rows = await db.select().from(schema.uploads).where(eq(schema.uploads.id, cfg.uploadId)).limit(1)
    const upload = rows[0]
    if (!upload || upload.kind !== 'compose') throw badRequest('Die hochgeladene compose.yaml wurde nicht gefunden')
    const path = composeUploadPath(upload.id)
    const st = await stat(path).catch(() => null)
    if (!st) throw badRequest('Die hochgeladene compose.yaml liegt nicht mehr auf der Platte')
    if (st.size > COMPOSE_MAX_BYTES) throw badRequest('compose.yaml ist zu gross')
    text = await readFile(path, 'utf8')
    version = upload.sha256.slice(0, 16)
  } else {
    throw badRequest('Compose braucht ein Repo oder eine hochgeladene compose.yaml')
  }

  appendLine(deploymentId, 'compose.yaml wird geprüft')
  const normalized = await normalizeCompose(text, {
    slug: project.slug,
    deploymentId,
    deploymentShort: deploymentId.replace(/-/g, '').slice(0, 12),
    webService: cfg.webService,
    network: docker.projectNetworkName(project.slug),
    memoryLimitMb: project.memoryLimitMb,
    cpuLimit: Number(project.cpuLimit),
    // Bewusst leer: das Artefakt bleibt ohne Secrets. Siehe materialize().
    projectEnv: {},
    repo,
  })
  appendLine(deploymentId, `Geprüft: ${normalized.services.length} Dienste (${normalized.services.join(', ')})`)

  const dir = await ensureArtifactDir(deploymentId)
  const file = join(dir, 'compose.yaml')
  await writeFile(file, normalized.yaml, { mode: 0o600 })
  return { file, normalized, version }
}

/**
 * Datei für genau einen `compose up`: Artefakt plus aktuelle Projekt-Env im
 * Web-Dienst. Liegt im Arbeitsordner (0600) und wird danach gelöscht.
 */
export async function materialize(
  project: Project,
  artifactFile: string,
  webService: string,
  workDirPath: string,
): Promise<string> {
  const text = await readFile(artifactFile, 'utf8')
  const withEnv = withServiceEnv(text, webService, await resolveEnv(project.id))
  await mkdir(workDirPath, { recursive: true })
  const path = join(workDirPath, 'compose.run.yaml')
  await writeFile(path, withEnv, { mode: 0o600 })
  return path
}

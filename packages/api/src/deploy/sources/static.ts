import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { mkdir, rm, rename, symlink, readdir, stat, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { db, schema } from '../../db/index.js'
import { config } from '../../config.js'
import { extractZipSafely } from '../../lib/unzip.js'
import { appendLine } from '../journal.js'
import { badRequest } from '../../lib/errors.js'
import { createHash } from 'node:crypto'
import { extractTarSafely } from '../../lib/untar.js'
import { resolveInRepo } from '../../lib/repo-files.js'
import { resolvePublicEnv } from '../../domain/env.js'
import { runStaticBuild } from '../build-container.js'
import { packDir } from '../workdir.js'
import { cloneForDeployment } from './repo.js'

type Project = typeof schema.projects.$inferSelect

/** Wie viele entpackte Fassungen pro Projekt liegen bleiben. */
const KEEP_VERSION_DIRS = 5

export function siteDir(slug: string): string {
  return join(config.SITES_DIR, slug)
}

export function uploadPath(uploadId: string): string {
  return join(config.DATA_DIR, 'uploads', `${uploadId}.zip`)
}

/**
 * Entpackt das hochgeladene ZIP in einen Versionsordner.
 *
 * Entpackt wird in einen temporaeren Ordner; erst nach vollstaendig
 * bestandener Pruefung wird er an seinen Platz verschoben. Ein abgebrochener
 * Upload hinterlaesst damit keine halbe Seite.
 */
export async function prepareStatic(
  project: Project,
  deploymentId: string,
  ref?: string,
): Promise<{ version: string }> {
  const cfg = project.sourceConfig as StaticConfig
  if (cfg.repoUrl) return prepareStaticFromRepo(project, deploymentId, cfg, ref)
  if (!cfg.uploadId) throw badRequest('Dem Projekt fehlt ein Upload')

  const rows = await db.select().from(schema.uploads).where(eq(schema.uploads.id, cfg.uploadId)).limit(1)
  const upload = rows[0]
  if (!upload) throw badRequest('Der Upload wurde nicht gefunden')

  const zipPath = uploadPath(upload.id)
  if (!existsSync(zipPath)) throw badRequest('Die hochgeladene Datei liegt nicht mehr auf der Platte')

  const version = upload.sha256.slice(0, 16)
  const finalDir = join(siteDir(project.slug), version)

  if (existsSync(finalDir)) {
    appendLine(deploymentId, `Fassung ${version} liegt schon entpackt bereit`)
    return { version }
  }

  const tmpDir = join(siteDir(project.slug), `.tmp-${deploymentId}`)
  await rm(tmpDir, { recursive: true, force: true })
  await mkdir(siteDir(project.slug), { recursive: true })

  appendLine(deploymentId, `Archiv wird geprüft und entpackt (${upload.filename})`)
  try {
    const res = await extractZipSafely(zipPath, tmpDir)
    appendLine(deploymentId, `${res.files} Einträge, ${Math.round(res.bytes / 1024)} KiB entpackt`)
    await rename(tmpDir, finalDir)
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true })
    throw err
  }

  await db
    .update(schema.uploads)
    .set({ consumedAt: new Date() })
    .where(eq(schema.uploads.id, upload.id))

  return { version }
}

/**
 * Gleicher Commit, gleicher Build, gleiche Env ergibt dieselbe Fassung –
 * dann wird der fertige Ordner wiederverwendet. Die Env gehört dazu, weil
 * Build-Werkzeuge sie ins Bundle backen (z.B. VITE_API_URL). Ohne Build
 * spielt sie keine Rolle.
 */
export function staticVersionHash(o: {
  commit: string
  buildCommand?: string
  outputDir: string
  env: Record<string, string>
}): string {
  const envPart = o.buildCommand
    ? Object.keys(o.env).sort().map((k) => `${k}=${o.env[k]}`).join('\0')
    : ''
  return createHash('sha256')
    .update(`${o.commit}\0${o.buildCommand ?? ''}\0${o.outputDir}\0${envPart}`)
    .digest('hex')
    .slice(0, 16)
}

interface StaticConfig {
  uploadId?: string
  repoUrl?: string
  ref?: string
  buildCommand?: string
  outputDir?: string
}

/**
 * M2: statische Seite aus einem Repo, mit oder ohne Build. Ohne Build wird
 * der Ausgabeordner direkt übernommen – ebenfalls über die sichere
 * Tar-Strecke, damit kein Symlink und kein .git mitkommt.
 */
async function prepareStaticFromRepo(
  project: Project,
  deploymentId: string,
  cfg: StaticConfig,
  ref?: string,
): Promise<{ version: string }> {
  const { dir, commit } = await cloneForDeployment(project, deploymentId, ref ?? cfg.ref)
  return prepareStaticFromDir(project, deploymentId, dir, commit, cfg)
}

/**
 * Statische Seite aus einem bereits vorliegenden Ordner (Clone oder lokales
 * Repo eines Chat-Projekts, M3).
 */
export async function prepareStaticFromDir(
  project: Project,
  deploymentId: string,
  dir: string,
  commit: string,
  cfg: { buildCommand?: string; outputDir?: string },
): Promise<{ version: string }> {
  const outputDir = cfg.outputDir ?? (cfg.buildCommand ? 'dist' : '.')
  const env = cfg.buildCommand ? await resolvePublicEnv(project.id) : {}
  const version = staticVersionHash({ commit, buildCommand: cfg.buildCommand, outputDir, env })
  const finalDir = join(siteDir(project.slug), version)
  if (existsSync(finalDir)) {
    appendLine(deploymentId, `Fassung ${version} (Commit ${commit.slice(0, 12)}) liegt schon bereit`)
    return { version }
  }

  const tmpDir = join(siteDir(project.slug), `.tmp-${deploymentId}`)
  await rm(tmpDir, { recursive: true, force: true })
  await mkdir(siteDir(project.slug), { recursive: true })
  try {
    if (cfg.buildCommand) {
      await runStaticBuild({
        slug: project.slug,
        deploymentId,
        repoDir: dir,
        buildCommand: cfg.buildCommand,
        outputDir,
        env,
        destDir: tmpDir,
      })
    } else {
      const src = await resolveInRepo(dir, outputDir)
      const res = await extractTarSafely(await packDir(src), tmpDir)
      appendLine(deploymentId, `${res.files} Dateien übernommen`)
    }
    await rename(tmpDir, finalDir)
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true })
    throw err
  }
  return { version }
}

/**
 * Haengt den Symlink "current" auf die neue Fassung um. Das ist das
 * Umschalten: ein rename ist atomar, es gibt keinen Moment ohne Seite.
 */
export async function activateStatic(
  project: Project,
  version: string,
  deploymentId: string,
): Promise<void> {
  const base = siteDir(project.slug)
  const link = join(base, 'current')
  const tmpLink = join(base, `.current-${deploymentId}`)

  await rm(tmpLink, { force: true })
  await symlink(version, tmpLink)
  await rename(tmpLink, link)
  appendLine(deploymentId, `current zeigt jetzt auf ${version}`)

  await pruneVersionDirs(project.id, project.slug, version)
}

/**
 * Löscht Versionsordner jenseits der letzten KEEP_VERSION_DIRS – aber nie
 * einen, auf den noch ein Deployment-Eintrag verweist: der ist ein
 * mögliches Rollback-Ziel.
 */
async function pruneVersionDirs(projectId: string, slug: string, keepVersion: string): Promise<void> {
  const referenced = new Set<string>()
  const rows = await db
    .select({ version: schema.deployments.version, artifact: schema.deployments.artifact })
    .from(schema.deployments)
    .where(eq(schema.deployments.projectId, projectId))
  for (const r of rows) {
    const v = r.artifact?.siteVersion ?? r.version
    if (v) referenced.add(v)
  }

  const base = siteDir(slug)
  let entries: string[]
  try {
    entries = await readdir(base)
  } catch {
    return
  }

  const dirs: { name: string; mtime: number }[] = []
  for (const name of entries) {
    if (name === 'current' || name.startsWith('.')) continue
    const full = join(base, name)
    const st = await lstat(full).catch(() => null)
    if (!st?.isDirectory()) continue
    const s = await stat(full)
    dirs.push({ name, mtime: s.mtimeMs })
  }

  dirs.sort((a, b) => b.mtime - a.mtime)
  for (const d of dirs.slice(KEEP_VERSION_DIRS)) {
    if (d.name === keepVersion || referenced.has(d.name)) continue
    await rm(join(base, d.name), { recursive: true, force: true })
  }
}

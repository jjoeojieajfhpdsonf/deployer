import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { mkdir, rm, rename, symlink, readdir, stat, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { db, schema } from '../../db/index.js'
import { config } from '../../config.js'
import { extractZipSafely } from '../../lib/unzip.js'
import { appendLine } from '../journal.js'
import { badRequest } from '../../lib/errors.js'

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
): Promise<{ version: string }> {
  const cfg = project.sourceConfig as { uploadId?: string }
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

  await pruneVersionDirs(project.slug, version)
}

async function pruneVersionDirs(slug: string, keepVersion: string): Promise<void> {
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
    if (d.name === keepVersion) continue
    await rm(join(base, d.name), { recursive: true, force: true })
  }
}

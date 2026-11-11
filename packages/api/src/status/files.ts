import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  renderStatusFeed, renderStatusPage, STATUS_CSS, STATUS_FILES, STATUS_JS,
  type PublicStatusIncident, type PublicStatusJson,
} from '@airlock/shared'

/**
 * Etappe 5: Dateien der Statusseite einer Umgebung in STATUS_DIR/<ordner>/.
 * Jede Datei erst unter einem Zwischennamen, dann umbenannt: der Container
 * airlock-status liefert nie eine halb geschriebene Datei aus. Rechte 0644
 * (Ordner 0755): der Container liest als «nobody».
 */
export function statusFiles(data: PublicStatusJson, feedIncidents: readonly PublicStatusIncident[], siteUrl: string): Record<string, string> {
  return {
    [STATUS_FILES.page]: renderStatusPage(data),
    [STATUS_FILES.json]: `${JSON.stringify(data, null, 2)}\n`,
    [STATUS_FILES.feed]: renderStatusFeed(data, feedIncidents, siteUrl),
    [STATUS_FILES.css]: STATUS_CSS,
    [STATUS_FILES.js]: STATUS_JS,
  }
}

const safeDir = (dir: string) => {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(dir)) throw new Error(`Ungültiger Ordner der Statusseite: ${dir}`)
  return dir
}

export async function writeStatusDir(root: string, dir: string, files: Record<string, string>): Promise<void> {
  const target = join(root, safeDir(dir))
  await mkdir(target, { recursive: true, mode: 0o755 })
  for (const [name, content] of Object.entries(files)) {
    const tmp = join(target, `.${name}.tmp`)
    await writeFile(tmp, content, { mode: 0o644 })
    await rename(tmp, join(target, name))
  }
}

export async function removeStatusDir(root: string, dir: string): Promise<void> {
  await rm(join(root, safeDir(dir)), { recursive: true, force: true })
}

import type { BackupRestorePartDto } from '@airlock/shared'
import { SOURCE_DIRS, STAGING_VOLUMES_DIR } from './restic.js'

/**
 * Meilenstein Backup, Etappe 5: was ein Stand von einem Projekt enthält –
 * reine Logik (Argumente für restic, Auswerten von «restic ls --json»),
 * ohne Docker und Datenbank. Die Ausführung steht in backup/restore.ts.
 *
 * Zu einem Projekt gehören im Stand:
 *   /staging/volumes/<slug>/<volume>/…   Compose-Volumes (Kopie beim Sichern)
 *   /source/sites/<slug>/…               statische Seite (alle entpackten Fassungen)
 *   /source/data/repos/<slug>/…          lokales Repository (Chat-Projekte)
 */

export const SNAPSHOT_RE = /^[0-9a-f]{8,64}$/
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

/** Wurzel des zurückgeholten Stands im Staging (feste Angabe in backup/runner.sh) */
export const RESTORE_DIR = '/staging/restore'

export function projectPaths(slug: string): { volumes: string; site: string; repo: string } {
  if (!SLUG_RE.test(slug)) throw new Error(`Ungültiger Projekt-Slug: ${slug}`)
  return {
    volumes: `${STAGING_VOLUMES_DIR}/${slug}`,
    site: `${SOURCE_DIRS.sites}/${slug}`,
    repo: `${SOURCE_DIRS.data}/repos/${slug}`,
  }
}

/** «restic ls» der Teile eines Projekts in einem Stand (rekursiv, als JSON) */
export function lsArgs(snapshotId: string, slug: string): string[] {
  if (!SNAPSHOT_RE.test(snapshotId)) throw new Error(`Ungültige Kennung eines Stands: ${snapshotId}`)
  const p = projectPaths(slug)
  return ['ls', '--json', '--recursive', snapshotId, p.volumes, p.site, p.repo]
}

/** Wo der Ausführer die Teile hinlegt: unter RESTORE_DIR mit vollem Pfad aus dem Stand */
export function restoredPath(path: string): string {
  return `${RESTORE_DIR}${path}`
}

export interface LsResult {
  parts: BackupRestorePartDto[]
  /** Die Ausgabe war länger als gelesen: Zahlen sind Untergrenzen */
  truncated: boolean
}

/**
 * Ausgabe von «restic ls --json --recursive» auswerten: je Teil (Volume,
 * Seite, Repository) Zahl der Dateien und Bytes. Ein leerer Ordner zählt als
 * Teil mit 0 Dateien.
 */
export function parseLs(lines: string[], slug: string): LsResult {
  const p = projectPaths(slug)
  const parts = new Map<string, BackupRestorePartDto>()
  let sawSnapshot = false
  const add = (key: string, kind: BackupRestorePartDto['kind'], name: string, file: boolean, size: number) => {
    const part = parts.get(key) ?? { kind, name, files: 0, bytes: 0 }
    if (file) {
      part.files++
      part.bytes += size
    }
    parts.set(key, part)
  }
  for (const raw of lines) {
    const l = raw.trim()
    if (!l.startsWith('{')) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(l) as Record<string, unknown>
    } catch {
      continue
    }
    const type = o.message_type ?? o.struct_type
    if (type === 'snapshot') {
      sawSnapshot = true
      continue
    }
    if (type !== 'node' || typeof o.path !== 'string') continue
    const path = o.path
    const file = o.type === 'file'
    const size = typeof o.size === 'number' && Number.isFinite(o.size) ? o.size : 0
    if (path.startsWith(`${p.volumes}/`)) {
      const vol = path.slice(p.volumes.length + 1).split('/')[0]!
      if (vol) add(`volume:${vol}`, 'volume', vol, file, size)
    } else if (path === p.site || path.startsWith(`${p.site}/`)) {
      add('site', 'site', slug, file, size)
    } else if (path === p.repo || path.startsWith(`${p.repo}/`)) {
      add('repo', 'repo', slug, file, size)
    }
  }
  const order = { volume: 0, site: 1, repo: 2 } as const
  return {
    parts: [...parts.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name)),
    // Die erste Zeile (der Stand) fehlt, wenn vorne abgeschnitten wurde
    truncated: !sawSnapshot && lines.length > 0,
  }
}

/** Wegwerf-Container: Volume leeren und aus dem Staging füllen (cp -a erhält Rechte und Besitzer) */
export function volumeRestoreCmd(slug: string, volume: string): string[] {
  if (!/^[A-Za-z0-9_.-]+$/.test(volume) || volume.startsWith('.')) throw new Error(`Ungültiger Volume-Name: ${volume}`)
  const from = restoredPath(`${projectPaths(slug).volumes}/${volume}`)
  return ['sh', '-c', `test -d '${from}' && find /to -mindepth 1 -delete && cp -a '${from}/.' /to/`]
}

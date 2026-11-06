import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import tarFs from 'tar-fs'
import { createRequire } from 'node:module'
import type { Ignore } from '@balena/dockerignore'
import { readFile } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import { config } from '../config.js'

// Das Paket ist CommonJS (module.exports = factory), seine Typen behaupten
// export default. createRequire liefert zur Laufzeit eindeutig die Funktion.
const dockerignore = createRequire(import.meta.url)('@balena/dockerignore') as (o?: { ignorecase?: boolean }) => Ignore

/**
 * Arbeitsordner pro Deployment (Clone, Build-Kontext) und Ablage der
 * Artefakte, die ein Rollback braucht (normalisierte Compose-Dateien).
 */

export const workDir = (deploymentId: string) => join(config.DATA_DIR, 'work', deploymentId)
export const artifactDir = (deploymentId: string) => join(config.DATA_DIR, 'deployments', deploymentId)

export async function freshWorkDir(deploymentId: string): Promise<string> {
  const dir = workDir(deploymentId)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  return dir
}

export async function dropWorkDir(deploymentId: string): Promise<void> {
  await rm(workDir(deploymentId), { recursive: true, force: true })
}

export async function ensureArtifactDir(deploymentId: string): Promise<string> {
  const dir = artifactDir(deploymentId)
  await mkdir(dir, { recursive: true })
  return dir
}

export async function dropArtifactDir(deploymentId: string): Promise<void> {
  await rm(artifactDir(deploymentId), { recursive: true, force: true })
}

/**
 * Packt einen Ordner als Tar. Nie mit .git; optional mit .dockerignore.
 * Symlinks werden nicht verfolgt (tar-fs packt sie als Symlinks; git hat sie
 * ohnehin schon als einfache Dateien ausgecheckt).
 */
export async function packDir(
  dir: string,
  o: {
    dockerignore?: boolean
    prefix?: string
    exclude?: string[]
    /** Immer mitschicken, auch wenn .dockerignore sie ausschliesst (das Dockerfile). */
    alwaysInclude?: string[]
  } = {},
): Promise<Readable> {
  let ig: Ignore | null = null
  let hasNegation = false
  if (o.dockerignore) {
    const lines = (await readFile(join(dir, '.dockerignore'), 'utf8').catch(() => '')).split(/\r?\n/)
    ig = dockerignore().add(lines)
    hasNegation = lines.some((l) => l.trim().startsWith('!'))
  }
  const exclude = new Set(['.git', ...(o.exclude ?? [])])
  // Wie docker build: .dockerignore und das Dockerfile gehen immer mit.
  const always = new Set(['.dockerignore', ...(o.alwaysInclude ?? []).map((p) => p.replace(/^\.\//, ''))])
  const isAncestorOfAlways = (rel: string) => [...always].some((a) => a.startsWith(`${rel}/`))

  return tarFs.pack(dir, {
    ignore: (name: string) => {
      const rel = name.slice(dir.length).replace(/^[/\\]+/, '')
      if (!rel) return false
      const top = rel.split('/')[0]!
      if (exclude.has(top)) return true
      if (!ig || always.has(rel)) return false

      let isDir = false
      try {
        isDir = lstatSync(name).isDirectory()
      } catch {
        /* verschwunden: wie eine Datei behandeln */
      }
      if (isDir) {
        // Ein übersprungener Ordner nimmt seinen ganzen Inhalt mit. Mit
        // "!"-Ausnahmen oder einem Dockerfile darin deshalb nie den Ordner
        // selbst überspringen, sondern Datei für Datei entscheiden.
        if (hasNegation || isAncestorOfAlways(rel)) return false
        return ig.ignores(`${rel}/`) || ig.ignores(rel)
      }
      return ig.ignores(rel)
    },
    map: o.prefix ? (header) => ({ ...header, name: `${o.prefix}/${header.name}` }) : undefined,
  }) as unknown as Readable
}

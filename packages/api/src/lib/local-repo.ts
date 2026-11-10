import { execFile } from 'node:child_process'
import { mkdir, writeFile, rm, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { safeJoin } from './unzip.js'
import { AppError } from './errors.js'

/**
 * Lokales Git-Repo eines Chat-Projekts (Quelle "files", M3).
 *
 * Dateien kommen als Pfad und Inhalt, etwa von einem MCP-Client. Es gibt
 * keinen Weg, einen Symlink oder etwas unter .git anzulegen; jeder Pfad
 * wird geprüft wie ein ZIP-Eintrag.
 */

export const FILES_LIMITS = {
  maxBytesPerCall: 20 * 1024 * 1024,
  maxFilesPerCall: 2000,
  maxPathLength: 255,
  maxReadBytes: 2 * 1024 * 1024,
}

export type FilesKind = 'compose' | 'dockerfile' | 'static-build' | 'static'

export interface FileInput {
  path: string
  content: string
  encoding?: 'utf8' | 'base64'
}

const rejected = (msg: string) => new AppError('files_rejected', msg, 400)

/** Prüft einen Dateipfad und gibt ihn normalisiert zurück. */
export function validateFilePath(p: string): string {
  if (typeof p !== 'string' || p.length === 0) throw rejected('Leerer Dateipfad')
  if (p.length > FILES_LIMITS.maxPathLength) throw rejected(`Pfad länger als ${FILES_LIMITS.maxPathLength} Zeichen: ${p.slice(0, 40)}…`)
  if (p.includes('\0') || p.includes('\\')) throw rejected(`Ungültige Zeichen im Pfad "${p}"`)
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) throw rejected(`Pfad "${p}" muss relativ sein`)
  const parts = p.split('/')
  for (const seg of parts) {
    if (seg === '..') throw rejected(`Pfad "${p}" zeigt aus dem Projekt heraus`)
    if (seg.toLowerCase() === '.git') throw rejected(`Pfad "${p}" liegt in .git`)
  }
  if (p.endsWith('/')) throw rejected(`Pfad "${p}" ist ein Ordner, keine Datei`)
  const normalized = parts.filter((s) => s !== '' && s !== '.').join('/')
  if (!normalized) throw rejected(`Ungültiger Pfad "${p}"`)
  // Zur Sicherheit auch über die aufgelöste Strecke wie beim ZIP.
  if (safeJoin('/repo', normalized) === null) throw rejected(`Pfad "${p}" zeigt aus dem Projekt heraus`)
  return normalized
}

/** Dekodiert und prüft eine Liste von Dateien gegen die Grenzen pro Aufruf. */
export function decodeFiles(files: FileInput[]): { path: string; data: Buffer }[] {
  if (files.length > FILES_LIMITS.maxFilesPerCall) {
    throw rejected(`Höchstens ${FILES_LIMITS.maxFilesPerCall} Dateien pro Aufruf`)
  }
  let total = 0
  const seen = new Set<string>()
  return files.map((f) => {
    const path = validateFilePath(f.path)
    if (seen.has(path)) throw rejected(`Datei "${path}" kommt doppelt vor`)
    seen.add(path)
    const data = f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : Buffer.from(f.content, 'utf8')
    total += data.length
    if (total > FILES_LIMITS.maxBytesPerCall) {
      throw rejected(`Mehr als ${FILES_LIMITS.maxBytesPerCall / 1024 / 1024} MB pro Aufruf`)
    }
    return { path, data }
  })
}

/* --- git --------------------------------------------------------------------- */

const IDENTITY = ['-c', 'user.name=airlock', '-c', 'user.email=airlock@localhost.invalid', '-c', 'core.symlinks=false', '-c', 'core.hooksPath=/dev/null']

function gitEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: '/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LANG: 'C' }
}

function git(dir: string, args: string[], encoding: 'utf8' | 'buffer' = 'utf8'): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', [...IDENTITY, '-C', dir, ...args], { env: gitEnv(), maxBuffer: 64 * 1024 * 1024, encoding }, (err, stdout, stderr) => {
      if (err) return reject(new AppError('git_failed', `git ${args[0]}: ${String(stderr).trim().split('\n').pop() ?? err.message}`, 500))
      resolve(stdout)
    })
  })
}
const gitText = async (dir: string, args: string[]) => String(await git(dir, args)).trim()

export async function initRepo(dir: string): Promise<void> {
  if (existsSync(join(dir, '.git'))) return
  await mkdir(dir, { recursive: true })
  await gitText(dir, ['init', '-q', '-b', 'main'])
}

export async function headCommit(dir: string): Promise<string | null> {
  try {
    return await gitText(dir, ['rev-parse', '--verify', '-q', 'HEAD'])
  } catch {
    return null
  }
}

/**
 * Schreibt und löscht Dateien und committet. Ändert sich nichts, entsteht
 * kein Commit; zurück kommt dann der bisherige Stand.
 */
/** Eine Änderung pro Repo zur Zeit: sonst nähme ein `git add -A` fremde Dateien mit. */
const repoLocks = new Map<string, Promise<unknown>>()

function withRepoLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(dir) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  repoLocks.set(dir, next)
  // Aufräumen über then(ok, fehler): ein .finally() wäre ein eigenes Promise,
  // das bei einem Fehler unbehandelt abgelehnt würde.
  const cleanup = () => {
    if (repoLocks.get(dir) === next) repoLocks.delete(dir)
  }
  next.then(cleanup, cleanup)
  return next
}

/**
 * Schreibt und löscht Dateien und committet – ganz oder gar nicht. Scheitert
 * etwas, wird der Arbeitsordner auf den letzten Commit zurückgesetzt; sonst
 * nähme der nächste Commit halbe Änderungen unter falscher Nachricht mit.
 * Ändert sich nichts, entsteht kein Commit; zurück kommt der bisherige Stand.
 */
export function commitFiles(
  dir: string,
  o: { write: { path: string; data: Buffer }[]; remove?: string[]; message: string },
): Promise<{ commit: string; changed: boolean }> {
  return withRepoLock(dir, async () => {
    await initRepo(dir)
    try {
      for (const f of o.write) {
        const target = join(dir, f.path)
        await assertNoSymlinkOnPath(dir, f.path)
        await mkdir(dirname(target), { recursive: true }).catch(() => {
          throw rejected(`"${f.path}": ein Teil des Pfades ist eine Datei, kein Ordner`)
        })
        await writeFile(target, f.data, { mode: 0o644 }).catch(() => {
          throw rejected(`"${f.path}" lässt sich nicht schreiben (Ordner mit diesem Namen?)`)
        })
      }
      for (const raw of o.remove ?? []) {
        const p = validateFilePath(raw)
        await assertNoSymlinkOnPath(dir, p)
        const st = await lstat(join(dir, p)).catch(() => null)
        if (st?.isDirectory()) throw rejected(`"${p}" ist ein Ordner; bitte die einzelnen Dateien löschen`)
        await rm(join(dir, p), { force: true })
      }
      await gitText(dir, ['add', '-A'])
      const status = await gitText(dir, ['status', '--porcelain'])
      if (!status) {
        const head = await headCommit(dir)
        if (!head) throw rejected('Das Projekt hat noch keine Dateien')
        return { commit: head, changed: false }
      }
      const message = o.message.trim().slice(0, 500) || 'Änderung über Airlock'
      await gitText(dir, ['commit', '-q', '-m', message])
      return { commit: (await headCommit(dir))!, changed: true }
    } catch (err) {
      await resetWorkTree(dir)
      throw err
    }
  })
}

/** Arbeitsordner auf den letzten Commit zurück; ohne Commit: alles ausser .git weg. */
async function resetWorkTree(dir: string): Promise<void> {
  if (await headCommit(dir)) {
    await gitText(dir, ['reset', '-q', '--hard', 'HEAD']).catch(() => {})
    await gitText(dir, ['clean', '-q', '-f', '-d']).catch(() => {})
    return
  }
  const { readdir } = await import('node:fs/promises')
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name !== '.git') await rm(join(dir, name), { recursive: true, force: true })
  }
  await gitText(dir, ['rm', '-q', '-r', '--cached', '--ignore-unmatch', '.']).catch(() => {})
}

/** Kein Pfadteil darf ein Symlink sein (zweite Absicherung). */
async function assertNoSymlinkOnPath(root: string, rel: string): Promise<void> {
  let cur = root
  for (const seg of rel.split('/')) {
    cur = join(cur, seg)
    const st = await lstat(cur).catch(() => null)
    if (!st) return
    if (st.isSymbolicLink()) throw rejected(`"${rel}" führt über einen Symlink`)
  }
}

export interface RepoFile {
  path: string
  size: number
}

export async function listFiles(dir: string, commit = 'HEAD'): Promise<RepoFile[]> {
  // -z: Pfade roh und nullgetrennt. Ohne -z setzt git Namen mit Umlauten
  // oder Sonderzeichen in C-Anführungszeichen ("\303\274ber.html"), und der
  // Pfad passt nicht mehr zur Datei (Review M3).
  const out = String(await git(dir, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit]))
  if (!out) return []
  return out
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      // <mode> <type> <object> <size>\t<path>
      const tab = entry.indexOf('\t')
      const size = Number(entry.slice(0, tab).trim().split(/\s+/)[3])
      return { path: entry.slice(tab + 1), size: Number.isFinite(size) ? size : 0 }
    })
}

/** Inhalt einzelner Dateien; Text als UTF-8, sonst Base64. */
export async function readFiles(
  dir: string,
  paths: string[] | undefined,
  maxBytes = FILES_LIMITS.maxReadBytes,
  commit = 'HEAD',
): Promise<{ path: string; size: number; encoding: 'utf8' | 'base64'; content: string }[]> {
  const all = await listFiles(dir, commit)
  const wanted = paths ? new Set(paths.map(validateFilePath)) : null
  const out: { path: string; size: number; encoding: 'utf8' | 'base64'; content: string }[] = []
  let total = 0
  for (const f of all) {
    if (wanted && !wanted.has(f.path)) continue
    if (total + f.size > maxBytes) {
      throw rejected(`Antwort würde ${Math.round(maxBytes / 1024 / 1024)} MB überschreiten – bitte einzelne Pfade anfragen`)
    }
    total += f.size
    const data = (await git(dir, ['show', `${commit}:${f.path}`], 'buffer')) as Buffer
    const isText = !data.includes(0) && Buffer.from(data.toString('utf8'), 'utf8').equals(data)
    out.push({ path: f.path, size: f.size, encoding: isText ? 'utf8' : 'base64', content: isText ? data.toString('utf8') : data.toString('base64') })
  }
  if (wanted) {
    for (const p of wanted) if (!out.some((f) => f.path === p)) throw rejected(`"${p}" gibt es im Projekt nicht`)
  }
  return out
}

/** Tar des Stands zum Entpacken über lib/untar.ts. */
export function archiveTar(dir: string, commit: string): Readable {
  const child = spawn('git', [...IDENTITY, '-C', dir, 'archive', '--format=tar', commit], { env: gitEnv() })
  return child.stdout
}

export async function archiveZip(dir: string, commit = 'HEAD'): Promise<Buffer> {
  return (await git(dir, ['archive', '--format=zip', commit], 'buffer')) as Buffer
}

/* --- Typ-Erkennung (SPEC, Reihenfolge) --------------------------------------- */

export const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']

export function detectKind(paths: string[], packageJson: string | null): { kind: FilesKind; composePath?: string } {
  const set = new Set(paths)
  const compose = COMPOSE_NAMES.find((n) => set.has(n))
  if (compose) return { kind: 'compose', composePath: compose }
  if (set.has('Dockerfile')) return { kind: 'dockerfile' }
  if (packageJson !== null) {
    try {
      const pkg = JSON.parse(packageJson) as { scripts?: Record<string, unknown> }
      if (typeof pkg.scripts?.build === 'string') return { kind: 'static-build' }
    } catch {
      /* kaputtes package.json: wie statisch behandeln */
    }
  }
  return { kind: 'static' }
}

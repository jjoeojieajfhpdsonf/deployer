import { lstat, readFile, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { safeJoin } from './unzip.js'
import { AppError } from './errors.js'

/**
 * Dateizugriffe innerhalb eines geklonten Repos.
 *
 * Git checkt Symlinks als einfache Dateien aus (core.symlinks=false). Hier
 * kommt die zweite Absicherung: kein Pfad aus dem Repo heraus, keine
 * Symlinks, auch nicht in Zwischenordnern. Sonst könnte ein Repo z.B.
 * env_file auf /proc/self/environ zeigen lassen und so die Umgebung des
 * Airlocks (Datenbank-URL, Passwörter) in einen Container leiten.
 */

const outside = (rel: string) =>
  new AppError('repo_path_rejected', `Pfad "${rel}" liegt nicht im Repo`, 400)

export async function resolveInRepo(root: string, rel: string): Promise<string> {
  const joined = safeJoin(root, rel === '.' ? '' : rel) ?? (rel === '.' ? resolve(root) : null)
  if (joined === null) throw outside(rel)

  // Jeder Abschnitt des Pfades: kein Symlink.
  const base = resolve(root)
  const parts = joined === base ? [] : joined.slice(base.length + 1).split(sep)
  let cur = base
  for (const p of parts) {
    cur = `${cur}${sep}${p}`
    const st = await lstat(cur).catch(() => null)
    if (!st) break // existiert (noch) nicht – der Aufrufer meldet das selbst
    if (st.isSymbolicLink()) {
      throw new AppError('repo_path_rejected', `"${rel}" ist oder enthält einen Symlink`, 400)
    }
  }

  // Doppelt hält besser: auch der echte Pfad muss im Repo liegen. Gibt es den
  // Pfad (noch) nicht, reichen die lexikalische Prüfung und der Gang über die
  // Pfadteile oben – realpath einer fehlenden Datei wäre nicht vergleichbar
  // (unter macOS ist /var selbst ein Symlink auf /private/var).
  const real = await realpath(joined).catch(() => null)
  if (real !== null) {
    const realRoot = await realpath(base)
    if (real !== realRoot && !real.startsWith(realRoot + sep)) throw outside(rel)
  }
  return joined
}

export async function readRepoFile(root: string, rel: string, maxBytes: number): Promise<string> {
  const path = await resolveInRepo(root, rel)
  const st = await lstat(path).catch(() => null)
  if (!st) throw new AppError('repo_file_missing', `"${rel}" gibt es im Repo nicht`, 400)
  if (!st.isFile()) throw new AppError('repo_path_rejected', `"${rel}" ist keine Datei`, 400)
  if (st.size > maxBytes) {
    throw new AppError('repo_file_too_large', `"${rel}" ist grösser als ${maxBytes} Bytes`, 400)
  }
  return readFile(path, 'utf8')
}

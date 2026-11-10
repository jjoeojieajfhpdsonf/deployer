import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { checkRepoUrl, displayUrl, type RepoUrlPolicy } from './repo-url.js'
import { AppError } from './errors.js'

/**
 * Git über die CLI, immer per execFile (keine Shell), "--" vor der URL.
 *
 * Absicherungen in jedem Aufruf:
 * - protocol.allow=never, nur http/https freigegeben: greift auch bei
 *   Weiterleitungen und Submodulen, sperrt file://, ssh://, ext::
 * - http.curloptResolve: git benutzt genau die Adressen, die checkRepoUrl
 *   geprüft hat. Ein DNS-Rebinding zwischen Prüfung und Clone läuft ins Leere.
 * - core.symlinks=false: Symlinks im Repo werden als Textdateien
 *   ausgecheckt und können nicht aus dem Repo herauszeigen.
 * - keine globale oder System-Konfiguration, kein Passwort-Dialog.
 */

export interface CloneOptions {
  url: string
  /** Branch, Tag oder voller 40-stelliger Commit-Hash. */
  ref?: string
  dest: string
  policy: RepoUrlPolicy
  timeoutMs?: number
  onLine?: (line: string) => void
}

const FULL_SHA = /^[0-9a-f]{40}$/

function baseArgs(host: string, port: number, addresses: string[]): string[] {
  const args = [
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    '-c', 'protocol.http.allow=always',
    '-c', 'core.symlinks=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'credential.helper=',
    '-c', 'http.followRedirects=false',
  ]
  // EIN Eintrag mit allen Adressen, durch Komma getrennt. Getrennte Einträge
  // für denselben Host und Port ersetzen sich in curl gegenseitig – übrig
  // bliebe nur die letzte Adresse (bei uns oft eine nicht routbare IPv6).
  // IPv4 zuerst.
  if (addresses.length) {
    const sorted = [...addresses].sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')))
    const list = sorted.map((a) => (a.includes(':') ? `[${a}]` : a)).join(',')
    args.push('-c', `http.curloptResolve=${host}:${port}:${list}`)
  }
  return args
}

function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: '/tmp',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    LANG: 'C',
    ...extra,
  }
}

function run(
  args: string[],
  opts: { cwd?: string; timeoutMs: number; onLine?: (l: string) => void; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd: opts.cwd, env: gitEnv(opts.env), timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const killed = (err as { killed?: boolean }).killed
          reject(
            new AppError(
              killed ? 'git_timeout' : 'git_failed',
              killed
                ? `git wurde nach ${Math.round(opts.timeoutMs / 1000)} s abgebrochen`
                : `git ist fehlgeschlagen: ${(stderr || err.message).trim().split('\n').slice(-3).join(' | ')}`,
              400,
            ),
          )
          return
        }
        resolve(stdout.trim())
      },
    )
    child.stderr?.on('data', (d: Buffer) => {
      for (const l of d.toString().split(/[\r\n]+/)) if (l.trim()) opts.onLine?.(l.trim())
    })
  })
}

/**
 * Schiebt ein lokales Repo auf eine entfernte URL (export_repo, M3).
 *
 * Dieselbe URL-Prüfung wie beim Clone. Das Zugangs-Token kommt über
 * GIT_CONFIG_COUNT in die Umgebung, nicht in die Argumente – so steht es
 * nicht in der Prozessliste und nicht in Fehlermeldungen.
 */
export async function pushRepo(o: {
  dir: string
  url: string
  branch: string
  token?: string
  policy: RepoUrlPolicy
}): Promise<{ displayUrl: string }> {
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/.test(o.branch) || o.branch.includes('..')) {
    throw new AppError('git_failed', `Ungültiger Branch "${o.branch}"`, 400)
  }
  const checked = await checkRepoUrl(o.url, o.policy)
  const env: NodeJS.ProcessEnv = {}
  if (o.token) {
    const basic = Buffer.from(`x-access-token:${o.token}`).toString('base64')
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader'
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`
  }
  await run(
    [...baseArgs(checked.host, checked.port, checked.addresses), '-C', o.dir, 'push', '--', checked.url.toString(), `HEAD:refs/heads/${o.branch}`],
    { timeoutMs: 2 * 60_000, env },
  )
  return { displayUrl: displayUrl(checked.url) }
}

/**
 * M8: Kopf eines Branches (oder HEAD) ohne Klonen, für Auto-Deploy nach
 * Merge. Dieselbe URL-Prüfung wie beim Clone; ein Token (GitHub App) kommt
 * wie bei pushRepo über die Umgebung, nie in die Argumente.
 */
export async function lsRemoteHead(o: { url: string; ref?: string | null; policy: RepoUrlPolicy; token?: string }): Promise<string> {
  if (o.ref && (!/^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/.test(o.ref) || o.ref.includes('..'))) {
    throw new AppError('git_failed', `Ungültiger Branch "${o.ref}"`, 400)
  }
  const checked = await checkRepoUrl(o.url, o.policy)
  const env: NodeJS.ProcessEnv = {}
  if (o.token) {
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader'
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${o.token}`).toString('base64')}`
  }
  const target = o.ref ? `refs/heads/${o.ref}` : 'HEAD'
  const out = await run([...baseArgs(checked.host, checked.port, checked.addresses), 'ls-remote', '--', checked.url.toString(), target], { timeoutMs: 30_000, env })
  const sha = out.split('\n').find((l) => l.endsWith(`\t${target}`))?.split('\t')[0] ?? ''
  if (!FULL_SHA.test(sha)) throw new AppError('git_failed', `${target} gibt es im Repo nicht`, 400)
  return sha
}

export async function cloneRepo(o: CloneOptions): Promise<{ commit: string; displayUrl: string }> {
  const checked = await checkRepoUrl(o.url, o.policy)
  const timeoutMs = o.timeoutMs ?? 5 * 60_000
  const base = baseArgs(checked.host, checked.port, checked.addresses)
  const url = checked.url.toString()

  await rm(o.dest, { recursive: true, force: true })
  await mkdir(o.dest, { recursive: true })

  if (o.ref && FULL_SHA.test(o.ref)) {
    // Ein Commit lässt sich nicht als --branch klonen: leeres Repo, gezielt holen.
    await run([...base, 'init', '-q', o.dest], { timeoutMs, onLine: o.onLine })
    await run([...base, '-C', o.dest, 'remote', 'add', 'origin', '--', url], { timeoutMs })
    await run([...base, '-C', o.dest, 'fetch', '--depth', '1', '--no-tags', 'origin', o.ref], { timeoutMs, onLine: o.onLine })
    await run([...base, '-C', o.dest, 'checkout', '-q', 'FETCH_HEAD'], { timeoutMs })
  } else {
    const args = [...base, 'clone', '--depth', '1', '--single-branch', '--no-tags']
    if (o.ref) args.push('--branch', o.ref)
    args.push('--', url, o.dest)
    await run(args, { timeoutMs, onLine: o.onLine })
  }

  const commit = await run(['-C', o.dest, 'rev-parse', 'HEAD'], { timeoutMs: 10_000 })
  if (!FULL_SHA.test(commit)) {
    throw new AppError('git_failed', `Unerwartete Ausgabe von git rev-parse: ${commit.slice(0, 80)}`, 500)
  }
  return { commit, displayUrl: displayUrl(checked.url) }
}

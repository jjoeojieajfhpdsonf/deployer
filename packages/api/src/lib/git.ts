import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkRepoUrl, displayUrl, type CheckedRepoUrl, type RepoUrlPolicy } from './repo-url.js'
import { AppError } from './errors.js'
import { hostAlias, parseHostKeys, type HostKeyLine } from './ssh-key.js'

/**
 * Git über die CLI, immer per execFile (keine Shell), "--" vor der URL.
 *
 * Absicherungen in jedem Aufruf:
 * - protocol.allow=never, nur http/https freigegeben (bzw. nur ssh bei
 *   einem Deploy-Key): greift auch bei Weiterleitungen und Submodulen,
 *   sperrt file://, ext::
 * - http.curloptResolve bzw. ssh HostName: git benutzt genau die Adressen,
 *   die checkRepoUrl geprüft hat. Ein DNS-Rebinding zwischen Prüfung und
 *   Clone läuft ins Leere.
 * - core.symlinks=false: Symlinks im Repo werden als Textdateien
 *   ausgecheckt und können nicht aus dem Repo herauszeigen.
 * - keine globale oder System-Konfiguration, kein Passwort-Dialog.
 *
 * Nacht 3, Etappe 2 – Zugang zu privaten Repos (GitAuth):
 * - HTTPS-Token (GitHub-App, GitLab/Gitea-Token): als Kopfzeile über
 *   GIT_CONFIG_COUNT in der Umgebung NUR dieses Kindprozesses – nie in den
 *   Argumenten (Prozessliste), nie in der URL, nie in .git/config.
 * - Deploy-Key: privater Schlüssel und known_hosts als 0600-Dateien in einem
 *   eigenen 0700-Ordner, nach dem Aufruf gelöscht; ssh mit
 *   StrictHostKeyChecking=yes gegen genau die bestätigten Server-Schlüssel.
 * - Fehlermeldungen und Fortschrittszeilen werden von bekannten Geheimnissen
 *   gesäubert; nach dem Clone verschwindet origin aus .git/config.
 */

export type GitAuth =
  | {
      kind: 'https'
      /** x-access-token (GitHub-App), oauth2 (GitLab) … */
      username: string
      token: string
    }
  | {
      kind: 'ssh'
      /** OpenSSH-Format, entschlüsselt nur im Speicher */
      privateKey: string
      /** Bestätigte Zeilen «alias typ schlüssel» (TOFU) */
      knownHosts: string
    }

export interface CloneOptions {
  url: string
  /** Branch, Tag oder voller 40-stelliger Commit-Hash. */
  ref?: string
  dest: string
  policy: RepoUrlPolicy
  timeoutMs?: number
  onLine?: (line: string) => void
  auth?: GitAuth
}

const FULL_SHA = /^[0-9a-f]{40}$/
const REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/

function baseArgs(checked: CheckedRepoUrl): string[] {
  const args = [
    '-c', 'protocol.allow=never',
    ...(checked.kind === 'ssh'
      ? ['-c', 'protocol.ssh.allow=always']
      : ['-c', 'protocol.https.allow=always', '-c', 'protocol.http.allow=always']),
    '-c', 'core.symlinks=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'credential.helper=',
    '-c', 'http.followRedirects=false',
  ]
  // EIN Eintrag mit allen Adressen, durch Komma getrennt. Getrennte Einträge
  // für denselben Host und Port ersetzen sich in curl gegenseitig – übrig
  // bliebe nur die letzte Adresse (bei uns oft eine nicht routbare IPv6).
  // IPv4 zuerst.
  if (checked.kind === 'http' && checked.addresses.length) {
    const list = sortedAddresses(checked.addresses).map((a) => (a.includes(':') ? `[${a}]` : a)).join(',')
    args.push('-c', `http.curloptResolve=${checked.host}:${checked.port}:${list}`)
  }
  return args
}

const sortedAddresses = (a: string[]) => [...a].sort((x, y) => Number(x.includes(':')) - Number(y.includes(':')))

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

/** Bekannte Geheimnisse aus einem Text entfernen (Token, Basic-Kopfzeile) */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text
  for (const s of [...secrets].filter((x) => x.length >= 6).sort((a, b) => b.length - a.length)) {
    if (out.includes(s)) out = out.split(s).join('***')
  }
  return out
}

/**
 * Die aussagekräftigen letzten Zeilen einer Fehlerausgabe. gits Standardsatz
 * nach einem SSH-Fehler («Please make sure you have the correct access
 * rights …») verdrängt sonst den eigentlichen Grund (z. B. «Host key
 * verification failed», «Permission denied (publickey)»).
 */
export function errorLines(text: string): string[] {
  const boiler = /^(fatal: Could not read from remote repository\.|Please make sure you have the correct access rights|and the repository exists\.)$/
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !boiler.test(l)).slice(-3)
}

function run(
  args: string[],
  opts: { cwd?: string; timeoutMs: number; onLine?: (l: string) => void; env?: NodeJS.ProcessEnv; secrets?: readonly string[]; bin?: string },
): Promise<string> {
  const secrets = opts.secrets ?? []
  return new Promise((resolve, reject) => {
    const child = execFile(
      opts.bin ?? 'git',
      args,
      { cwd: opts.cwd, env: gitEnv(opts.env), timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const killed = (err as { killed?: boolean }).killed
          const what = opts.bin === 'ssh-keyscan' ? 'ssh-keyscan' : 'git'
          reject(
            new AppError(
              killed ? 'git_timeout' : 'git_failed',
              killed
                ? `${what} wurde nach ${Math.round(opts.timeoutMs / 1000)} s abgebrochen`
                : scrub(`${what} ist fehlgeschlagen: ${errorLines(stderr || err.message).join(' | ')}`, secrets),
              400,
            ),
          )
          return
        }
        resolve(stdout.trim())
      },
    )
    child.stderr?.on('data', (d: Buffer) => {
      for (const l of d.toString().split(/[\r\n]+/)) if (l.trim()) opts.onLine?.(scrub(l.trim(), secrets))
    })
  })
}

/** Ein Wert für GIT_SSH_COMMAND (läuft über die Shell): immer in einfachen Anführungszeichen */
const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`

/** ssh-Aufruf für git: nur dieser Schlüssel, nur die bestätigten Server-Schlüssel, nur die geprüfte Adresse */
export function sshCommand(o: { keyFile: string; knownHostsFile: string; alias: string; address: string }): string {
  const opt = (k: string, v: string) => `-o ${k}=${sq(v)}`
  return [
    'ssh', '-F', '/dev/null', '-i', sq(o.keyFile),
    opt('IdentitiesOnly', 'yes'), opt('IdentityAgent', 'none'), opt('BatchMode', 'yes'),
    opt('StrictHostKeyChecking', 'yes'), opt('UserKnownHostsFile', o.knownHostsFile), opt('GlobalKnownHostsFile', '/dev/null'),
    opt('HostKeyAlias', o.alias), opt('HostName', o.address), opt('CheckHostIP', 'no'), opt('UpdateHostKeys', 'no'),
    opt('PasswordAuthentication', 'no'), opt('KbdInteractiveAuthentication', 'no'),
    opt('ProxyCommand', 'none'), opt('ForwardAgent', 'no'), opt('ForwardX11', 'no'), opt('ClearAllForwardings', 'yes'),
    opt('PermitLocalCommand', 'no'), opt('ConnectTimeout', '15'), opt('LogLevel', 'ERROR'),
  ].join(' ')
}

/**
 * Umgebung und Geheimnisse für einen Aufruf mit Zugang. Bei SSH liegen
 * Schlüssel und known_hosts in einem eigenen Ordner, der nach fn() sofort
 * wieder verschwindet – auch bei einem Fehler.
 */
async function withAuth<T>(checked: CheckedRepoUrl, auth: GitAuth | undefined, fn: (env: NodeJS.ProcessEnv, secrets: string[]) => Promise<T>): Promise<T> {
  if (!auth) {
    if (checked.kind === 'ssh') throw new AppError('git_failed', 'Eine SSH-Adresse geht nur mit einem Deploy-Key', 400)
    return fn({}, [])
  }
  if (auth.kind === 'https') {
    if (checked.kind !== 'http') throw new AppError('git_failed', 'Ein Zugangstoken geht nur mit einer https://-Adresse', 400)
    const basic = Buffer.from(`${auth.username}:${auth.token}`).toString('base64')
    return fn({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    }, [auth.token, basic])
  }
  if (checked.kind !== 'ssh') throw new AppError('git_failed', 'Ein Deploy-Key geht nur mit einer SSH-Adresse (git@host:pfad)', 400)
  const dir = await mkdtemp(join(tmpdir(), 'airlock-ssh-'))
  try {
    await chmod(dir, 0o700)
    const keyFile = join(dir, 'id')
    const knownHostsFile = join(dir, 'known_hosts')
    await writeFile(keyFile, auth.privateKey, { mode: 0o600 })
    await writeFile(knownHostsFile, auth.knownHosts, { mode: 0o600 })
    const address = sortedAddresses(checked.addresses)[0]!
    const cmd = sshCommand({ keyFile, knownHostsFile, alias: hostAlias(checked.host, checked.port), address })
    // Der private Schlüssel steht nur in der Datei; zur Sicherheit trotzdem säubern
    const keyBody = auth.privateKey.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
    return await fn({ GIT_SSH_COMMAND: cmd, GIT_SSH_VARIANT: 'ssh' }, [keyBody])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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
  if (!REF_RE.test(o.branch) || o.branch.includes('..')) {
    throw new AppError('git_failed', `Ungültiger Branch "${o.branch}"`, 400)
  }
  const checked = await checkRepoUrl(o.url, o.policy)
  const auth: GitAuth | undefined = o.token ? { kind: 'https', username: 'x-access-token', token: o.token } : undefined
  await withAuth(checked, auth, (env, secrets) => run(
    [...baseArgs(checked), '-C', o.dir, 'push', '--', checked.gitUrl, `HEAD:refs/heads/${o.branch}`],
    { timeoutMs: 2 * 60_000, env, secrets },
  ))
  return { displayUrl: displayUrl(checked.url) }
}

/**
 * Refs eines Repos ohne Klonen (git ls-remote), z. B. HEAD, refs/heads/main.
 * Liefert Name → Commit. Dieselbe URL-Prüfung und derselbe Zugang wie beim Clone.
 */
export async function lsRemote(o: { url: string; patterns: string[]; policy: RepoUrlPolicy; auth?: GitAuth; timeoutMs?: number }): Promise<Map<string, string>> {
  const checked = await checkRepoUrl(o.url, o.policy, { allowSsh: o.auth?.kind === 'ssh' })
  const out = await withAuth(checked, o.auth, (env, secrets) =>
    run([...baseArgs(checked), 'ls-remote', '--', checked.gitUrl, ...o.patterns], { timeoutMs: o.timeoutMs ?? 30_000, env, secrets }))
  const refs = new Map<string, string>()
  for (const line of out.split('\n')) {
    const [sha, name] = line.split('\t')
    if (sha && name && FULL_SHA.test(sha)) refs.set(name, sha)
  }
  return refs
}

/**
 * M8: Kopf eines Branches (oder HEAD) ohne Klonen, für Auto-Deploy nach
 * Merge. Dieselbe URL-Prüfung wie beim Clone; ein Zugang (Token,
 * Deploy-Key) wie dort, nie in den Argumenten.
 */
export async function lsRemoteHead(o: { url: string; ref?: string | null; policy: RepoUrlPolicy; token?: string; auth?: GitAuth }): Promise<string> {
  if (o.ref && (!REF_RE.test(o.ref) || o.ref.includes('..'))) {
    throw new AppError('git_failed', `Ungültiger Branch "${o.ref}"`, 400)
  }
  const auth: GitAuth | undefined = o.auth ?? (o.token ? { kind: 'https', username: 'x-access-token', token: o.token } : undefined)
  const target = o.ref ? `refs/heads/${o.ref}` : 'HEAD'
  const refs = await lsRemote({ url: o.url, patterns: [target], policy: o.policy, auth })
  const sha = refs.get(target) ?? ''
  if (!FULL_SHA.test(sha)) throw new AppError('git_failed', `${target} gibt es im Repo nicht`, 400)
  return sha
}

export async function cloneRepo(o: CloneOptions): Promise<{ commit: string; displayUrl: string }> {
  const checked = await checkRepoUrl(o.url, o.policy, { allowSsh: o.auth?.kind === 'ssh' })
  const timeoutMs = o.timeoutMs ?? 5 * 60_000
  const base = baseArgs(checked)
  const url = checked.gitUrl

  await rm(o.dest, { recursive: true, force: true })
  await mkdir(o.dest, { recursive: true })

  await withAuth(checked, o.auth, async (env, secrets) => {
    if (o.ref && FULL_SHA.test(o.ref)) {
      // Ein Commit lässt sich nicht als --branch klonen: leeres Repo, gezielt holen.
      await run([...base, 'init', '-q', o.dest], { timeoutMs, onLine: o.onLine })
      await run([...base, '-C', o.dest, 'remote', 'add', 'origin', '--', url], { timeoutMs })
      await run([...base, '-C', o.dest, 'fetch', '--depth', '1', '--no-tags', 'origin', o.ref], { timeoutMs, onLine: o.onLine, env, secrets })
      await run([...base, '-C', o.dest, 'checkout', '-q', 'FETCH_HEAD'], { timeoutMs })
    } else {
      const args = [...base, 'clone', '--depth', '1', '--single-branch', '--no-tags']
      if (o.ref) args.push('--branch', o.ref)
      args.push('--', url, o.dest)
      await run(args, { timeoutMs, onLine: o.onLine, env, secrets })
    }
  })

  // Nichts vom Zugang bleibt im Ordner: origin (Adresse, Fetch-Regeln) weg.
  // Das Token stand ohnehin nur in der Umgebung des Kindprozesses.
  await run(['-C', o.dest, 'remote', 'remove', 'origin'], { timeoutMs: 10_000 }).catch(() => undefined)

  const commit = await run(['-C', o.dest, 'rev-parse', 'HEAD'], { timeoutMs: 10_000 })
  if (!FULL_SHA.test(commit)) {
    throw new AppError('git_failed', `Unerwartete Ausgabe von git rev-parse: ${commit.slice(0, 80)}`, 500)
  }
  return { commit, displayUrl: displayUrl(checked.url) }
}

/**
 * Nacht 3, Etappe 2: Schlüssel eines SSH-Git-Servers für die Bestätigung
 * beim ersten Verbinden (TOFU). Fragt genau die geprüfte Adresse, nicht den
 * Namen (kein DNS-Rebinding); die Zeilen bekommen den Namen (bzw.
 * «[name]:port»), unter dem ssh sie später sucht (HostKeyAlias).
 */
export async function scanHostKeys(o: { url: string; policy: RepoUrlPolicy; timeoutMs?: number }): Promise<{ alias: string; keys: HostKeyLine[] }> {
  const checked = await checkRepoUrl(o.url, o.policy, { allowSsh: true })
  if (checked.kind !== 'ssh') throw new AppError('git_failed', 'Server-Schlüssel gibt es nur bei einer SSH-Adresse', 400)
  const address = sortedAddresses(checked.addresses)[0]!
  const out = await run(['-T', '10', '-p', String(checked.port), '-t', 'ed25519,ecdsa,rsa', '--', address], {
    timeoutMs: o.timeoutMs ?? 20_000, bin: 'ssh-keyscan',
  })
  const keys = parseHostKeys(out)
  if (!keys.length) throw new AppError('git_failed', `${checked.host}:${checked.port} antwortet nicht als SSH-Server`, 400)
  return { alias: hostAlias(checked.host, checked.port), keys }
}

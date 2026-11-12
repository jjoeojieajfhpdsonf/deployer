import { GIT_ACCESS_LABEL, repoAddressKind, type GitAccessVia, type RepoCheckCode, type RepoCheckDto, type RepoCheckLink } from '@airlock/shared'
import type { GitAuth } from '../lib/git.js'
import type { HostKeyLine } from '../lib/ssh-key.js'
import { hostKeyDtos, knownHostsFor } from '../lib/ssh-key.js'
import { AppError } from '../lib/errors.js'

/**
 * Nacht 3, Etappe 2: «Repo erreichbar?» vor dem Anlegen (und in den
 * Einstellungen). Reine Abfolge mit austauschbaren Helfern – testbar ohne
 * Netz, GitHub und Datenbank (repo-check.test.ts).
 *
 * Geprüft wird mit git ls-remote über genau den Weg, den später der Deploy
 * nimmt (GitHub-App-Token nur lesend, Deploy-Key mit bestätigtem
 * Server-Schlüssel, Token, ohne Zugang). Meldungen sagen, was zu tun ist.
 */

/** Entschlüsselter Zugang eines Projekts bzw. eines eben erzeugten Schlüssels */
export type CredentialSecret =
  | { kind: 'ssh_key'; privateKey: string; host: string | null; knownHosts: string | null }
  | { kind: 'https_token'; username: string; token: string }

export type GithubAppState = 'kein_app' | 'nicht_installiert' | 'kein_zugriff' | 'zugriff'

export interface RepoCheckDeps {
  githubRepo: (url: string) => { owner: string; repo: string } | null
  githubApp: (r: { owner: string; repo: string }) => Promise<{ state: GithubAppState; installUrl: string | null }>
  readToken: (repo: string) => Promise<string>
  lsRemote: (o: { url: string; patterns: string[]; auth?: GitAuth }) => Promise<Map<string, string>>
  scanHostKeys: (url: string) => Promise<{ alias: string; keys: HostKeyLine[] }>
  /** Name des Servers in known_hosts (HostKeyAlias), ohne Netz */
  hostAliasOf: (url: string) => string
}

export type RepoCheckOutcome = RepoCheckDto & {
  /** Neu gemeldete Server-Schlüssel, zum Speichern als «noch nicht bestätigt» */
  pending?: { alias: string; knownHosts: string }
}

const FULL_SHA = /^[0-9a-f]{40}$/

const fail = (code: RepoCheckCode, message: string, link: RepoCheckLink | null = null): RepoCheckOutcome => ({ ok: false, code, message, link, hostKey: null })

/** Fehlermeldung von git/ssh einordnen (ohne Geheimnisse – git säubert sie vorher) */
export function classifyGitError(msg: string): 'host_key' | 'auth' | 'not_found' | 'unreachable' | 'other' {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key is known|HOST KEY/i.test(msg)) return 'host_key'
  if (/Permission denied|Authentication failed|could not read (Username|Password)|terminal prompts disabled|\b401\b|\b403\b|access denied|not authorized|HTTP Basic: Access denied/i.test(msg)) return 'auth'
  if (/not found|could not be found|does not appear to be a git repository|\b404\b|does not exist|no such repository/i.test(msg)) return 'not_found'
  if (/abgebrochen|timed out|Could not resolve|Connection refused|Connection reset|No route to host|Network is unreachable|lässt sich nicht auflösen|Failed to connect/i.test(msg)) return 'unreachable'
  return 'other'
}

/** Welche Refs ls-remote holen soll */
export function refPatterns(ref: string | undefined): string[] {
  if (!ref || FULL_SHA.test(ref)) return ['HEAD']
  return [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`]
}

/** Kopf des gewünschten Refs aus der ls-remote-Antwort; undefined = gibt es nicht */
export function commitOf(refs: Map<string, string>, ref: string | undefined): string | null | undefined {
  if (ref && FULL_SHA.test(ref)) return null
  if (!ref) return refs.get('HEAD') ?? (refs.size ? null : undefined)
  return refs.get(`refs/heads/${ref}`) ?? refs.get(`refs/tags/${ref}^{}`) ?? refs.get(`refs/tags/${ref}`)
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function runRepoCheck(
  input: { repoUrl: string; ref?: string; credential: CredentialSecret | null },
  deps: RepoCheckDeps,
): Promise<RepoCheckOutcome> {
  const { repoUrl, ref, credential } = input
  const kind = repoAddressKind(repoUrl)
  if (!kind) return fail('url', 'Das ist keine Repo-Adresse: https://… oder git@host:pfad')

  const ls = async (via: GitAccessVia, auth?: GitAuth): Promise<RepoCheckOutcome> => {
    const refs = await deps.lsRemote({ url: repoUrl, patterns: refPatterns(ref), auth })
    const commit = commitOf(refs, ref)
    if (commit === undefined) {
      return ref
        ? fail('ref_missing', `Branch oder Tag «${ref}» gibt es in diesem Repo nicht. Leer lassen für den Standard-Branch.`)
        : fail('not_found', 'Das Repo ist leer (noch kein Commit).')
    }
    const what = ref && !FULL_SHA.test(ref) ? `«${ref}»` : ref ? 'Commit' : 'Standard-Branch'
    return {
      ok: true, via, commit,
      message: `Erreichbar über ${GIT_ACCESS_LABEL[via]}${commit ? ` – ${what} steht auf ${commit.slice(0, 7)}` : ''}.`,
    }
  }

  // Fehler eines Versuchs in eine Meldung übersetzen
  const explain = (err: unknown, via: GitAccessVia): RepoCheckOutcome => {
    if (err instanceof AppError && err.code === 'repo_url_rejected') return fail('url', err.message)
    const m = errMsg(err)
    const c = classifyGitError(m)
    if (c === 'host_key') {
      return fail('host_key_changed', 'Der Git-Server meldet sich mit einem anderen Schlüssel als dem bestätigten. Das kann ein Angriff sein – oder der Anbieter hat seinen Schlüssel gewechselt. Prüfe das beim Anbieter; danach den Server in Einstellungen › Repo-Zugang neu bestätigen.')
    }
    if (c === 'unreachable') return fail('unreachable', `Der Git-Server antwortet nicht (${m.replace(/^git ist fehlgeschlagen: /, '').slice(0, 160)}). Stimmt die Adresse, ist der Server erreichbar?`)
    if (via === 'deploy_key' && (c === 'auth' || c === 'not_found')) {
      return fail('auth_failed', 'Der Git-Server lehnt den Deploy-Key ab oder kennt das Repo nicht. Trage den öffentlichen Schlüssel beim Repo ein (GitLab: Settings › Repository › Deploy keys, Gitea: Einstellungen › Deploy-Schlüssel – nur lesend) und prüfe noch einmal.')
    }
    if (via === 'token' && c === 'auth') {
      return fail('auth_failed', 'Der Git-Server lehnt das Token ab: abgelaufen, falscher Benutzername oder zu wenig Rechte (nötig ist nur Lesen, bei GitLab «read_repository»).')
    }
    if (c === 'not_found' || c === 'auth') {
      return via === 'anonym'
        ? fail('not_found', 'Ohne Zugang nicht erreichbar: Gibt es das Repo unter dieser Adresse? Ist es privat, unter «Zugang» einen Deploy-Key oder ein Token hinterlegen.')
        : fail('not_found', 'Das Repo gibt es unter dieser Adresse nicht – oder der Zugang reicht nicht dafür.')
    }
    return fail('unreachable', `Prüfung gescheitert: ${m.replace(/^git ist fehlgeschlagen: /, '').slice(0, 200)}`)
  }

  // --- Mit eigenem Zugang (Deploy-Key oder Token), egal bei welchem Anbieter ---
  if (credential?.kind === 'ssh_key') {
    if (kind !== 'ssh') return fail('url', 'Ein Deploy-Key braucht die SSH-Adresse des Repos, z.B. git@gitlab.com:user/app.git')
    let alias: string
    try {
      alias = deps.hostAliasOf(repoUrl)
    } catch (err) {
      return explain(err, 'deploy_key')
    }
    if (!credential.knownHosts || credential.host !== alias) {
      try {
        const scan = await deps.scanHostKeys(repoUrl)
        return {
          ok: false, code: 'host_key_unknown', link: null,
          message: `Erste Verbindung zu ${scan.alias}: Vergleiche den Fingerabdruck mit dem, den der Anbieter veröffentlicht, und bestätige ihn. Danach verbindet Airlock nur noch mit genau diesem Schlüssel.`,
          hostKey: { host: scan.alias, keys: hostKeyDtos(scan.keys) },
          pending: { alias: scan.alias, knownHosts: knownHostsFor(scan.alias, scan.keys) },
        }
      } catch (err) {
        return explain(err, 'deploy_key')
      }
    }
    try {
      return await ls('deploy_key', { kind: 'ssh', privateKey: credential.privateKey, knownHosts: credential.knownHosts })
    } catch (err) {
      return explain(err, 'deploy_key')
    }
  }
  if (credential?.kind === 'https_token') {
    if (kind !== 'https') return fail('url', 'Ein Zugangstoken geht nur über https:// (nie unverschlüsselt über http://). Im Heimnetz ohne HTTPS: Deploy-Key mit der SSH-Adresse nehmen.')
    try {
      return await ls('token', { kind: 'https', username: credential.username, token: credential.token })
    } catch (err) {
      return explain(err, 'token')
    }
  }

  if (kind === 'ssh') return fail('needs_key', 'Eine SSH-Adresse braucht einen Deploy-Key: unter «Zugang» Deploy-Key wählen und den Schlüssel beim Anbieter eintragen.')

  // --- GitHub: über die App, sonst öffentlich ---
  const gh = deps.githubRepo(repoUrl)
  if (gh) {
    const app = await deps.githubApp(gh).catch(() => ({ state: 'kein_app' as const, installUrl: null }))
    if (app.state === 'zugriff') {
      let token: string
      try {
        token = await deps.readToken(gh.repo)
      } catch (err) {
        return fail('unreachable', `Die GitHub-App bekommt kein Token für dieses Repo: ${errMsg(err).slice(0, 200)}`, { href: '/system/github', label: 'Server › GitHub', external: false })
      }
      try {
        return await ls('github_app', { kind: 'https', username: 'x-access-token', token })
      } catch (err) {
        return explain(err, 'github_app')
      }
    }
    try {
      return await ls('anonym')
    } catch (err) {
      const e = explain(err, 'anonym')
      if (e.ok || (e.code !== 'not_found')) return e
      if (app.state === 'kein_app') {
        return fail('github_app_missing', 'Ohne Zugang nicht erreichbar. Ist das Repo privat, verbinde zuerst die GitHub-App (Server › GitHub) und gib ihr Zugriff auf dieses Repo.', { href: '/system/github', label: 'GitHub-App verbinden', external: false })
      }
      if (app.state === 'nicht_installiert') {
        return fail('github_no_access', 'Die GitHub-App ist noch nicht installiert. Installiere sie und gib ihr Zugriff auf dieses Repo.', app.installUrl ? { href: app.installUrl, label: 'In GitHub installieren', external: true } : null)
      }
      return fail('github_no_access', 'Die GitHub-App hat keinen Zugriff auf dieses Repo – in GitHub unter Installation › Repository access freigeben.', app.installUrl ? { href: app.installUrl, label: 'In GitHub freigeben', external: true } : null)
    }
  }

  // --- Andere Anbieter ohne Zugang: öffentlich ---
  try {
    return await ls('anonym')
  } catch (err) {
    return explain(err, 'anonym')
  }
}

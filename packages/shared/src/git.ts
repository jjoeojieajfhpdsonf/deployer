import { z } from 'zod'

/**
 * Nacht 3, Etappe 2: private Git-Repos.
 *
 * - GitHub über die bestehende GitHub-App: pro Vorgang ein Installations-Token,
 *   nur «Contents: read» und nur für das eine Repo.
 * - Andere Anbieter (GitLab, Gitea, eigener Server): pro Projekt ein Deploy-Key
 *   (ed25519, SSH) oder ein Zugangstoken (HTTPS). Den Server-Schlüssel bestätigt
 *   man beim ersten Verbinden (TOFU), danach gilt genau dieser.
 *
 * Geheimnisse (privater Schlüssel, Token) verlassen den Server nie: Die API
 * nennt nur den öffentlichen Schlüssel, Fingerabdrücke und den Benutzernamen.
 */

/** Wie Airlock ein Repo holt */
export type GitAccessVia = 'github_app' | 'deploy_key' | 'token' | 'anonym'

export const GIT_ACCESS_LABEL: Record<GitAccessVia, string> = {
  github_app: 'GitHub-App',
  deploy_key: 'Deploy-Key (SSH)',
  token: 'Zugangstoken (HTTPS)',
  anonym: 'öffentlich, ohne Zugang',
}

export type GitCredentialKind = 'ssh_key' | 'https_token'

/** Ein Schlüssel des Git-Servers, wie ihn ssh-keygen -l zeigt */
export interface GitHostKeyDto {
  /** z. B. ssh-ed25519 */
  type: string
  /** SHA256:… (Base64 ohne =) */
  fingerprint: string
}

export interface GitCredentialDto {
  id: string
  kind: GitCredentialKind
  /** Nur Deploy-Key: öffentlicher Schlüssel im OpenSSH-Format (zum Eintragen beim Anbieter) */
  publicKey: string | null
  /** Nur Deploy-Key: Fingerabdruck des öffentlichen Schlüssels (wie GitLab ihn zeigt) */
  keyFingerprint: string | null
  /** Nur Token: Benutzername für HTTPS (das Token selbst nie) */
  username: string | null
  /** Bestätigter Git-Server (Name, bei anderem Port «[name]:port») */
  host: string | null
  hostKeys: GitHostKeyDto[]
  hostConfirmedAt: string | null
  createdAt: string
  lastUsedAt: string | null
}

export type RepoCheckCode =
  | 'url'
  | 'github_no_access'
  | 'github_app_missing'
  | 'not_found'
  | 'auth_failed'
  | 'needs_key'
  | 'host_key_unknown'
  | 'host_key_changed'
  | 'ref_missing'
  | 'unreachable'

export interface RepoCheckLink {
  href: string
  label: string
  /** Ausserhalb von Airlock (neuer Tab) */
  external: boolean
}

export type RepoCheckDto =
  | {
      ok: true
      via: GitAccessVia
      /** Kopf des Branches/Tags (oder HEAD); null bei einem festen Commit */
      commit: string | null
      message: string
    }
  | {
      ok: false
      code: RepoCheckCode
      message: string
      link: RepoCheckLink | null
      /** Nur bei host_key_unknown: diese Schlüssel meldet der Server, bitte bestätigen */
      hostKey: { host: string; keys: GitHostKeyDto[] } | null
    }

/** Benutzername für HTTPS mit Token (GitLab: beliebig, z. B. oauth2; Gitea: der Benutzer) */
export const gitUsernameSchema = z
  .string()
  .trim()
  .min(1, 'Gib einen Benutzernamen an, z.B. oauth2 – oder lass das Feld leer')
  .max(100, 'Höchstens 100 Zeichen')
  .regex(/^[A-Za-z0-9._@+-]+$/, 'Nur Buchstaben, Ziffern und . _ @ + -, z.B. oauth2')

export const createGitCredentialSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ssh_key') }),
  z.object({
    kind: z.literal('https_token'),
    username: gitUsernameSchema.optional(),
    token: z
      .string({ required_error: 'Gib das Zugangstoken an' })
      .trim()
      .min(8, 'Das Token ist zu kurz (mindestens 8 Zeichen)')
      .max(4096, 'Das Token ist zu lang')
      .regex(/^[\x21-\x7e]+$/, 'Das Token enthält Leer- oder Sonderzeichen; kopiere es noch einmal'),
  }),
])
export type CreateGitCredentialInput = z.infer<typeof createGitCredentialSchema>

/** Bestätigung des Server-Schlüssels: genau die Fingerabdrücke, die angezeigt wurden */
export const confirmHostKeySchema = z.object({
  host: z.string().min(1).max(300),
  fingerprints: z.array(z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/, 'Ungültiger Fingerabdruck')).min(1).max(10),
})

/** Kurzform eines Fingerabdrucks für schmale Stellen (Anfang … Ende) */
export const shortFingerprint = (f: string): string => (f.length > 30 ? `${f.slice(0, 18)}…${f.slice(-6)}` : f)

/** Pro Projekt: wie das Repo geholt wird */
export interface ProjectGitAccessDto {
  /** null: Projekt ohne Git-Repo */
  via: GitAccessVia | null
  credential: GitCredentialDto | null
  /** GitHub-Repo (owner/repo), wenn die URL zu GitHub gehört */
  githubRepo: string | null
  /** Die GitHub-App ist verbunden, installiert und hat Zugriff auf dieses Repo */
  githubAppAccess: boolean
}

/** Art einer Repo-Adresse (nur die Form; die Ziele prüft der Server) */
export type RepoAddressKind = 'https' | 'http' | 'ssh'

/** scp-Form git@host:pfad – Benutzer nötig, Pfad nie mit «-» am Anfang */
export const SCP_REPO_RE = /^([A-Za-z0-9._][A-Za-z0-9._-]{0,63})@([A-Za-z0-9][A-Za-z0-9.-]{0,252}|\[[0-9A-Fa-f:.]+\]):(?!-)([A-Za-z0-9._~/][A-Za-z0-9._~/+-]{0,1000})$/

export function repoAddressKind(url: string): RepoAddressKind | null {
  const v = url.trim()
  if (/^https:\/\//i.test(v)) return 'https'
  if (/^http:\/\//i.test(v)) return 'http'
  if (/^ssh:\/\//i.test(v) || SCP_REPO_RE.test(v)) return 'ssh'
  return null
}

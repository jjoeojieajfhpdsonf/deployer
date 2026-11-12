import { and, eq, isNull, lt } from 'drizzle-orm'
import { join } from 'node:path'
import {
  repoAddressKind, SCP_REPO_RE,
  type CreateGitCredentialInput, type GitAccessVia, type GitCredentialDto, type ProjectGitAccessDto, type RepoCheckDto,
} from '@airlock/shared'
import { db, schema } from '../db/index.js'
import { config } from '../config.js'
import { loadOrCreateKey, encrypt, decrypt } from '../lib/crypto.js'
import { AppError, badRequest, notFound } from '../lib/errors.js'
import { log } from '../lib/log.js'
import { githubRepoOf } from '../lib/github.js'
import { lsRemote, scanHostKeys, type GitAuth } from '../lib/git.js'
import { generateDeployKey, fingerprintOfPublicKey, hostAlias, hostKeyDtos, parseHostKeys } from '../lib/ssh-key.js'
import { repoUrlPolicy } from './git-policy.js'
import { githubAppFor, readToken } from './github.js'
import { audit } from './audit.js'
import { runRepoCheck, type CredentialSecret, type RepoCheckDeps } from './repo-check.js'

/**
 * Nacht 3, Etappe 2: Zugang zu privaten Repos.
 *
 * - GitHub über die App (Token nur lesend, nur dieses Repo, pro Vorgang).
 * - Sonst pro Projekt ein Deploy-Key (ed25519) oder ein HTTPS-Token in
 *   git_credentials, verschlüsselt mit der Schlüsseldatei.
 * - Der Server-Schlüssel eines SSH-Git-Servers gilt erst nach Bestätigung
 *   (TOFU); danach verbindet ssh nur mit StrictHostKeyChecking=yes.
 *
 * Nie nach aussen: privater Schlüssel und Token (DTOs, Audit, Logs).
 */

type Row = typeof schema.gitCredentials.$inferSelect
type Project = typeof schema.projects.$inferSelect

const key = () => loadOrCreateKey(join(config.DATA_DIR, 'keys', 'secrets.key'))
/** Noch keinem Projekt zugeordnet: nach so langer Zeit weg */
export const UNBOUND_TTL_MS = 24 * 60 * 60_000

export function credentialDto(r: Row): GitCredentialDto {
  const keys = r.knownHosts ? parseHostKeys(r.knownHosts) : []
  return {
    id: r.id,
    kind: r.kind,
    publicKey: r.publicKey,
    keyFingerprint: r.publicKey ? fingerprintOfPublicKey(r.publicKey) : null,
    username: r.kind === 'https_token' ? r.username : null,
    host: r.host,
    hostKeys: hostKeyDtos(keys),
    hostConfirmedAt: r.hostConfirmedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  }
}

function secretOf(r: Row): CredentialSecret {
  if (r.kind === 'ssh_key') {
    if (!r.privateKeyEnc) throw new AppError('internal', 'Deploy-Key ohne privaten Schlüssel', 500)
    return { kind: 'ssh_key', privateKey: decrypt(r.privateKeyEnc, key()), host: r.host, knownHosts: r.knownHosts }
  }
  if (!r.tokenEnc || !r.username) throw new AppError('internal', 'Token-Zugang ohne Token', 500)
  return { kind: 'https_token', username: r.username, token: decrypt(r.tokenEnc, key()) }
}

const viaOf = (r: Row): GitAccessVia => (r.kind === 'ssh_key' ? 'deploy_key' : 'token')

async function byId(id: string): Promise<Row | null> {
  return (await db.select().from(schema.gitCredentials).where(eq(schema.gitCredentials.id, id)).limit(1))[0] ?? null
}

export async function credentialOfProject(projectId: string): Promise<Row | null> {
  return (await db.select().from(schema.gitCredentials).where(eq(schema.gitCredentials.projectId, projectId)).limit(1))[0] ?? null
}

/** Eben erzeugter, noch keinem Projekt zugeordneter Zugang (für Neues Projekt) */
async function unbound(id: string): Promise<Row> {
  const r = await byId(id)
  if (!r || r.projectId) throw badRequest('Dieser Zugang ist abgelaufen oder gehört schon zu einem Projekt. Bitte neu erzeugen.', [{ path: 'gitCredentialId', message: 'Zugang neu erzeugen' }])
  if (Date.now() - r.createdAt.getTime() > UNBOUND_TTL_MS) throw badRequest('Dieser Zugang ist abgelaufen (24 Stunden). Bitte neu erzeugen.')
  return r
}

/** Name des Kommentars am Deploy-Key: Server und Datum – so erkennt man ihn beim Anbieter wieder */
const keyComment = (slug?: string) => `airlock${config.SERVER_NAME ? `-${config.SERVER_NAME}` : ''}${slug ? `-${slug}` : ''}-${new Date().toISOString().slice(0, 10)}`

function newValues(input: CreateGitCredentialInput, slug?: string): typeof schema.gitCredentials.$inferInsert {
  if (input.kind === 'ssh_key') {
    const k = generateDeployKey(keyComment(slug))
    return { kind: 'ssh_key', publicKey: k.publicKey, privateKeyEnc: encrypt(k.privateKey, key()) }
  }
  return { kind: 'https_token', username: input.username ?? 'oauth2', tokenEnc: encrypt(input.token, key()) }
}

const auditParams = (r: Row) => ({
  credential: r.id, kind: r.kind,
  ...(r.publicKey ? { keyFingerprint: fingerprintOfPublicKey(r.publicKey) } : {}),
  ...(r.kind === 'https_token' ? { username: r.username } : {}),
})

/** Neues Projekt: Zugang anlegen, bevor es das Projekt gibt (der Schlüssel muss erst beim Anbieter eingetragen werden) */
export async function createCredential(input: CreateGitCredentialInput, actor: string): Promise<GitCredentialDto> {
  // Bei der Gelegenheit: alte, nie benutzte Zugänge weg
  await purgeUnbound().catch(() => undefined)
  const r = (await db.insert(schema.gitCredentials).values(newValues(input)).returning())[0]!
  await audit({ actor, action: 'git.credential.create', params: auditParams(r), result: 'ok' })
  return credentialDto(r)
}

/**
 * Einem eben angelegten Projekt zuordnen (Neues Projekt). Nur ein noch freier
 * Zugang; ein bestätigter Server-Schlüssel kommt mit.
 */
export async function bindCredential(credentialId: string, projectId: string, actor: string): Promise<void> {
  const r = await unbound(credentialId)
  const done = await db.update(schema.gitCredentials).set({ projectId, updatedAt: new Date() })
    .where(and(eq(schema.gitCredentials.id, r.id), isNull(schema.gitCredentials.projectId))).returning()
  if (!done.length) throw badRequest('Dieser Zugang gehört schon zu einem Projekt')
  await audit({ actor, action: 'git.credential.bind', targetType: 'project', targetId: projectId, params: auditParams(r), result: 'ok' })
}

/**
 * Einstellungen › Repo-Zugang: Zugang eines Projekts setzen oder ersetzen.
 * Ein bestätigter Server bleibt bestätigt (gleicher Server, neuer Schlüssel).
 */
export async function setProjectCredential(p: Project, input: CreateGitCredentialInput, actor: string): Promise<GitCredentialDto> {
  const old = await credentialOfProject(p.id)
  const values = newValues(input, p.slug)
  const keep = old && old.kind === 'ssh_key' && values.kind === 'ssh_key'
    ? { host: old.host, knownHosts: old.knownHosts, hostConfirmedAt: old.hostConfirmedAt }
    : {}
  const r = await db.transaction(async (tx) => {
    if (old) await tx.delete(schema.gitCredentials).where(eq(schema.gitCredentials.id, old.id))
    return (await tx.insert(schema.gitCredentials).values({ ...values, ...keep, projectId: p.id }).returning())[0]!
  })
  await audit({
    actor, action: old ? 'git.credential.replace' : 'git.credential.create', targetType: 'project', targetId: p.id,
    params: { ...auditParams(r), ...(old ? { replaced: old.id } : {}) }, result: 'ok',
  })
  return credentialDto(r)
}

export async function removeProjectCredential(p: Project, actor: string): Promise<void> {
  const old = await credentialOfProject(p.id)
  if (!old) return
  await db.delete(schema.gitCredentials).where(eq(schema.gitCredentials.id, old.id))
  await audit({ actor, action: 'git.credential.delete', targetType: 'project', targetId: p.id, params: auditParams(old), result: 'ok' })
}

/** Bestätigten Server-Schlüssel vergessen (Anbieter hat gewechselt) – beim nächsten Prüfen neu bestätigen */
export async function forgetHostKey(p: Project, actor: string): Promise<GitCredentialDto> {
  const old = await credentialOfProject(p.id)
  if (!old || old.kind !== 'ssh_key') throw badRequest('Das Projekt hat keinen Deploy-Key')
  const r = (await db.update(schema.gitCredentials).set({ host: null, knownHosts: null, hostConfirmedAt: null, updatedAt: new Date() })
    .where(eq(schema.gitCredentials.id, old.id)).returning())[0]!
  await audit({ actor, action: 'git.host_key.forget', targetType: 'project', targetId: p.id, params: { credential: old.id, host: old.host }, result: 'ok' })
  return credentialDto(r)
}

/**
 * Server-Schlüssel bestätigen (TOFU): genau die zuletzt angezeigten
 * Fingerabdrücke, höchstens eine Stunde alt.
 */
export async function confirmHostKey(o: { credentialId?: string; project?: Project; host: string; fingerprints: string[] }, actor: string): Promise<GitCredentialDto> {
  const r = o.project ? await credentialOfProject(o.project.id) : o.credentialId ? await unbound(o.credentialId) : null
  if (!r) throw notFound('Zugang')
  if (r.kind !== 'ssh_key') throw badRequest('Nur ein Deploy-Key braucht einen bestätigten Server')
  if (!r.pendingHost || !r.pendingKnownHosts || !r.pendingAt || Date.now() - r.pendingAt.getTime() > 60 * 60_000) {
    throw badRequest('Keine offene Bestätigung: zuerst «Repo prüfen»')
  }
  const shown = parseHostKeys(r.pendingKnownHosts).map((k) => k.fingerprint).sort()
  const given = [...new Set(o.fingerprints)].sort()
  if (o.host !== r.pendingHost || shown.length !== given.length || shown.some((f, i) => f !== given[i])) {
    throw badRequest('Die Fingerabdrücke passen nicht mehr zur letzten Prüfung – bitte noch einmal prüfen')
  }
  const saved = (await db.update(schema.gitCredentials).set({
    host: r.pendingHost, knownHosts: r.pendingKnownHosts, hostConfirmedAt: new Date(),
    pendingHost: null, pendingKnownHosts: null, pendingAt: null, updatedAt: new Date(),
  }).where(eq(schema.gitCredentials.id, r.id)).returning())[0]!
  await audit({
    actor, action: 'git.host_key.confirm', targetType: r.projectId ? 'project' : undefined, targetId: r.projectId ?? undefined,
    params: { credential: r.id, host: r.pendingHost, fingerprints: shown }, result: 'ok',
  })
  return credentialDto(saved)
}

/** Aufräumen: nie einem Projekt zugeordnete Zugänge nach 24 Stunden */
export async function purgeUnbound(now = Date.now()): Promise<number> {
  const gone = await db.delete(schema.gitCredentials)
    .where(and(isNull(schema.gitCredentials.projectId), lt(schema.gitCredentials.createdAt, new Date(now - UNBOUND_TTL_MS)))).returning({ id: schema.gitCredentials.id })
  return gone.length
}

/* --- Prüfen ------------------------------------------------------------------------------ */

async function deps(): Promise<RepoCheckDeps> {
  const policy = await repoUrlPolicy()
  return {
    githubRepo: (url) => githubRepoOf(url, config.GITHUB_WEB),
    githubApp: githubAppFor,
    readToken,
    lsRemote: (o) => lsRemote({ ...o, policy }),
    scanHostKeys: async (url) => scanHostKeys({ url, policy }),
    hostAliasOf: (url) => {
      // Nur die Form (ohne DNS): Name und Port wie in checkRepoUrl
      if (/^ssh:\/\//i.test(url)) {
        const u = new URL(url)
        return hostAlias(u.hostname.toLowerCase().replace(/^\[|\]$/g, ''), u.port ? Number(u.port) : 22)
      }
      const scp = SCP_REPO_RE.exec(url)
      if (!scp) throw badRequest('Ungültige SSH-Adresse')
      return hostAlias(scp[2]!.replace(/^\[|\]$/g, '').toLowerCase(), 22)
    },
  }
}

/**
 * «Repo erreichbar?» für die Oberfläche und vor dem Anlegen. Mit einem
 * Zugang (eben erzeugt oder der des Projekts) oder ohne. Neu gemeldete
 * Server-Schlüssel werden als «noch nicht bestätigt» gemerkt.
 */
export async function checkRepo(o: { repoUrl: string; ref?: string; credentialId?: string; project?: Project }): Promise<RepoCheckDto> {
  const row = o.credentialId ? await unbound(o.credentialId) : o.project ? await credentialOfProject(o.project.id) : null
  const out = await runRepoCheck({ repoUrl: o.repoUrl, ref: o.ref, credential: row ? secretOf(row) : null }, await deps())
  const { pending, ...dto } = out
  if (row && pending) {
    await db.update(schema.gitCredentials).set({ pendingHost: pending.alias, pendingKnownHosts: pending.knownHosts, pendingAt: new Date() })
      .where(eq(schema.gitCredentials.id, row.id))
  }
  if (row && dto.ok) await db.update(schema.gitCredentials).set({ lastUsedAt: new Date() }).where(eq(schema.gitCredentials.id, row.id))
  return dto
}

/** Einstellungen › Repo-Zugang */
export async function projectGitAccess(p: Project): Promise<ProjectGitAccessDto> {
  const repoUrl = (p.sourceConfig as { repoUrl?: string } | null)?.repoUrl
  if (!repoUrl) return { via: null, credential: null, githubRepo: null, githubAppAccess: false }
  const row = await credentialOfProject(p.id)
  const gh = githubRepoOf(repoUrl, config.GITHUB_WEB)
  const app = gh ? await githubAppFor(gh).catch(() => null) : null
  const access = app?.state === 'zugriff'
  return {
    via: row ? viaOf(row) : access ? 'github_app' : 'anonym',
    credential: row ? credentialDto(row) : null,
    githubRepo: gh ? `${gh.owner}/${gh.repo}` : null,
    githubAppAccess: access,
  }
}

/* --- Für Deploy, Auto-Deploy, Vorschauen ---------------------------------------------- */

export interface ResolvedGitAuth {
  auth?: GitAuth
  via: GitAccessVia
  /** Für das Deploy-Log: wie, ohne Geheimnis */
  note: string
}

/**
 * Zugang für einen Clone oder ls-remote dieses Projekts (Vorschau: der des
 * Hauptprojekts). Reihenfolge: eigener Zugang, sonst GitHub-App mit
 * Zugriff, sonst ohne. Kann die App kein Token holen, geht es ohne weiter
 * (ein öffentliches Repo deployt dann trotzdem).
 */
export async function gitAuthFor(p: Project): Promise<ResolvedGitAuth> {
  const repoUrl = (p.sourceConfig as { repoUrl?: string } | null)?.repoUrl
  if (!repoUrl) return { via: 'anonym', note: '' }
  const row = (await credentialOfProject(p.id)) ?? (p.previewOf ? await credentialOfProject(p.previewOf) : null)
  if (row) {
    const s = secretOf(row)
    await db.update(schema.gitCredentials).set({ lastUsedAt: new Date() }).where(eq(schema.gitCredentials.id, row.id))
    if (s.kind === 'ssh_key') {
      if (!s.knownHosts) throw new AppError('git_failed', 'Der Server des Repos ist noch nicht bestätigt: Einstellungen › Repo-Zugang › «Prüfen» und den Fingerabdruck bestätigen.', 400)
      return { via: 'deploy_key', auth: { kind: 'ssh', privateKey: s.privateKey, knownHosts: s.knownHosts }, note: `Zugang: Deploy-Key ${row.publicKey ? fingerprintOfPublicKey(row.publicKey) : ''}, Server ${row.host}`.trim() }
    }
    if (repoAddressKind(repoUrl) !== 'https') throw new AppError('git_failed', 'Ein Zugangstoken geht nur über https://', 400)
    return { via: 'token', auth: { kind: 'https', username: s.username, token: s.token }, note: `Zugang: Token (Benutzer ${s.username})` }
  }
  const gh = githubRepoOf(repoUrl, config.GITHUB_WEB)
  if (gh) {
    try {
      const app = await githubAppFor(gh)
      if (app.state === 'zugriff') {
        const token = await readToken(gh.repo)
        return { via: 'github_app', auth: { kind: 'https', username: 'x-access-token', token }, note: 'Zugang: GitHub-App (Token nur lesend, nur dieses Repo, 1 Stunde gültig)' }
      }
    } catch (err) {
      log.warn('GitHub-App: kein Token für den Clone, versuche ohne', { repo: `${gh.owner}/${gh.repo}`, err: String(err) })
      return { via: 'anonym', note: 'GitHub-App: kein Token erhalten – versuche ohne Zugang' }
    }
  }
  return { via: 'anonym', note: '' }
}

/** Vor dem Anlegen: SSH-Adresse und Zugang gehören zusammen (Fehler am Feld) */
export async function assertRepoReachable(o: { repoUrl: string; ref?: string; credentialId?: string; project?: Project }): Promise<void> {
  const r = await checkRepo(o)
  if (r.ok) return
  const msg = r.code === 'host_key_unknown'
    ? 'Der Server des Repos ist noch nicht bestätigt: «Repo prüfen» und den Fingerabdruck bestätigen.'
    : r.message
  throw badRequest(msg, [{ path: 'source.repoUrl', message: msg }])
}

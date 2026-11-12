import { eq } from 'drizzle-orm'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { UI_HOST_LABEL, type GithubStatusDto } from '@airlock/shared'
import { db, schema, getSetting, setSetting } from '../db/index.js'
import { config, primaryHost, urlForHost } from '../config.js'
import { loadOrCreateKey, encrypt, decrypt } from '../lib/crypto.js'
import { AppError, badRequest } from '../lib/errors.js'
import { log } from '../lib/log.js'
import { unifiedDiff } from '../lib/diff.js'
import { GitHub, GITHUB_PERMISSIONS, appJwt, githubManifest, githubRepoOf, manifestFormAction, fixBranchName, GithubError } from '../lib/github.js'
import { audit } from './audit.js'
import { findProject } from './projects.js'
import { setGithubCheck, setPullRequestHook, setGithubSource, type RepoSource } from '../security/fix-service.js'

/**
 * M8, Etappe 3: Verbindung zu GitHub über eine eigene GitHub App.
 *
 * Ablauf (SPEC): Manifest an GitHub schicken → GitHub leitet den Browser mit
 * einem Code zurück → Airlock tauscht ihn gegen App-ID, privaten Schlüssel
 * und Secrets (verschlüsselt gespeichert) → «App installieren» (Repos
 * wählen) → GitHub leitet mit der installation_id zurück. Pro Vorgang ein
 * Installations-Token, eine Stunde gültig, auf das eine Repo beschränkt.
 */

type Conn = typeof schema.gitConnections.$inferSelect
type Project = Awaited<ReturnType<typeof findProject>>

const STATE_KEY = 'github_manifest_state'
const STATE_TTL_MS = 60 * 60_000

const key = () => loadOrCreateKey(join(config.DATA_DIR, 'keys', 'secrets.key'))
export const github = () => new GitHub({ api: config.GITHUB_API })
const airlockUrl = () => urlForHost(primaryHost(UI_HOST_LABEL))

async function connection(): Promise<Conn | null> {
  return (await db.select().from(schema.gitConnections).where(eq(schema.gitConnections.provider, 'github')).limit(1))[0] ?? null
}

const suggestedName = () => `airlock ${config.SERVER_NAME || 'homeserver'} ${randomBytes(2).toString('hex')}`.slice(0, 34)

export async function githubStatus(): Promise<GithubStatusDto> {
  const c = await connection()
  const web = config.GITHUB_WEB.replace(/\/+$/, '')
  return {
    connected: Boolean(c),
    app: c ? { name: c.appName, slug: c.appSlug, htmlUrl: c.htmlUrl, owner: c.ownerLogin, createdAt: c.createdAt.toISOString() } : null,
    installed: Boolean(c?.installationId),
    repos: c?.repos ?? [],
    installUrl: c ? `${web}/apps/${c.appSlug}/installations/new` : null,
    permissions: { ...GITHUB_PERMISSIONS, metadata: 'read (von GitHub immer dabei)' },
    suggestedName: suggestedName(),
    callbackUrl: `${airlockUrl()}/api/v1/github/manifest/callback`,
  }
}

/**
 * Schritt 1: Manifest und Ziel für das Formular, das der Browser an GitHub
 * schickt. Ein zufälliger state schützt die Rückleitung (1 Stunde gültig).
 */
export async function startManifest(o: { name: string; org?: string | null }, actor: string): Promise<{ action: string; manifest: string; state: string }> {
  if (await connection()) throw new AppError('conflict', 'Es gibt schon eine GitHub App. Zuerst die Verbindung trennen.', 409)
  const state = randomBytes(24).toString('hex')
  await setSetting(STATE_KEY, JSON.stringify({ state, at: Date.now() }))
  const manifest = githubManifest({ name: o.name, airlockUrl: airlockUrl() })
  await audit({ actor, action: 'github.manifest', params: { name: o.name, org: o.org ?? null, redirect: manifest.redirect_url }, result: 'ok' })
  return { action: manifestFormAction(config.GITHUB_WEB, state, o.org || null), manifest: JSON.stringify(manifest), state }
}

async function checkState(state: string | undefined): Promise<void> {
  const raw = await getSetting(STATE_KEY)
  const saved = raw ? (JSON.parse(raw) as { state: string; at: number }) : null
  const ok = Boolean(saved && state && saved.state.length === state.length && timingSafeEqual(Buffer.from(saved.state), Buffer.from(state)) && Date.now() - saved.at < STATE_TTL_MS)
  if (!ok) throw badRequest('Die Rückleitung von GitHub passt nicht zu einem eben gestarteten Anlegen (state ungültig oder älter als eine Stunde). Bitte neu starten.')
}

/** Schritt 2: Code aus der Rückleitung gegen die App-Daten tauschen und verschlüsselt speichern. */
export async function finishManifest(code: string, state: string | undefined, actor: string): Promise<void> {
  await checkState(state)
  await setSetting(STATE_KEY, '')
  if (await connection()) throw new AppError('conflict', 'Es gibt schon eine GitHub App', 409)
  const app = await github().convertManifest(code)
  const k = key()
  await db.insert(schema.gitConnections).values({
    provider: 'github',
    appId: String(app.id),
    appSlug: app.slug,
    appName: app.name,
    htmlUrl: app.html_url,
    clientId: app.client_id,
    ownerLogin: app.owner?.login ?? null,
    privateKeyEncrypted: encrypt(app.pem, k),
    clientSecretEncrypted: app.client_secret ? encrypt(app.client_secret, k) : null,
    webhookSecretEncrypted: app.webhook_secret ? encrypt(app.webhook_secret, k) : null,
  })
  await audit({ actor, action: 'github.app_created', params: { app: app.slug, id: app.id, owner: app.owner?.login ?? null }, result: 'ok' })
}

const jwtFor = (c: Conn) => appJwt(c.appId, decrypt(c.privateKeyEncrypted, key()))

/** Schritt 3: Rückleitung nach der Installation; prüft die Installation bei GitHub. */
export async function finishInstall(installationId: string, actor: string): Promise<void> {
  if (!/^\d{1,20}$/.test(installationId)) throw badRequest('Ungültige installation_id')
  const c = await connection()
  if (!c) throw badRequest('Es gibt noch keine GitHub App')
  const gh = github()
  // Gehört die Installation zu unserer App? Sonst antwortet GitHub mit 404.
  await gh.installation(jwtFor(c), installationId)
  const { token } = await gh.installationToken(jwtFor(c), installationId)
  const repos = await gh.installationRepos(token)
  await db.update(schema.gitConnections).set({ installationId, repos, updatedAt: new Date() }).where(eq(schema.gitConnections.id, c.id))
  await audit({ actor, action: 'github.installed', params: { installation: installationId, repos }, result: 'ok' })
}

export async function refreshRepos(actor: string): Promise<string[]> {
  const c = await connection()
  if (!c?.installationId) throw badRequest('Die App ist noch nicht installiert')
  const { token } = await github().installationToken(jwtFor(c), c.installationId)
  const repos = await github().installationRepos(token)
  await db.update(schema.gitConnections).set({ repos, updatedAt: new Date() }).where(eq(schema.gitConnections.id, c.id))
  await audit({ actor, action: 'github.repos', params: { repos }, result: 'ok' })
  return repos
}

/** Verbindung trennen: Schlüssel und Secrets weg. Die App selbst löscht man bei GitHub. */
export async function disconnect(actor: string): Promise<void> {
  const c = await connection()
  if (!c) return
  await db.delete(schema.gitConnections).where(eq(schema.gitConnections.id, c.id))
  await audit({ actor, action: 'github.disconnect', params: { app: c.appSlug }, result: 'ok' })
}

/* --- Pro Projekt ----------------------------------------------------------------------- */

/** GitHub-Repo eines Projekts, wenn die App dafür installiert ist. */
export async function connectedRepo(p: Project): Promise<{ owner: string; repo: string; ref: string | null } | null> {
  const src = p.sourceConfig as { repoUrl?: string; ref?: string }
  const r = githubRepoOf(src.repoUrl, config.GITHUB_WEB)
  if (!r) return null
  const c = await connection()
  if (!c?.installationId) return null
  const full = `${r.owner}/${r.repo}`.toLowerCase()
  if (!c.repos.some((x) => x.toLowerCase() === full)) return null
  return { ...r, ref: src.ref ?? null }
}

/** Installations-Token für genau ein Repo (pro Vorgang, eine Stunde gültig). */
export async function repoToken(repo: string): Promise<string> {
  const c = await connection()
  if (!c?.installationId) throw badRequest('Die GitHub App ist nicht installiert')
  return (await github().installationToken(jwtFor(c), c.installationId, [repo])).token
}

/**
 * Etappe 6: Token für Vorschauen – mit «Checks: write», wenn die Installation
 * dieses Recht hat (von Hand an der App erteilt), sonst ohne. checks sagt,
 * ob Check-Runs möglich sind; ohne bleibt es beim Kommentar am Pull Request.
 */
export async function previewToken(repo: string): Promise<{ token: string; checks: boolean }> {
  const c = await connection()
  if (!c?.installationId) throw badRequest('Die GitHub App ist nicht installiert')
  const gh = github()
  const perms = await gh.installationPermissions(jwtFor(c), c.installationId).catch(() => ({} as Record<string, string>))
  const checks = perms.checks === 'write'
  const { token } = await gh.installationToken(jwtFor(c), c.installationId, [repo], checks ? { checks: 'write' } : undefined)
  return { token, checks }
}

/** Deploy-Branch: der im Projekt eingetragene, sonst der Standard-Branch des Repos. */
export async function baseBranch(token: string, r: { owner: string; repo: string; ref: string | null }): Promise<string> {
  if (r.ref && !/^[0-9a-f]{40}$/.test(r.ref)) return r.ref
  return github().defaultBranch(token, r.owner, r.repo)
}

/** Dateien eines verbundenen Repos für get_fix_context. */
async function source(p: Project): Promise<RepoSource | null> {
  const r = await connectedRepo(p)
  if (!r) return null
  const token = await repoToken(r.repo)
  const branch = await baseBranch(token, r)
  const gh = github()
  const head = await gh.branchHead(token, r.owner, r.repo, branch)
  const paths = await gh.tree(token, r.owner, r.repo, head)
  return {
    commit: head,
    paths,
    read: async (wanted) => {
      const out: { path: string; content: string; encoding: 'utf8' }[] = []
      for (const path of wanted.slice(0, 8)) {
        const text = await gh.fileText(token, r.owner, r.repo, path, head)
        if (text !== null && text.length <= 512 * 1024) out.push({ path, content: text, encoding: 'utf8' })
      }
      return out
    },
  }
}

type FixRow = typeof schema.fixRequests.$inferSelect

/**
 * Vorschlag als Pull Request: eigener Branch airlock/fix-…, ein Commit, PR
 * mit Befund, Erklärung und Link zum Scan. Nie auf den Standard-Branch;
 * Branch-Schutzregeln des Repos gelten unverändert.
 */
async function openPullRequest(row: FixRow, p: Project, actor: string): Promise<FixRow> {
  const r = await connectedRepo(p)
  const fail = async (note: string) =>
    (await db.update(schema.fixRequests).set({ status: 'failed', note, updatedAt: new Date() }).where(eq(schema.fixRequests.id, row.id)).returning())[0]!
  if (!r) return fail('Das Repo ist nicht (mehr) mit der GitHub App verbunden.')
  try {
    const token = await repoToken(r.repo)
    const gh = github()
    const base = await baseBranch(token, r)
    const files = row.changes.files ?? []
    const remove = row.changes.delete ?? []
    // Diff gegen den Stand auf GitHub, für die Oberfläche
    const parts: string[] = []
    for (const f of files) {
      const old = await gh.fileText(token, r.owner, r.repo, f.path, base)
      const d = unifiedDiff(f.path, old, f.encoding === 'base64' ? '«Binärdatei»' : f.content)
      if (d) parts.push(d)
    }
    for (const path of remove) parts.push(unifiedDiff(path, (await gh.fileText(token, r.owner, r.repo, path, base)) ?? '', null))
    const branch = fixBranchName(row.findingTitle, row.id)
    const scanUrl = `${airlockUrl()}/projekte/${p.id}?tab=security`
    const pr = await gh.createFixPullRequest(token, {
      owner: r.owner, repo: r.repo, base, branch,
      title: `Fix: ${row.findingTitle}`.slice(0, 200),
      message: `Fix: ${row.findingTitle}\n\nVorgeschlagen über Airlock (${actor}).`,
      body: [
        `**Befund:** ${row.findingTitle} (${row.tool})`,
        '',
        row.explanation,
        '',
        `Scan in Airlock: ${scanUrl}`,
        '',
        '_Angelegt von Airlock. Nach dem Merge deployt Airlock (wenn Auto-Deploy an ist) und scannt nach; das Ergebnis folgt hier als Kommentar._',
      ].join('\n'),
      files, delete: remove,
    })
    const saved = (await db.update(schema.fixRequests).set({
      status: 'pr_open', branch: pr.branch, prUrl: pr.url, prNumber: pr.number, commit: pr.commit, baseCommit: pr.baseSha,
      diff: parts.join('\n'), note: `Pull Request #${pr.number} auf ${base}`, updatedAt: new Date(),
    }).where(eq(schema.fixRequests.id, row.id)).returning())[0]!
    await audit({ actor, action: 'fix.pull_request', targetType: 'project', targetId: p.id, params: { fix: row.id, repo: `${r.owner}/${r.repo}`, branch: pr.branch, pr: pr.number }, result: 'ok' })
    return saved
  } catch (err) {
    log.warn('Pull Request nicht angelegt', { fix: row.id, err: String(err) })
    return fail(`Pull Request nicht angelegt: ${err instanceof GithubError ? err.message : (err as Error).message}`.slice(0, 400))
  }
}

/** Beim Start: die Wege über GitHub in den Fix-Assistenten einhängen. */
export function registerGithub(): void {
  setGithubCheck(async (p) => Boolean(await connectedRepo(p).catch(() => null)))
  setPullRequestHook(openPullRequest)
  setGithubSource(source)
}

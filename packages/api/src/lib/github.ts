import { createSign } from 'node:crypto'

/**
 * M8, Etappe 3: GitHub App. Schlanker Client über fetch (austauschbar für
 * Tests mit einer Attrappe) und reine Hilfen: Manifest, App-JWT, Repo aus URL.
 *
 * Rechte der App: nur «Contents: write» und «Pull requests: write» (SPEC);
 * GitHub fügt «Metadata: read» immer hinzu. Kein Webhook: Airlock ist nie
 * öffentlich erreichbar, Merges erkennt ein Polling.
 */

export const GITHUB_PERMISSIONS = { contents: 'write', pull_requests: 'write' } as const

export interface GithubManifest {
  name: string
  url: string
  redirect_url: string
  setup_url: string
  setup_on_update: boolean
  public: boolean
  default_permissions: Record<string, string>
  default_events: string[]
  description: string
}

/**
 * App-Manifest. Rückleitungen zeigen auf Airlock selbst; sie laufen über
 * den Browser (der Airlock erreicht), Airlock muss nicht öffentlich sein.
 */
export function githubManifest(o: { name: string; airlockUrl: string }): GithubManifest {
  const base = o.airlockUrl.replace(/\/+$/, '')
  return {
    name: o.name.slice(0, 34),
    url: base,
    redirect_url: `${base}/api/v1/github/manifest/callback`,
    setup_url: `${base}/api/v1/github/setup/callback`,
    setup_on_update: true,
    public: false,
    default_permissions: { ...GITHUB_PERMISSIONS },
    // Keine Ereignisse und kein hook_attributes: ohne Webhook
    default_events: [],
    description: 'Airlock auf dem Homeserver: Fixes zu Security-Befunden als Pull Request.',
  }
}

/** Ziel des Manifest-Formulars: eigenes Konto oder eine Organisation. */
export function manifestFormAction(web: string, state: string, org?: string | null): string {
  const base = web.replace(/\/+$/, '')
  const path = org ? `/organizations/${encodeURIComponent(org)}/settings/apps/new` : '/settings/apps/new'
  return `${base}${path}?state=${encodeURIComponent(state)}`
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')

/**
 * JWT der App (RS256), 9 Minuten gültig, 60 s zurückdatiert gegen
 * Uhrenabweichung (Vorgabe von GitHub: höchstens 10 Minuten).
 */
export function appJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }))
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem)
  return `${head}.${body}.${b64url(sig)}`
}

/** «https://github.com/owner/repo(.git)» -> owner/repo; null bei anderen Hosts. */
export function githubRepoOf(url: string | null | undefined, web = 'https://github.com'): { owner: string; repo: string } | null {
  if (!url) return null
  try {
    const u = new URL(url)
    const w = new URL(web)
    if (u.host.toLowerCase() !== w.host.toLowerCase()) return null
    const [owner, repo] = u.pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/')
    if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null
    return { owner, repo }
  } catch {
    return null
  }
}

export const FIX_BRANCH_PREFIX = 'airlock/'
/** Übergang: Fix-Branches aus der deployer-Zeit (deployer/fix-…) bleiben eigene. */
export const LEGACY_FIX_BRANCH_PREFIX = 'deployer/'
export const isFixBranch = (branch: string): boolean =>
  (branch.startsWith(`${FIX_BRANCH_PREFIX}fix-`) || branch.startsWith(`${LEGACY_FIX_BRANCH_PREFIX}fix-`))

/** Branch für einen Fix: airlock/fix-<befund>-<kurz-id>, gültig für git. */
export function fixBranchName(title: string, id: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return `${FIX_BRANCH_PREFIX}fix-${slug || 'befund'}-${id.replace(/-/g, '').slice(0, 8)}`
}

export const isServiceBranch = (branch: string): boolean => branch.startsWith(`${FIX_BRANCH_PREFIX}dienst-`)

/** Etappe 4: airlock/dienst-<neu|weg>-<dienst>-<kurz-id> */
export function serviceBranchName(kind: 'add' | 'remove', service: string, id: string): string {
  const s = service.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'dienst'
  return `${FIX_BRANCH_PREFIX}dienst-${kind === 'add' ? 'neu' : 'weg'}-${s}-${id.replace(/-/g, '').slice(0, 8)}`
}

export class GithubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

type Fetch = typeof fetch

export interface ConvertedApp {
  id: number
  slug: string
  name: string
  html_url: string
  client_id: string
  client_secret: string
  webhook_secret: string | null
  pem: string
  owner?: { login?: string }
}

export interface FixPrInput {
  owner: string
  repo: string
  base: string
  branch: string
  title: string
  body: string
  message: string
  files: { path: string; content: string; encoding?: 'utf8' | 'base64' }[]
  delete: string[]
}

export class GitHub {
  private readonly api: string
  private readonly fetch: Fetch
  constructor(o: { api?: string; fetch?: Fetch } = {}) {
    this.api = (o.api ?? 'https://api.github.com').replace(/\/+$/, '')
    this.fetch = o.fetch ?? fetch
  }

  async request<T>(method: string, path: string, auth: { bearer?: string; token?: string } | null, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'airlock',
    }
    if (auth?.bearer) headers.authorization = `Bearer ${auth.bearer}`
    if (auth?.token) headers.authorization = `token ${auth.token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await this.fetch(`${this.api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
    const text = await res.text()
    if (!res.ok) {
      let msg = text.slice(0, 300)
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? msg
      } catch {
        /* kein JSON */
      }
      throw new GithubError(res.status, `GitHub ${method} ${path.split('?')[0]}: ${res.status} ${msg}`)
    }
    return (text ? JSON.parse(text) : {}) as T
  }

  /** Code aus der Manifest-Rückleitung gegen App-Daten tauschen (einmalig, 1 Stunde gültig). */
  async convertManifest(code: string): Promise<ConvertedApp> {
    if (!/^[\w-]{4,100}$/.test(code)) throw new GithubError(400, 'Ungültiger Code aus der Rückleitung')
    return this.request('POST', `/app-manifests/${code}/conversions`, null)
  }

  /** Installation lesen (prüft, dass sie zu dieser App gehört). */
  installation(jwt: string, installationId: string): Promise<{ id: number; account?: { login?: string } }> {
    return this.request('GET', `/app/installations/${encodeURIComponent(installationId)}`, { bearer: jwt })
  }

  /**
   * Installations-Token für einen Vorgang: läuft nach einer Stunde ab, auf
   * die genannten Repos und die beiden Rechte beschränkt.
   */
  async installationToken(jwt: string, installationId: string, repos?: string[]): Promise<{ token: string; expiresAt: string }> {
    const r = await this.request<{ token: string; expires_at: string }>('POST', `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { bearer: jwt }, {
      ...(repos?.length ? { repositories: repos } : {}),
      permissions: { ...GITHUB_PERMISSIONS },
    })
    return { token: r.token, expiresAt: r.expires_at }
  }

  async installationRepos(token: string): Promise<string[]> {
    const out: string[] = []
    for (let page = 1; page <= 10; page++) {
      const r = await this.request<{ repositories: { full_name: string }[]; total_count: number }>('GET', `/installation/repositories?per_page=100&page=${page}`, { token })
      out.push(...r.repositories.map((x) => x.full_name))
      if (out.length >= r.total_count || r.repositories.length < 100) break
    }
    return out
  }

  async defaultBranch(token: string, owner: string, repo: string): Promise<string> {
    return (await this.request<{ default_branch: string }>('GET', `/repos/${owner}/${repo}`, { token })).default_branch
  }

  async branchHead(token: string | null, owner: string, repo: string, branch: string): Promise<string> {
    const r = await this.request<{ object: { sha: string } }>('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, token ? { token } : null)
    return r.object.sha
  }

  /** Alle Pfade eines Stands (Dateien). */
  async tree(token: string, owner: string, repo: string, ref: string): Promise<string[]> {
    const r = await this.request<{ tree: { path: string; type: string }[] }>('GET', `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { token })
    return r.tree.filter((x) => x.type === 'blob').map((x) => x.path)
  }

  /** Inhalt einer Datei als Text (null, wenn es sie nicht gibt). */
  async fileText(token: string, owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    try {
      const r = await this.request<{ content?: string; encoding?: string }>('GET', `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, { token })
      return r.encoding === 'base64' && r.content ? Buffer.from(r.content, 'base64').toString('utf8') : null
    } catch (err) {
      if (err instanceof GithubError && err.status === 404) return null
      throw err
    }
  }

  /**
   * Fix als eigener Branch mit einem Commit und Pull Request – nie auf den
   * Standard-Branch. Über die Git-Data-API: Baum auf dem Stand von base,
   * Commit, Ref, Pull Request.
   */
  async createFixPullRequest(token: string, i: FixPrInput): Promise<{ number: number; url: string; branch: string; commit: string; baseSha: string }> {
    if (i.branch === i.base || !isFixBranch(i.branch)) throw new GithubError(400, 'Fixes nur auf einem eigenen Branch airlock/fix-…')
    return this.branchPullRequest(token, i)
  }

  /**
   * Etappe 4: Änderung an der compose.yaml (Dienst hinzufügen/entfernen) als
   * eigener Branch airlock/dienst-… mit Pull Request – nie direkt in den
   * Hauptbranch.
   */
  async createServicePullRequest(token: string, i: FixPrInput): Promise<{ number: number; url: string; branch: string; commit: string; baseSha: string }> {
    if (i.branch === i.base || !isServiceBranch(i.branch)) throw new GithubError(400, 'Änderungen an Diensten nur auf einem eigenen Branch airlock/dienst-…')
    return this.branchPullRequest(token, i)
  }

  private async branchPullRequest(token: string, i: FixPrInput): Promise<{ number: number; url: string; branch: string; commit: string; baseSha: string }> {
    const repo = `/repos/${i.owner}/${i.repo}`
    const baseSha = await this.branchHead(token, i.owner, i.repo, i.base)
    const baseCommit = await this.request<{ tree: { sha: string } }>('GET', `${repo}/git/commits/${baseSha}`, { token })
    const tree = await this.request<{ sha: string }>('POST', `${repo}/git/trees`, { token }, {
      base_tree: baseCommit.tree.sha,
      tree: [
        ...i.files.map((f) =>
          f.encoding === 'base64'
            ? { path: f.path, mode: '100644', type: 'blob', content: Buffer.from(f.content, 'base64').toString('utf8') }
            : { path: f.path, mode: '100644', type: 'blob', content: f.content }),
        ...i.delete.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null })),
      ],
    })
    const commit = await this.request<{ sha: string }>('POST', `${repo}/git/commits`, { token }, { message: i.message, tree: tree.sha, parents: [baseSha] })
    await this.request('POST', `${repo}/git/refs`, { token }, { ref: `refs/heads/${i.branch}`, sha: commit.sha })
    const pr = await this.request<{ number: number; html_url: string }>('POST', `${repo}/pulls`, { token }, { title: i.title, head: i.branch, base: i.base, body: i.body, maintainer_can_modify: true })
    return { number: pr.number, url: pr.html_url, branch: i.branch, commit: commit.sha, baseSha }
  }

  pull(token: string, owner: string, repo: string, n: number): Promise<{ state: string; merged: boolean; merge_commit_sha: string | null; html_url: string }> {
    return this.request('GET', `/repos/${owner}/${repo}/pulls/${n}`, { token })
  }

  comment(token: string, owner: string, repo: string, n: number, body: string): Promise<unknown> {
    return this.request('POST', `/repos/${owner}/${repo}/issues/${n}/comments`, { token }, { body })
  }
}

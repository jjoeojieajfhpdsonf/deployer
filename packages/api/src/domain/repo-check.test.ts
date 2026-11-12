import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { runRepoCheck, classifyGitError, refPatterns, commitOf, type RepoCheckDeps, type CredentialSecret } from './repo-check.js'
import { GitHub } from '../lib/github.js'
import { lsRemote, type GitAuth } from '../lib/git.js'
import { startGitHttpServer, nonLoopbackIPv4, makeRepo, type GitHttpServer } from '../lib/git-http-fixture.js'
import { generateDeployKey, parseHostKeys } from '../lib/ssh-key.js'
import { AppError } from '../lib/errors.js'

/**
 * Nacht 3, Etappe 2: «Repo erreichbar?» – Abfolge und Meldungen mit
 * Attrappen, dazu ein Durchlauf gegen einen lokalen Git-Server mit
 * gemockter GitHub-API (Installations-Token nur lesend, nur dieses Repo).
 */

const SHA = 'a'.repeat(40)
const ED = 'AAAAC3NzaC1lZDI1NTE5AAAAIL4YROAWh8lwT3fJvYpHN6lQTfVsfMne6rBWf10pmrsA'
const scanned = parseHostKeys(`1.2.3.4 ssh-ed25519 ${ED}`)

function deps(over: Partial<RepoCheckDeps> = {}, calls: { auth?: GitAuth; patterns: string[] }[] = []): RepoCheckDeps {
  return {
    githubRepo: (url) => (/github\.com\/([^/]+)\/([^/.]+)/.exec(url) ? { owner: RegExp.$1, repo: RegExp.$2 } : null),
    githubApp: async () => ({ state: 'kein_app', installUrl: null }),
    readToken: async () => 'ghs_test',
    lsRemote: async (o) => {
      calls.push({ auth: o.auth, patterns: o.patterns })
      return new Map([['HEAD', SHA], ['refs/heads/main', SHA]])
    },
    scanHostKeys: async () => ({ alias: 'gitlab.com', keys: scanned }),
    hostAliasOf: () => 'gitlab.com',
    ...over,
  }
}
const denied = (msg: string) => async () => { throw new AppError('git_failed', `git ist fehlgeschlagen: ${msg}`, 400) }

describe('Repo prüfen: GitHub', () => {
  test('App mit Zugriff: Token nur lesend, ls-remote mit x-access-token', async () => {
    const calls: { auth?: GitAuth; patterns: string[] }[] = []
    let asked = ''
    const r = await runRepoCheck({ repoUrl: 'https://github.com/joel/solar.git', credential: null }, deps({
      githubApp: async () => ({ state: 'zugriff', installUrl: 'https://github.com/apps/a/installations/new' }),
      readToken: async (repo) => { asked = repo; return 'ghs_test' },
    }, calls))
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.via, 'github_app')
    assert.equal(asked, 'solar')
    assert.deepEqual(calls[0]!.auth, { kind: 'https', username: 'x-access-token', token: 'ghs_test' }) // allowlist-secret (Platzhalter der Attrappe)
  })

  test('öffentliches Repo ohne App: ohne Token, wie bisher', async () => {
    const calls: { auth?: GitAuth; patterns: string[] }[] = []
    const r = await runRepoCheck({ repoUrl: 'https://github.com/joel/offen', credential: null }, deps({}, calls))
    assert.equal(r.ok && r.via, 'anonym')
    assert.equal(calls[0]!.auth, undefined)
  })

  test('privat, App ohne Zugriff: klare Meldung mit Link zur Installation', async () => {
    const r = await runRepoCheck({ repoUrl: 'https://github.com/joel/geheim', credential: null }, deps({
      githubApp: async () => ({ state: 'kein_zugriff', installUrl: 'https://github.com/apps/a/installations/new' }),
      lsRemote: denied("could not read Username for 'https://github.com': terminal prompts disabled"),
    }))
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.code, 'github_no_access')
    assert.match(r.message, /Die GitHub-App hat keinen Zugriff auf dieses Repo – in GitHub unter Installation › Repository access freigeben/)
    assert.deepEqual(r.link, { href: 'https://github.com/apps/a/installations/new', label: 'In GitHub freigeben', external: true })
  })

  test('privat, keine App: Hinweis auf Server › GitHub', async () => {
    const r = await runRepoCheck({ repoUrl: 'https://github.com/joel/geheim', credential: null }, deps({ lsRemote: denied('Repository not found') }))
    assert.equal(!r.ok && r.code, 'github_app_missing')
    assert.equal(!r.ok && r.link?.href, '/system/github')
  })

  test('Branch gibt es nicht', async () => {
    const r = await runRepoCheck({ repoUrl: 'https://github.com/joel/offen', ref: 'gibts-nicht', credential: null }, deps({ lsRemote: async () => new Map() }))
    assert.equal(!r.ok && r.code, 'ref_missing')
  })
})

describe('Repo prüfen: Deploy-Key (SSH) und Token', () => {
  const key: CredentialSecret = { kind: 'ssh_key', privateKey: 'PRIV', host: null, knownHosts: null }

  test('SSH-Adresse ohne Deploy-Key: needs_key', async () => {
    const r = await runRepoCheck({ repoUrl: 'git@gitlab.com:joel/app.git', credential: null }, deps())
    assert.equal(!r.ok && r.code, 'needs_key')
  })

  test('erster Kontakt: Server-Schlüssel zeigen statt verbinden (TOFU), zum Merken bereit', async () => {
    const calls: { auth?: GitAuth; patterns: string[] }[] = []
    const r = await runRepoCheck({ repoUrl: 'git@gitlab.com:joel/app.git', credential: key }, deps({}, calls))
    assert.equal(calls.length, 0, 'ohne Bestätigung keine Verbindung mit dem Schlüssel')
    assert.equal(!r.ok && r.code, 'host_key_unknown')
    assert.equal(!r.ok && r.hostKey?.host, 'gitlab.com')
    assert.equal(!r.ok && r.hostKey?.keys[0]?.fingerprint, scanned[0]!.fingerprint)
    assert.match(r.pending!.knownHosts, /^gitlab\.com ssh-ed25519 /)
  })

  test('bestätigter Server: ls-remote mit Schlüssel und known_hosts', async () => {
    const calls: { auth?: GitAuth; patterns: string[] }[] = []
    const kh = `gitlab.com ssh-ed25519 ${ED}\n`
    const r = await runRepoCheck({ repoUrl: 'git@gitlab.com:joel/app.git', credential: { ...key, host: 'gitlab.com', knownHosts: kh } }, deps({}, calls))
    assert.equal(r.ok && r.via, 'deploy_key')
    assert.deepEqual(calls[0]!.auth, { kind: 'ssh', privateKey: 'PRIV', knownHosts: kh })
  })

  test('anderer Server als bestätigt (Adresse geändert): neu bestätigen', async () => {
    const r = await runRepoCheck({ repoUrl: 'git@gitea.lan:joel/app.git', credential: { ...key, host: 'gitlab.com', knownHosts: 'x' } }, deps({ hostAliasOf: () => 'gitea.lan', scanHostKeys: async () => ({ alias: 'gitea.lan', keys: scanned }) }))
    assert.equal(!r.ok && r.code, 'host_key_unknown')
  })

  test('Schlüssel nicht eingetragen: Meldung sagt, wo', async () => {
    const r = await runRepoCheck({ repoUrl: 'git@gitlab.com:joel/app.git', credential: { ...key, host: 'gitlab.com', knownHosts: 'x' } }, deps({ lsRemote: denied('git@gitlab.com: Permission denied (publickey).') }))
    assert.equal(!r.ok && r.code, 'auth_failed')
    assert.match(!r.ok ? r.message : '', /Deploy keys/)
  })

  test('Server-Schlüssel gewechselt: harter Fehler, nie still weiter', async () => {
    const r = await runRepoCheck({ repoUrl: 'git@gitlab.com:joel/app.git', credential: { ...key, host: 'gitlab.com', knownHosts: 'x' } }, deps({ lsRemote: denied('Host key verification failed.') }))
    assert.equal(!r.ok && r.code, 'host_key_changed')
  })

  test('Deploy-Key mit https-Adresse, Token mit http oder ssh: abgelehnt', async () => {
    assert.equal((await runRepoCheck({ repoUrl: 'https://gitlab.com/joel/app.git', credential: key }, deps())).ok, false)
    const tok: CredentialSecret = { kind: 'https_token', username: 'oauth2', token: 'glpat-x' }
    const http = await runRepoCheck({ repoUrl: 'http://gitea.lan/joel/app.git', credential: tok }, deps())
    assert.equal(!http.ok && http.code, 'url')
    assert.match(!http.ok ? http.message : '', /https/)
    assert.equal((await runRepoCheck({ repoUrl: 'git@gitlab.com:joel/app.git', credential: tok }, deps())).ok, false)
  })

  test('Token abgelehnt', async () => {
    const r = await runRepoCheck({ repoUrl: 'https://gitlab.com/joel/app.git', credential: { kind: 'https_token', username: 'oauth2', token: 'glpat-x' } }, deps({ lsRemote: denied('HTTP Basic: Access denied') }))
    assert.equal(!r.ok && r.code, 'auth_failed')
  })

  test('anderer Anbieter ohne Zugang, privat: Hinweis auf Deploy-Key/Token', async () => {
    const r = await runRepoCheck({ repoUrl: 'https://gitlab.com/joel/app.git', credential: null }, deps({ lsRemote: denied('Authentication failed') }))
    assert.equal(!r.ok && r.code, 'not_found')
    assert.match(!r.ok ? r.message : '', /Deploy-Key oder ein Token/)
  })
})

describe('Repo prüfen: Hilfen', () => {
  test('Fehler einordnen', () => {
    assert.equal(classifyGitError('Host key verification failed.'), 'host_key')
    assert.equal(classifyGitError('Permission denied (publickey).'), 'auth')
    assert.equal(classifyGitError('remote: Repository not found.'), 'not_found')
    assert.equal(classifyGitError('ssh: Could not resolve hostname x'), 'unreachable')
    assert.equal(classifyGitError('git wurde nach 30 s abgebrochen'), 'unreachable')
  })

  test('Refs: Branch, Tag (auch annotiert), Commit', () => {
    assert.deepEqual(refPatterns(undefined), ['HEAD'])
    assert.deepEqual(refPatterns(SHA), ['HEAD'])
    assert.deepEqual(refPatterns('v1'), ['refs/heads/v1', 'refs/tags/v1', 'refs/tags/v1^{}'])
    const tag = new Map([['refs/tags/v1', 'b'.repeat(40)], ['refs/tags/v1^{}', 'c'.repeat(40)]])
    assert.equal(commitOf(tag, 'v1'), 'c'.repeat(40))
    assert.equal(commitOf(new Map(), 'main'), undefined)
    assert.equal(commitOf(new Map(), SHA), null)
  })
})

/* --- Durchlauf: lokaler Git-Server + gemockte GitHub-API ------------------------------- */

const ip = nonLoopbackIPv4()
let work: string
let srv: GitHttpServer
let commit: string
const token = `ghs_${randomBytes(27).toString('base64url')}`
const tokenRequests: unknown[] = []

before(async () => {
  if (!ip) return
  work = mkdtempSync(join(tmpdir(), 'airlock-repo-check-'))
  commit = makeRepo(join(work, 'src'), { 'index.html': 'x' })
  execFileSync('git', ['clone', '-q', '--bare', join(work, 'src'), join(work, 'served', 'solar.git')])
  srv = await startGitHttpServer(join(work, 'served'), '0.0.0.0', 0, { auth: { token } })
})
after(async () => {
  if (!ip) return
  await srv.close()
  rmSync(work, { recursive: true, force: true })
})

describe('Durchlauf mit Git-Server und GitHub-Attrappe', { skip: ip ? false : 'keine Netzschnittstelle ausser Loopback' }, () => {
  test('privates Repo: App holt ein Lese-Token, der Server nimmt nur dieses', async () => {
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      if (init?.method === 'POST' && /^\/app\/installations\/42\/access_tokens$/.test(u.pathname)) {
        tokenRequests.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ token, expires_at: '2026-11-13T00:00:00Z' }), { status: 201 })
      }
      return new Response('{"message":"Not Found"}', { status: 404 })
    }) as typeof fetch
    const gh = new GitHub({ api: 'https://api.test', fetch: fakeFetch })
    const policy = { deniedHosts: [], deniedCidrs: [], resolve: async () => [] }
    const repoUrl = `http://${ip}:${srv.port}/solar.git`
    const live: RepoCheckDeps = {
      githubRepo: (url) => (url === repoUrl ? { owner: 'joel', repo: 'solar' } : null),
      githubApp: async () => ({ state: 'zugriff', installUrl: null }),
      readToken: async (repo) => (await gh.readToken('jwt', '42', repo)).token,
      lsRemote: (o) => lsRemote({ ...o, policy }),
      scanHostKeys: async () => { throw new Error('kein SSH') },
      hostAliasOf: () => '',
    }
    const r = await runRepoCheck({ repoUrl, ref: 'main', credential: null }, live)
    assert.deepEqual(r, { ok: true, via: 'github_app', commit, message: `Erreichbar über GitHub-App – «main» steht auf ${commit.slice(0, 7)}.` })
    // Nur dieses Repo, nur lesen
    assert.deepEqual(tokenRequests[0], { repositories: ['solar'], permissions: { contents: 'read' } })
    // Die Meldung nennt das Token nie
    assert.equal(JSON.stringify(r).includes(token), false)

    // Ohne App (anonym): der Server lehnt ab
    const anon = await runRepoCheck({ repoUrl, credential: null }, { ...live, githubApp: async () => ({ state: 'kein_zugriff', installUrl: 'https://github.test/apps/a/installations/new' }) })
    assert.equal(!anon.ok && anon.code, 'github_no_access')
  })
})

describe('Deploy-Key', () => {
  test('neuer Schlüssel je Aufruf, Kommentar ohne Sonderzeichen', () => {
    const a = generateDeployKey('airlock homeserver/solar 2026')
    const b = generateDeployKey('x')
    assert.notEqual(a.publicKey, b.publicKey)
    assert.match(a.publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]+=* airlock-homeserver-solar-2026$/)
  })
})

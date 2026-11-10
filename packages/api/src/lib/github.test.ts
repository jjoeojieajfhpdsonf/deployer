import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { GitHub, GithubError, appJwt, githubManifest, githubRepoOf, manifestFormAction, fixBranchName, GITHUB_PERMISSIONS } from './github.js'

/**
 * GitHub-Attrappe: ein fetch, der Aufrufe mitschreibt und je Pfad antwortet.
 * Kein Netz, keine echte App.
 */
function fake(routes: Record<string, (body: unknown, headers: Record<string, string>) => [number, unknown]>) {
  const calls: { method: string; path: string; body: unknown; auth: string | undefined }[] = []
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname + u.search, body, auth: headers.authorization })
    const key = `${method} ${u.pathname}`
    const h = routes[key] ?? Object.entries(routes).find(([k]) => new RegExp(`^${k.replace(/:\w+/g, '[^/]+')}$`).test(key))?.[1]
    const [status, out] = h ? h(body, headers) : [404, { message: 'Not Found' }]
    return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetch: f, calls }
}

describe('GitHub App: Manifest und JWT', () => {
  test('Manifest: nur Contents und Pull requests (write), kein Webhook, nicht öffentlich', () => {
    const m = githubManifest({ name: 'deployer thinkpad ab12', deployerUrl: 'https://deployer.int.example.ch/' })
    assert.deepEqual(m.default_permissions, { contents: 'write', pull_requests: 'write' })
    assert.deepEqual(m.default_events, [])
    assert.equal(m.public, false)
    assert.ok(!('hook_attributes' in m), 'kein Webhook')
    assert.equal(m.redirect_url, 'https://deployer.int.example.ch/api/v1/github/manifest/callback')
    assert.equal(m.setup_url, 'https://deployer.int.example.ch/api/v1/github/setup/callback')
    assert.equal(manifestFormAction('https://github.com', 'abc', null), 'https://github.com/settings/apps/new?state=abc')
    assert.equal(manifestFormAction('https://github.com', 'abc', 'meine-org'), 'https://github.com/organizations/meine-org/settings/apps/new?state=abc')
  })

  test('JWT: RS256, iss = App-ID, höchstens 10 Minuten, prüfbar mit dem öffentlichen Schlüssel', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    const jwt = appJwt('12345', privateKey, 1_800_000_000)
    const [h, b, s] = jwt.split('.')
    assert.deepEqual(JSON.parse(Buffer.from(h!, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' })
    const claims = JSON.parse(Buffer.from(b!, 'base64url').toString())
    assert.equal(claims.iss, '12345')
    assert.ok(claims.exp - claims.iat <= 600)
    assert.ok(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s!, 'base64url')))
  })

  test('Repo aus URL, nur github.com', () => {
    assert.deepEqual(githubRepoOf('https://github.com/joel/solar.git'), { owner: 'joel', repo: 'solar' })
    assert.equal(githubRepoOf('https://gitlab.com/joel/solar'), null)
    assert.equal(githubRepoOf('https://github.com/joel'), null)
  })

  test('Branch: deployer/fix-<befund>-<kurz-id>', () => {
    assert.equal(fixBranchName('Container läuft als root', '9f3a1c22-7d40-4e8b-9b1a-0c2d6e8f4a17'), 'deployer/fix-container-lauft-als-root-9f3a1c22')
    assert.match(fixBranchName('!!!', 'abcdef12-0000'), /^deployer\/fix-befund-abcdef12$/)
  })
})

describe('GitHub-Attrappe: Abläufe', () => {
  test('Manifest-Code gegen App-Daten tauschen (ohne Anmeldung, wie GitHub es verlangt)', async () => {
    const g = fake({ 'POST /app-manifests/:code/conversions': () => [201, { id: 7, slug: 'deployer-x', name: 'deployer x', html_url: 'https://github.com/apps/deployer-x', client_id: 'Iv1', client_secret: 'sec', webhook_secret: null, pem: '-----BEGIN RSA PRIVATE KEY-----' }] })
    const app = await new GitHub({ api: 'https://api.test', fetch: g.fetch }).convertManifest('abc123')
    assert.equal(app.slug, 'deployer-x')
    assert.equal(g.calls[0]!.auth, undefined)
    await assert.rejects(() => new GitHub({ api: 'https://api.test', fetch: g.fetch }).convertManifest('../x'), GithubError)
  })

  test('Installations-Token: auf ein Repo und genau die beiden Rechte beschränkt', async () => {
    const g = fake({ 'POST /app/installations/:id/access_tokens': () => [201, { token: 'ghs_x', expires_at: '2026-11-10T20:00:00Z' }] })
    const t = await new GitHub({ api: 'https://api.test', fetch: g.fetch }).installationToken('jwt', '42', ['solar'])
    assert.equal(t.token, 'ghs_x')
    assert.deepEqual(g.calls[0]!.body, { repositories: ['solar'], permissions: { ...GITHUB_PERMISSIONS } })
    assert.equal(g.calls[0]!.auth, 'Bearer jwt')
  })

  test('Fix als Branch mit Commit und Pull Request – nie auf den Standard-Branch', async () => {
    const g = fake({
      'GET /repos/joel/solar/git/ref/heads/main': () => [200, { object: { sha: 'base000' } }],
      'GET /repos/joel/solar/git/commits/base000': () => [200, { tree: { sha: 'tree000' } }],
      'POST /repos/joel/solar/git/trees': () => [201, { sha: 'tree111' }],
      'POST /repos/joel/solar/git/commits': () => [201, { sha: 'commit111' }],
      'POST /repos/joel/solar/git/refs': () => [201, {}],
      'POST /repos/joel/solar/pulls': () => [201, { number: 5, html_url: 'https://github.com/joel/solar/pull/5' }],
    })
    const gh = new GitHub({ api: 'https://api.test', fetch: g.fetch })
    const pr = await gh.createFixPullRequest('ghs_x', {
      owner: 'joel', repo: 'solar', base: 'main', branch: 'deployer/fix-root-12345678', title: 'Fix: root', body: 'b', message: 'm',
      files: [{ path: 'Dockerfile', content: 'FROM x\nUSER node\n' }], delete: ['backup.sql'],
    })
    assert.equal(pr.number, 5)
    const tree = g.calls.find((c) => c.path.endsWith('/git/trees'))!.body as { base_tree: string; tree: { path: string; sha?: null }[] }
    assert.equal(tree.base_tree, 'tree000')
    assert.deepEqual(tree.tree.map((t) => [t.path, t.sha === null ? 'löschen' : 'schreiben']), [['Dockerfile', 'schreiben'], ['backup.sql', 'löschen']])
    assert.deepEqual(g.calls.find((c) => c.path.endsWith('/git/refs'))!.body, { ref: 'refs/heads/deployer/fix-root-12345678', sha: 'commit111' })
    assert.equal((g.calls.find((c) => c.path.endsWith('/pulls'))!.body as { base: string; head: string }).base, 'main')
    assert.ok(!g.calls.some((c) => c.method === 'PATCH' || c.path.includes('/git/refs/heads/main')), 'Standard-Branch wird nie geändert')
    assert.ok(g.calls.every((c) => c.auth === 'token ghs_x'))
    await assert.rejects(() => gh.createFixPullRequest('t', { owner: 'o', repo: 'r', base: 'main', branch: 'main', title: '', body: '', message: '', files: [], delete: [] }), /eigenen Branch/)
  })

  test('Fehler von GitHub kommen mit Status und Meldung', async () => {
    const g = fake({ 'GET /repos/joel/solar/pulls/9': () => [403, { message: 'Resource not accessible by integration' }] })
    await assert.rejects(() => new GitHub({ api: 'https://api.test', fetch: g.fetch }).pull('t', 'joel', 'solar', 9), (e: unknown) => e instanceof GithubError && e.status === 403 && /not accessible/.test(e.message))
  })
})

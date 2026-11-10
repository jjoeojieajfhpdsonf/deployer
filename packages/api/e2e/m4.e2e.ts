import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { BASE, env, login, api, deleteByPrefix, createProject, waitDeployment, get, host, docker } from './lib.js'

/**
 * Meilenstein 4 im lokalen Stack, so weit ohne Domain und Cloudflare möglich:
 * TLS ist aus (TLS_MODE=off). Geprüft wird, was davon unabhängig ist –
 * LAN und Tailnet unter einem Namen, die Migration, das Cookie.
 */

const P = 'e2e-m4-'

before(async () => {
  await login()
  await deleteByPrefix(P)
})
after(() => deleteByPrefix(P))

describe('M4: LAN und Tailnet', () => {
  let id = ''
  let slug = ''

  test('LAN + Tailnet: ein Name, eine Adresse, erreichbar', async () => {
    const p = await createProject({ name: `${P}beide`, slug: `${P}beide`, source: { type: 'image', image: 'traefik/whoami:v1.10.1' }, port: 80, targets: ['lan', 'tailnet'] })
    id = p.id
    slug = p.slug
    assert.equal((await waitDeployment(p.deploymentId)).status, 'active')
    const r = await api('GET', `/projects/${id}`)
    const routes = r.data.project.routes
    assert.equal(routes.length, 1, JSON.stringify(routes))
    assert.deepEqual([...routes[0].targets].sort(), ['lan', 'tailnet'])
    assert.equal(new Set(routes[0].urls).size, routes[0].urls.length, 'keine doppelten Adressen')
    assert.equal((await get(host(slug))).status, 200)
  })

  test('in der Datenbank: zwei Zeilen mit demselben Namen', () => {
    const rows = docker('exec', 'airlock-postgres', 'psql', '-U', 'airlock', '-d', 'airlock', '-tAc',
      `SELECT target || '=' || hostname FROM routes r JOIN projects p ON p.id = r.project_id WHERE p.slug = '${slug}' ORDER BY target`).split('\n')
    assert.equal(rows.length, 2)
    assert.equal(rows[0]!.split('=')[1], rows[1]!.split('=')[1])
  })

  test('nur Tailnet geht, public wird mit Hinweis auf M5 abgelehnt', async () => {
    const t = await api('PUT', `/projects/${id}/routes`, { targets: ['tailnet'] })
    assert.equal(t.status, 200, JSON.stringify(t.data))
    assert.deepEqual(t.data.project.routes[0].targets, ['tailnet'])
    const pub = await api('PUT', `/projects/${id}/routes`, { targets: ['public'] })
    assert.equal(pub.status, 400)
    assert.match(pub.data.error.message, /Meilenstein 5/)
    await api('PUT', `/projects/${id}/routes`, { targets: ['lan'] })
  })

  test('derselbe Name für ein zweites Projekt: abgelehnt, auch unter anderem Ziel', async () => {
    const p2 = await createProject({ name: `${P}zwei`, slug: `${P}zwei`, source: { type: 'image', image: 'traefik/whoami:v1.10.1' }, port: 80, targets: ['tailnet'] })
    await waitDeployment(p2.deploymentId)
    const r = await api('PUT', `/projects/${p2.id}/routes`, { targets: ['tailnet'], subdomain: slug })
    assert.equal(r.status, 409, JSON.stringify(r.data))
  })

  test('Systemstatus meldet TLS aus', async () => {
    const r = await api('GET', '/system/status')
    assert.equal(r.data.tls.mode, 'off')
    assert.equal(r.data.tls.cert, null)
  })
})

describe('M4: Cookie', () => {
  test('über HTTP kein Secure; ein vom Client vorgetäuschtes X-Forwarded-Proto ändert das nicht', async () => {
    for (const headers of [{}, { 'x-forwarded-proto': 'https' }]) {
      const res = await fetch(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
      })
      assert.equal(res.status, 200)
      // Caddy überschreibt X-Forwarded-Proto mit dem tatsächlichen Schema (http).
      assert.doesNotMatch(res.headers.get('set-cookie') ?? '', /;\s*Secure/i)
    }
  })

  test('Tailnet-DNS ohne Konfiguration: klare Ablehnung', async () => {
    const r = await api('POST', '/system/tailnet-dns')
    assert.equal(r.status, 400)
    assert.match(r.data.error.message, /TLS_MODE=cloudflare/)
  })
})

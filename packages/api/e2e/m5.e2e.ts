import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { BASE, env, login, api, deleteByPrefix, createProject, waitDeployment, sleep, docker } from './lib.js'
import { startFakeCloudflare, type FakeCloudflare } from '../src/lib/cf-fixture.js'

/**
 * Meilenstein 5 gegen eine Cloudflare-Attrappe auf dem Host. Läuft nur mit
 * E2E_CF_FAKE=1, also wenn der Stack mit e2e/compose.cf-fake.yaml gestartet
 * wurde (`pnpm --filter @airlock/api e2e:cf`). Sonst übersprungen.
 *
 * Echte Cloudflare-API, echter Tunnel, echte Domain: nicht getestet.
 */

const enabled = env.E2E_CF_FAKE === '1'
const P = 'e2e-m5-'
const TUNNEL = '00000000-0000-4000-8000-00000000e2e5'
let fake: FakeCloudflare
let token = ''
let tokenId = ''

/** GET über Caddy auf dem Host mit beliebigem Host-Header (fetch erlaubt das nicht). */
function viaCaddy(hostHeader: string, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: 80, path, headers: { host: hostHeader }, timeout: 5000 }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }))
    })
    req.on('error', () => resolve({ status: 0, body: '' }))
    req.end()
  })
}

async function waitScanDone(projectId: string, timeoutMs = 600_000): Promise<any> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const r = await api('GET', `/projects/${projectId}/scans/latest`)
    if (r.data.report && r.data.report.scan.status === 'done') return r.data.report
    await sleep(3000)
  }
  throw new Error('Scan nicht fertig')
}

async function mcp() {
  const c = new Client({ name: 'e2e-m5', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await c.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean }
    const text = r.content.find((x) => x.type === 'text')?.text ?? ''
    let data: any = text
    try { data = JSON.parse(text) } catch { /* Text */ }
    return { isError: Boolean(r.isError), data }
  }
  return { c, call }
}

const records = () => [...fake.records.values()]
const cname = (name: string) => records().find((r) => r.name === name && r.type === 'CNAME')

describe('M5: öffentlich über Cloudflare (Attrappe)', { skip: !enabled && 'nur mit E2E_CF_FAKE=1 (pnpm e2e:cf)' }, () => {
  let id = ''
  let slug = ''

  before(async () => {
    fake = await startFakeCloudflare(['example.ch', 'beispiel.ch'], { host: '0.0.0.0', port: 18787 })
    // Eine fremde Tunnel-Regel, die Airlock nie anfassen darf.
    fake.ingress = [{ hostname: 'ha.example.ch', service: 'http://192.168.1.5:8123' }, { service: 'http_status:404' }]
    // Platzhalter für cloudflared im edge-Netz: Caddy lässt öffentliche Namen
    // nur von dessen Adresse zu (lokal ist der IP-Filter aus, aber ohne
    // cloudflared gäbe es gar keine öffentliche Route).
    try { docker('rm', '-f', 'airlock-cloudflared') } catch { /* gab es nicht */ }
    docker('run', '-d', '--name', 'airlock-cloudflared', '--network', 'airlock_edge', 'busybox:1.36', 'sleep', '3600')
    await login()
    await deleteByPrefix(P)
    const t = await api('POST', '/tokens', { name: 'e2e-m5' })
    token = t.data.token
    tokenId = t.data.apiToken.id
  })
  after(async () => {
    await deleteByPrefix(P)
    if (tokenId) await api('DELETE', `/tokens/${tokenId}`)
    try { docker('rm', '-f', 'airlock-cloudflared') } catch { /* schon weg */ }
    await fake?.close()
  })

  test('Domains: Zonen abgleichen, Standard setzen; mit Token nicht änderbar', async () => {
    const s = await api('POST', '/domains/sync')
    assert.equal(s.status, 200, JSON.stringify(s.data))
    assert.deepEqual(s.data.domains.map((d: any) => d.name), ['beispiel.ch', 'example.ch'])
    const d = await api('PUT', '/domains/default', { name: 'example.ch' })
    assert.equal(d.data.domains.find((x: any) => x.isDefault).name, 'example.ch')
    const viaToken = await fetch(`${BASE}/api/v1/domains/default`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"name":"beispiel.ch"}' })
    assert.equal(viaToken.status, 403)
    assert.equal((await api('GET', '/domains')).data.publicEnabled, true)
  })

  test('ohne abgeschlossenen Scan: abgelehnt, interne Ziele unverändert', async () => {
    const p = await createProject({ name: `${P}web`, slug: `${P}web`, source: { type: 'image', image: 'traefik/whoami:v1.10.1' }, port: 80, targets: ['lan'] })
    id = p.id
    slug = p.slug
    assert.equal((await waitDeployment(p.deploymentId)).status, 'active')
    const r = await api('PUT', `/projects/${id}/routes`, { targets: ['public'] })
    assert.equal(r.status, 409, JSON.stringify(r.data))
    assert.equal(r.data.error.code, 'not_publishable')
    const pr = await api('GET', `/projects/${id}`)
    assert.deepEqual(pr.data.project.routes.map((x: any) => x.target), ['lan'], 'LAN-Route muss bleiben')
    assert.equal(cname(`${slug}.example.ch`), undefined)
  })

  test('nach dem Scan (kritische Befunde akzeptiert): öffentlich mit CNAME, Ingress, Caddy-Route', async () => {
    const rep = await waitScanDone(id)
    for (const f of rep.findings.filter((x: any) => x.status === 'open' && x.severity === 'critical')) {
      await api('PATCH', `/findings/${f.id}`, { status: 'accepted', reason: 'Test: Attrappe' })
    }
    const r = await api('PUT', `/projects/${id}/routes`, { targets: ['lan', 'public'] })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    const host = `${slug}.example.ch`
    const pub = r.data.project.routes.find((x: any) => x.target === 'public')
    assert.deepEqual(pub.urls, [`https://${host}`])
    const rec = cname(host)!
    assert.ok(rec, 'CNAME fehlt')
    assert.equal(rec.content, `${TUNNEL}.cfargotunnel.com`)
    assert.equal(rec.proxied, true)
    assert.equal(rec.comment, 'managed by airlock')
    assert.deepEqual(fake.ingress, [
      { hostname: host, service: 'http://caddy:80' },
      { hostname: 'ha.example.ch', service: 'http://192.168.1.5:8123' },
      { service: 'http_status:404' },
    ])
    // Caddy kennt den öffentlichen Namen (lokal ohne IP-Filter erreichbar).
    let res = { status: 0, body: '' }
    for (let i = 0; i < 10 && res.status !== 200; i++) { res = await viaCaddy(host); if (res.status !== 200) await sleep(500) }
    assert.equal(res.status, 200)
    assert.match(res.body, /Hostname:/)
    const audit = await api('GET', '/audit?limit=50')
    assert.ok(audit.data.events.some((e: any) => e.action === 'project.public'))
  })

  test('Access an und aus', async () => {
    const on = await api('PUT', `/projects/${id}/routes`, { targets: ['lan', 'public'], accessProtected: true })
    assert.equal(on.status, 200, JSON.stringify(on.data))
    assert.equal(fake.apps.length, 1)
    assert.equal(fake.apps[0]!.domain, `${slug}.example.ch`)
    assert.match(JSON.stringify(fake.apps[0]!.policies), /joel@test\.example/)
    // Ohne Angabe bleibt Access, und der Name bleibt (Review M5)
    const again = await api('PUT', `/projects/${id}/routes`, { targets: ['lan', 'tailnet', 'public'] })
    assert.equal(again.status, 200, JSON.stringify(again.data))
    assert.equal(fake.apps.length, 1, 'Access darf nicht still wegfallen')
    assert.ok(cname(`${slug}.example.ch`), 'Name darf nicht wechseln')
    const off = await api('PUT', `/projects/${id}/routes`, { targets: ['lan', 'public'], accessProtected: false })
    assert.equal(off.status, 200)
    assert.equal(fake.apps.length, 0)
  })

  test('Umbenennen in eine andere Zone: alter CNAME weg, neuer da, Ingress nachgezogen', async () => {
    const r = await api('PUT', `/projects/${id}/routes`, { targets: ['lan', 'public'], publicHostname: `${slug}.beispiel.ch` })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(cname(`${slug}.example.ch`), undefined)
    assert.ok(cname(`${slug}.beispiel.ch`))
    assert.deepEqual(fake.ingress.map((x) => x.hostname), [`${slug}.beispiel.ch`, 'ha.example.ch', undefined])
  })

  test('fremder DNS-Eintrag gleichen Namens: 409, nichts überschrieben', async () => {
    const zone = fake.zones.find((z) => z.name === 'example.ch')!
    const foreignId = 'fremd-1'
    fake.records.set(foreignId, { id: foreignId, zoneId: zone.id, type: 'CNAME', name: 'belegt.example.ch', content: 'ghs.example.net', proxied: false })
    const r = await api('PUT', `/projects/${id}/routes`, { targets: ['lan', 'public'], publicHostname: 'belegt.example.ch' })
    assert.equal(r.status, 409, JSON.stringify(r.data))
    assert.equal(fake.records.get(foreignId)!.content, 'ghs.example.net')
    assert.ok(cname(`${slug}.beispiel.ch`), 'bisheriger Name bleibt')
  })

  test('scheitert public, bleiben die internen Ziele unverändert (Review M5)', async () => {
    const before = (await api('GET', `/projects/${id}`)).data.project.routes.map((r: any) => r.targets).flat().sort()
    const r = await api('PUT', `/projects/${id}/routes`, { targets: ['tailnet', 'public'], publicHostname: 'a.b.example.ch' })
    assert.equal(r.status, 400)
    const after = (await api('GET', `/projects/${id}`)).data.project.routes.map((r: any) => r.targets).flat().sort()
    assert.deepEqual(after, before)
  })

  test('unzulässige Namen: intern, Apex, zweite Ebene, fremde Zone', async () => {
    for (const h of [`x.${env.INTERNAL_BASE_DOMAIN || 'int.example.ch'}`, 'example.ch', 'a.b.example.ch', 'x.fremd.ch']) {
      const r = await api('PUT', `/projects/${id}/routes`, { targets: ['lan', 'public'], publicHostname: h })
      assert.ok([400, 409].includes(r.status), `${h}: ${r.status} ${JSON.stringify(r.data)}`)
    }
  })

  test('REST mit Token darf nicht öffentlich schalten; MCP nur mit Bestätigung', async () => {
    const viaToken = await fetch(`${BASE}/api/v1/projects/${id}/routes`, {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ targets: ['lan', 'public'], publicSubdomain: 'per-token' }),
    })
    assert.equal(viaToken.status, 403)

    const { c, call } = await mcp()
    const first = await call('set_targets', { project: slug, targets: ['lan', 'public'], public_subdomain: `${slug}-mcp` })
    assert.ok(first.data.confirmation_token, JSON.stringify(first.data))
    assert.equal(cname(`${slug}-mcp.example.ch`), undefined, 'ohne Bestätigung nichts angelegt')
    const second = await call('set_targets', { project: slug, targets: ['lan', 'public'], public_subdomain: `${slug}-mcp`, confirmation_token: first.data.confirmation_token })
    assert.equal(second.isError, false, JSON.stringify(second.data))
    assert.ok(cname(`${slug}-mcp.example.ch`))

    const create = await call('create_project', { name: `${P}gleich-public`, source: { type: 'image', image: 'traefik/whoami:v1.10.1' }, port: 80, targets: ['public'] })
    assert.equal(create.isError, true)
    assert.match(String(create.data), /ersten Scan/)

    const dom = await call('list_domains', {})
    assert.deepEqual(dom.data.domains.find((d: any) => d.default).name, 'example.ch')
    await c.close()
  })

  test('public entfernen: CNAME und Ingress-Regel weg, fremde Regel bleibt', async () => {
    const r = await api('PUT', `/projects/${id}/routes`, { targets: ['lan'] })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(records().filter((x) => x.comment === 'managed by airlock' && x.name.startsWith(slug)).length, 0)
    assert.deepEqual(fake.ingress, [{ hostname: 'ha.example.ch', service: 'http://192.168.1.5:8123' }, { service: 'http_status:404' }])
  })

  test('Löschen eines öffentlichen Projekts räumt bei Cloudflare auf', async () => {
    await api('PUT', `/projects/${id}/routes`, { targets: ['lan', 'public'], accessProtected: true })
    assert.ok(cname(`${slug}.example.ch`))
    assert.equal(fake.apps.length, 1)
    const d = await api('DELETE', `/projects/${id}?purge=true`)
    assert.equal(d.status, 204)
    assert.equal(cname(`${slug}.example.ch`), undefined)
    assert.equal(fake.apps.length, 0)
    assert.deepEqual(fake.ingress.map((x) => x.hostname), ['ha.example.ch', undefined])
  })
})

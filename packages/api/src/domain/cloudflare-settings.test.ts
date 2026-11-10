import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeCloudflare, type FakeCloudflare } from '../lib/cf-fixture.js'

/** Cloudflare verbinden: Token-Prüfung ohne Seiteneffekte, Vorlagen-Link. */

let fake: FakeCloudflare
let mod: typeof import('./cloudflare-settings.js')

before(async () => {
  process.env.DATABASE_URL ??= 'postgres://x@localhost/x'
  process.env.ADMIN_PASSWORD ??= 'x'
  fake = await startFakeCloudflare(['example.ch', 'beispiel.ch'])
  process.env.CLOUDFLARE_API_BASE = fake.url
  mod = await import('./cloudflare-settings.js')
})
after(() => fake.close())

describe('checkToken', () => {
  test('alle Rechte: vollständig, Zonen mit DNS-Recht, nichts angelegt', async () => {
    const r = await mod.checkToken(fake.token)
    assert.equal(r.valid, true)
    assert.equal(r.complete, true)
    assert.deepEqual(r.zones.map((z) => [z.name, z.dnsEdit]), [['example.ch', true], ['beispiel.ch', true]])
    assert.equal(r.accounts[0]?.id, 'acc-e2e-test')
    assert.equal(fake.records.size, 0)
    assert.equal(fake.tunnels.length, 0)
    assert.equal(fake.apps.length, 0)
  })

  test('fehlendes Tunnel-Recht wird konkret genannt, Access bleibt optional', async () => {
    fake.perms = new Set(['zone_read', 'dns_edit'])
    const r = await mod.checkToken(fake.token)
    assert.equal(r.complete, false)
    const tunnel = r.permissions.find((p) => p.key === 'tunnel_edit')!
    assert.equal(tunnel.ok, false)
    assert.match(tunnel.detail ?? '', /Joëls Konto/)
    assert.match(r.message ?? '', /Cloudflare Tunnel/)
    assert.doesNotMatch(r.message ?? '', /Access/)
    fake.perms = new Set(['zone_read', 'dns_edit', 'tunnel_edit', 'access_edit'])
  })

  test('ohne Zonen-Recht: Zone und DNS fehlen', async () => {
    fake.perms = new Set(['tunnel_edit'])
    const r = await mod.checkToken(fake.token)
    assert.equal(r.permissions.find((p) => p.key === 'zone_read')!.ok, false)
    assert.equal(r.permissions.find((p) => p.key === 'dns_edit')!.ok, false)
    fake.perms = new Set(['zone_read', 'dns_edit', 'tunnel_edit', 'access_edit'])
  })

  test('falsches Token: ungültig mit Hinweis, kein Token im Text', async () => {
    const r = await mod.checkToken('x'.repeat(40))
    assert.equal(r.valid, false)
    assert.match(r.message ?? '', /kennt dieses Token nicht/)
    assert.doesNotMatch(r.message ?? '', /xxxx/)
  })
})

test('Vorlagen-Link enthält die Rechte und den Namen', () => {
  const u = new URL(mod.tokenTemplateUrl())
  assert.equal(u.hostname, 'dash.cloudflare.com')
  const groups = JSON.parse(u.searchParams.get('permissionGroupKeys')!) as { key: string; type: string }[]
  assert.deepEqual(groups.map((g) => g.key), ['zone', 'dns', 'argotunnel', 'access'])
  assert.equal(u.searchParams.get('name'), 'airlock')
})

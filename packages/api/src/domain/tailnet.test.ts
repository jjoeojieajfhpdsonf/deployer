import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Cloudflare } from '../drivers/cloudflare.js'
import { startFakeCloudflare, type FakeCloudflare } from '../lib/cf-fixture.js'

/** M4: Tailnet-Eintrag, Startprüfung für TLS, HTTPS-Erkennung fürs Cookie. */

let fake: FakeCloudflare
let mod: typeof import('./tailnet.js')
let cfgMod: typeof import('../config.js')
let authMod: typeof import('../http/auth.js')

before(async () => {
  process.env.DATABASE_URL ??= 'postgres://x@localhost/x'
  process.env.ADMIN_PASSWORD ??= 'x'
  fake = await startFakeCloudflare(['example.ch'])
  mod = await import('./tailnet.js')
  cfgMod = await import('../config.js')
  authMod = await import('../http/auth.js')
})
after(() => fake.close())

describe('ensureWildcardRecord (Attrappe)', () => {
  // audit() schreibt in die Datenbank; die gibt es hier nicht. Nur der Fall
  // "unverändert" kommt ohne Audit aus – deshalb legen die Tests den
  // Eintrag direkt an und prüfen danach.
  test('findet die Zone über die Basisdomain und erkennt einen gleichen Eintrag', async () => {
    const cf = new Cloudflare({ token: fake.token, base: fake.url })
    await cf.createRecord('zone-example.ch', { type: 'A', name: '*.int.example.ch', content: '100.101.1.2', proxied: false, comment: 'managed by deployer' })
    const r = await mod.ensureWildcardRecord(cf, 'int.example.ch', '100.101.1.2', 'test')
    assert.equal(r.action, 'unchanged')
    assert.equal(r.zone, 'example.ch')
    assert.equal(r.name, '*.int.example.ch')
    const recs = [...fake.records.values()].filter((x) => x.name === '*.int.example.ch')
    assert.equal(recs.length, 1)
    assert.equal(recs[0]!.proxied, false, 'Tailnet-Eintrag darf nicht proxied sein')
  })

  test('keine passende Zone: klare Meldung', async () => {
    const cf = new Cloudflare({ token: fake.token, base: fake.url })
    await assert.rejects(mod.ensureWildcardRecord(cf, 'int.fremd.ch', '100.101.1.2', 'test'), /Keine Cloudflare-Zone für int\.fremd\.ch/)
  })
})

describe('tlsProblems (Startprüfung)', () => {
  test('TLS aus: keine Anforderungen', () => {
    assert.deepEqual(cfgMod.tlsProblems({ TLS_MODE: 'off', INTERNAL_BASE_DOMAIN: null, CLOUDFLARE_API_TOKEN_FILE: '/gibt/es/nicht' }), [])
  })
  test('TLS an ohne Basisdomain und ohne Token-Datei: zwei Meldungen', () => {
    const p = cfgMod.tlsProblems({ TLS_MODE: 'cloudflare', INTERNAL_BASE_DOMAIN: null, CLOUDFLARE_API_TOKEN_FILE: '/gibt/es/nicht' })
    assert.equal(p.length, 2)
    assert.match(p[0]!, /INTERNAL_BASE_DOMAIN/)
    assert.match(p[1]!, /Cloudflare-Token/)
  })
  test('leere Token-Datei wird erkannt; gefüllte genügt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deployer-tok-'))
    try {
      const f = join(dir, 't')
      writeFileSync(f, '\n')
      assert.match(cfgMod.tlsProblems({ TLS_MODE: 'cloudflare', INTERNAL_BASE_DOMAIN: 'int.example.ch', CLOUDFLARE_API_TOKEN_FILE: f })[0]!, /leer/)
      writeFileSync(f, 'abc\n')
      assert.deepEqual(cfgMod.tlsProblems({ TLS_MODE: 'cloudflare', INTERNAL_BASE_DOMAIN: 'int.example.ch', CLOUDFLARE_API_TOKEN_FILE: f }), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('viaHttps (Secure-Cookie)', () => {
  const req = (h: Record<string, string | string[] | undefined>) => ({ headers: h }) as never
  test('nur X-Forwarded-Proto: https zählt', () => {
    assert.equal(authMod.viaHttps(req({ 'x-forwarded-proto': 'https' })), true)
    assert.equal(authMod.viaHttps(req({ 'x-forwarded-proto': 'http' })), false)
    assert.equal(authMod.viaHttps(req({})), false)
    assert.equal(authMod.viaHttps(req({ 'x-forwarded-proto': 'https, http' })), true)
  })
})

describe('Review M4: Ziele und Adressen', () => {
  test('isTailnetIp: nur gültige IPv4 in 100.64.0.0/10', () => {
    for (const ok of ['100.64.0.1', '100.101.102.103', '100.127.255.255']) assert.equal(cfgMod.isTailnetIp(ok), true, ok)
    for (const bad of ['100.64.999.1', '100.63.1.1', '100.128.0.1', '10.0.0.1', 'fd7a:115c::1', '']) assert.equal(cfgMod.isTailnetIp(bad), false, bad)
  })
  test('cidrsForTargets: LAN-Projekt nicht aus dem Tailnet und umgekehrt', async () => {
    const { cidrsForTargets } = await import('./routes.js')
    const lan = '192.168.1.0/24', ts = '100.64.0.0/10'
    assert.deepEqual(cidrsForTargets(['lan'], lan, ts), [lan, '127.0.0.0/8', '::1/128'])
    assert.deepEqual(cidrsForTargets(['tailnet'], lan, ts), [ts, '127.0.0.0/8', '::1/128'])
    assert.deepEqual(cidrsForTargets(['lan', 'tailnet'], lan, ts), [lan, ts, '127.0.0.0/8', '::1/128'])
  })
})

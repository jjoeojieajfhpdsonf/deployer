import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Cloudflare, CloudflareError, zoneFor, upsertManagedRecord, MANAGED_COMMENT } from './cloudflare.js'
import { startFakeCloudflare, type FakeCloudflare } from '../lib/cf-fixture.js'

let fake: FakeCloudflare
let cf: Cloudflare

before(async () => {
  fake = await startFakeCloudflare()
  cf = new Cloudflare({ token: fake.token, base: fake.url })
})
after(() => fake.close())

describe('zoneFor', () => {
  const zones = [{ id: '1', name: 'example.ch' }, { id: '2', name: 'int.example.ch' }, { id: '3', name: 'other.ch' }]
  test('längste passende Zone', () => {
    assert.equal(zoneFor('foo.int.example.ch', zones)?.id, '2')
    assert.equal(zoneFor('foo.example.ch', zones)?.id, '1')
    assert.equal(zoneFor('example.ch', zones)?.id, '1')
  })
  test('kein Treffer bei blossem Suffix ohne Punkt', () => {
    assert.equal(zoneFor('badexample.ch', zones), null)
    assert.equal(zoneFor('foo.nicht.ch', zones), null)
  })
})

describe('Cloudflare-Client', () => {
  test('Zonen auflisten', async () => {
    const z = await cf.listZones()
    assert.deepEqual(z.map((x) => x.name), ['example.ch', 'beispiel.ch'])
  })

  test('falsches Token: Fehler ohne das Token in der Meldung', async () => {
    const bad = new Cloudflare({ token: 'geheim-falsch', base: fake.url })
    await assert.rejects(bad.listZones(), (err: unknown) => {
      assert.ok(err instanceof CloudflareError)
      assert.equal(err.status, 403)
      assert.ok(!err.message.includes('geheim-falsch'))
      return true
    })
  })

  test('nicht erreichbar: klare Meldung', async () => {
    const off = new Cloudflare({ token: 'x', base: 'http://127.0.0.1:1' })
    await assert.rejects(off.listZones(), /nicht erreichbar/)
  })
})

describe('upsertManagedRecord', () => {
  const zoneId = 'zone-example.ch'

  test('legt an, nicht proxied, mit Kommentar', async () => {
    const r = await upsertManagedRecord(cf, zoneId, { type: 'A', name: '*.int.example.ch', content: '100.101.102.103', proxied: false })
    assert.equal(r.action, 'created')
    const stored = [...fake.records.values()].find((x) => x.name === '*.int.example.ch')!
    assert.equal(stored.proxied, false)
    assert.equal(stored.comment, MANAGED_COMMENT)
  })

  test('gleiches Ziel: unverändert, kein zweiter Eintrag', async () => {
    const r = await upsertManagedRecord(cf, zoneId, { type: 'A', name: '*.int.example.ch', content: '100.101.102.103', proxied: false })
    assert.equal(r.action, 'unchanged')
    assert.equal([...fake.records.values()].filter((x) => x.name === '*.int.example.ch').length, 1)
  })

  test('neues Ziel: aktualisiert', async () => {
    const r = await upsertManagedRecord(cf, zoneId, { type: 'A', name: '*.int.example.ch', content: '100.64.0.9', proxied: false })
    assert.equal(r.action, 'updated')
    assert.equal([...fake.records.values()].find((x) => x.name === '*.int.example.ch')!.content, '100.64.0.9')
  })

  test('fremder Eintrag wird nicht überschrieben', async () => {
    await cf.createRecord(zoneId, { type: 'CNAME', name: 'blog.example.ch', content: 'ghs.example.net', proxied: true })
    await assert.rejects(
      upsertManagedRecord(cf, zoneId, { type: 'CNAME', name: 'blog.example.ch', content: 't.cfargotunnel.com', proxied: true }),
      (err: unknown) => err instanceof CloudflareError && err.status === 409 && /nicht von Airlock/.test(err.message),
    )
    assert.equal([...fake.records.values()].find((x) => x.name === 'blog.example.ch')!.content, 'ghs.example.net')
  })

  test('Übergang: Eintrag aus der deployer-Zeit gilt als eigener und bekommt den neuen Kommentar', async () => {
    await cf.createRecord(zoneId, { type: 'CNAME', name: 'alt.example.ch', content: 'alt.cfargotunnel.com', proxied: true, comment: 'managed by deployer' })
    const r = await upsertManagedRecord(cf, zoneId, { type: 'CNAME', name: 'alt.example.ch', content: 'neu.cfargotunnel.com', proxied: true })
    assert.equal(r.action, 'updated')
    const stored = [...fake.records.values()].find((x) => x.name === 'alt.example.ch')!
    assert.equal(stored.content, 'neu.cfargotunnel.com')
    assert.equal(stored.comment, MANAGED_COMMENT)
  })

  test('Typwechsel A -> CNAME ersetzt den eigenen Eintrag', async () => {
    await upsertManagedRecord(cf, zoneId, { type: 'A', name: 'x.example.ch', content: '1.2.3.4', proxied: false })
    const r = await upsertManagedRecord(cf, zoneId, { type: 'CNAME', name: 'x.example.ch', content: 't.cfargotunnel.com', proxied: true })
    assert.equal(r.action, 'updated')
    const all = [...fake.records.values()].filter((x) => x.name === 'x.example.ch')
    assert.equal(all.length, 1)
    assert.equal(all[0]!.type, 'CNAME')
  })

  test('Löschen ist idempotent', async () => {
    const r = await upsertManagedRecord(cf, zoneId, { type: 'A', name: 'weg.example.ch', content: '1.2.3.4' })
    await cf.deleteRecord(zoneId, r.record.id)
    await cf.deleteRecord(zoneId, r.record.id)
    assert.ok(![...fake.records.values()].some((x) => x.name === 'weg.example.ch'))
  })
})

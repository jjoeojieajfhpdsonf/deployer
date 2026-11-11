import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { MmdbReader, bufferSource, cityFromRecord, ipBytes } from './mmdb.js'
import { buildMmdb, cityRecord } from './mmdb-fixture.js'
import { CITY_DB_FILE, CityDb, cityDbDue, cityDbUrl, monthOf } from './geo.js'

const fixture = () => buildMmdb([
  ['203.0.113.0/24', cityRecord('Zürich', 'CH', 'Zurich')],
  ['198.51.100.0/25', cityRecord('Berlin', 'DE')],
  ['2001:db8:1::/48', cityRecord('Wien', 'AT', 'Vienna')],
])

const dirs: string[] = []
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })
const tempDir = async () => {
  const d = await mkdtemp(join(tmpdir(), 'airlock-geo-'))
  dirs.push(d)
  return d
}

describe('Städte: MaxMind-DB-Leser (Fixture statt DB-IP-Datei)', () => {
  test('IPv4 und IPv6, Treffer und kein Treffer', () => {
    const r = new MmdbReader(bufferSource(fixture()))
    assert.equal(r.metadata.database_type, 'DBIP-City-Lite')
    assert.deepEqual(cityFromRecord(r.get('203.0.113.77')), { city: 'Zürich', country: 'CH' })
    assert.deepEqual(cityFromRecord(r.get('198.51.100.5')), { city: 'Berlin', country: 'DE' })
    // .128/25 liegt ausserhalb
    assert.equal(r.get('198.51.100.200'), null)
    assert.deepEqual(cityFromRecord(r.get('2001:db8:1:42::9')), { city: 'Wien', country: 'AT' })
    assert.equal(r.get('2001:db8:2::1'), null)
    assert.equal(r.get('kein-ip'), null)
  })

  test('Datenbank nur für IPv4: IPv6 ohne Treffer', () => {
    const r = new MmdbReader(bufferSource(buildMmdb([['203.0.113.0/24', cityRecord('Bern', 'CH')]], { ipVersion: 4 })))
    assert.deepEqual(cityFromRecord(r.get('203.0.113.1')), { city: 'Bern', country: 'CH' })
    assert.equal(r.get('2001:db8::1'), null)
  })

  test('kein MaxMind-Format → klarer Fehler', () => {
    assert.throws(() => new MmdbReader(bufferSource(Buffer.from('hallo'))), /Keine MaxMind-DB/)
  })

  test('ipBytes: IPv6 mit :: und eingebettetem IPv4', () => {
    assert.deepEqual(ipBytes('::ffff:1.2.3.4')!.slice(10), [255, 255, 1, 2, 3, 4])
    assert.equal(ipBytes('2001:db8::1')!.length, 16)
    assert.equal(ipBytes('1.2.3'), null)
  })

  test('Stadt deutsch vor englisch, ohne Stadt nur Land', () => {
    assert.deepEqual(cityFromRecord({ city: { names: { en: 'Geneva', de: 'Genf' } }, country: { iso_code: 'ch' } }), { city: 'Genf', country: 'CH' })
    assert.deepEqual(cityFromRecord({ country: { iso_code: 'FR' } }), { city: '', country: 'FR' })
    assert.equal(cityFromRecord(null), null)
  })
})

describe('Städte: Datei laden, fehlt sie → nur Länder', () => {
  test('ohne Datei: keine Stadt, Monat null', async () => {
    const db = new CityDb(await tempDir())
    assert.equal(await db.load(), false)
    assert.equal(db.lookup('203.0.113.1'), null)
    assert.equal(db.month, null)
  })

  test('mit Datei: Stadt zur öffentlichen IP', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, CITY_DB_FILE), fixture())
    const db = new CityDb(dir)
    assert.equal(await db.load(), true)
    assert.deepEqual(db.lookup('203.0.113.1'), { city: 'Zürich', country: 'CH' })
    // Stand aus build_epoch, wenn keine Info-Datei da ist
    assert.match(db.month!, /^\d{4}-\d{2}$/)
    await db.remove()
    assert.equal(db.lookup('203.0.113.1'), null)
  })

  test('monatlicher Download (ohne Internet: gefälschtes fetch): aktueller Monat, sonst der vorige', async () => {
    const dir = await tempDir()
    const now = Date.parse('2026-11-02T10:00:00Z')
    const asked: string[] = []
    const fakeFetch = (async (url: string) => {
      asked.push(url)
      if (url.includes('2026-11')) return new Response(null, { status: 404 })
      return new Response(gzipSync(fixture()))
    }) as unknown as typeof fetch
    const db = new CityDb(dir)
    const info = await db.download({ now, fetchImpl: fakeFetch })
    assert.deepEqual(asked, [cityDbUrl('2026-11'), cityDbUrl('2026-10')])
    assert.equal(asked[0], 'https://download.db-ip.com/free/dbip-city-lite-2026-11.mmdb.gz')
    assert.equal(info.month, '2026-10')
    assert.equal(db.month, '2026-10')
    assert.deepEqual(db.lookup('198.51.100.1'), { city: 'Berlin', country: 'DE' })
    // keine temporäre Datei liegen geblieben
    assert.deepEqual((await readdir(dir)).sort(), ['dbip-city-lite.json', CITY_DB_FILE].sort())
  })

  test('kaputte Datei: alte bleibt, Fehler', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, CITY_DB_FILE), fixture())
    const db = new CityDb(dir)
    await db.load()
    const bad = (async () => new Response(gzipSync(Buffer.from('keine datenbank')))) as unknown as typeof fetch
    await assert.rejects(db.download({ now: Date.parse('2026-11-05T00:00:00Z'), fetchImpl: bad }), /unbrauchbar/)
    assert.deepEqual(db.lookup('203.0.113.1'), { city: 'Zürich', country: 'CH' })
  })

  test('Aktualisierung fällig: nur mit vorhandener Datei, ab dem 3. eines neuen Monats', () => {
    assert.equal(cityDbDue(null, Date.parse('2026-12-10T00:00:00Z')), false)
    assert.equal(cityDbDue({ month: '2026-11', downloadedAt: '' }, Date.parse('2026-11-20T00:00:00Z')), false)
    assert.equal(cityDbDue({ month: '2026-11', downloadedAt: '' }, Date.parse('2026-12-02T00:00:00Z')), false)
    assert.equal(cityDbDue({ month: '2026-11', downloadedAt: '' }, Date.parse('2026-12-03T00:00:00Z')), true)
    assert.equal(monthOf(Date.parse('2026-01-15T00:00:00Z'), 1), '2025-12')
  })
})

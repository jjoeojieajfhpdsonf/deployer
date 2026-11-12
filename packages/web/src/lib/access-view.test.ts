import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { AccessEntryDto } from '@airlock/shared'
import { DEFAULT_FILTERS, accessCsv, byDay, dayLabel, filterAccess, fmtDuration, groupTime, readFilters, writeFilters } from './access-view.js'

/** Zugriffe neu: Filter in der Adresse, Suche, Zähler, Tagestrenner, Zeitspanne, CSV */

// Feste Ortszeit: 12.11.2026, 09:12:43 (Zürich, UTC+1)
const NOW = 1794471163000
const at = (sec: number) => new Date(NOW - sec * 1000).toISOString()
let n = 0
function entry(o: Partial<AccessEntryDto> = {}): AccessEntryDto {
  n++
  return {
    id: `e${n}`, at: at(0), method: 'GET', host: 'hallo.example.ch', path: '/', status: 200, block: null,
    way: 'public', dockerNet: false, ip: '84.72.10.x', country: 'CH', city: 'Bern', network: { asn: 13030, name: 'Init7 (Switzerland) Ltd.', datacenter: false },
    browser: 'Firefox 132', system: 'macOS', device: 'desktop', language: 'de-CH', referrer: '', proto: 'HTTP/2', tls: 'TLS 1.3',
    durationMs: 0.4, bytes: 1234, bot: null, probe: false, scanner: false, headers: [],
    ...o,
  }
}

describe('Filter in der Adresse', () => {
  test('Standard ohne Parameter; nur Abweichungen landen in der Adresse; tab bleibt', () => {
    assert.deepEqual(readFilters(new URLSearchParams('tab=logs')), DEFAULT_FILTERS)
    const f = { ...DEFAULT_FILTERS, status: 'abgewiesen' as const, range: '1h' as const, way: 'tailnet' as const, search: '/wp', group: false, hideProbes: false, bots: true, row: 'abc' }
    const p = writeFilters(new URLSearchParams('tab=logs'), f)
    assert.equal(p.toString(), 'tab=logs&status=abgewiesen&zeit=1h&zugang=tailnet&suche=%2Fwp&einzeln=1&pruefungen=1&bots=1&zeile=abc')
    assert.deepEqual(readFilters(p), f)
    assert.equal(writeFilters(p, DEFAULT_FILTERS).toString(), 'tab=logs')
  })
  test('Unsinn in der Adresse fällt auf den Standard', () => {
    const f = readFilters(new URLSearchParams('status=kaputt&zeit=7d&zugang=mond&einzeln=ja'))
    assert.equal(f.status, 'alle')
    assert.equal(f.range, '24h')
    assert.equal(f.way, 'all')
    assert.equal(f.group, true)
  })
})

describe('Filtern und Zählen', () => {
  const list = [
    entry({ path: '/' }),
    entry({ path: '/fehlt', status: 404 }),
    entry({ path: '/', status: 403, block: 'ip-filter', way: 'lan', dockerNet: true, network: null, ip: '172.25.0.x', country: '' }),
    entry({ path: '/', status: 503, block: 'pause' }),
    entry({ path: '/api', status: 502 }),
    entry({ path: '/', probe: true, browser: '' }),
    entry({ path: '/robots.txt', bot: 'ua', browser: '' }),
    entry({ path: '/wp-login.php', status: 404, scanner: true, network: { asn: 14061, name: 'DigitalOcean, LLC', datacenter: true }, bot: 'datacenter', country: 'NL' }),
    entry({ path: '/alt', at: at(2 * 60 * 60) }),
  ]
  const since = NOW - 60 * 60_000
  test('Standard: ohne eigene Prüfungen und ohne sichere Bots, «Bot?» bleibt; Zähler je Status', () => {
    const r = filterAccess(list, DEFAULT_FILTERS, since)
    assert.equal(r.list.length, 6)
    assert.equal(r.probes, 1)
    assert.equal(r.bots, 1)
    assert.deepEqual(r.counts, { alle: 6, erfolg: 1, 'nicht-gefunden': 2, abgewiesen: 2, fehler: 1 })
    assert.ok(r.list.some((e) => e.bot === 'datacenter'))
  })
  test('Prüfungen und Bots einblenden, Status und Zugang filtern', () => {
    assert.equal(filterAccess(list, { ...DEFAULT_FILTERS, hideProbes: false, bots: true }, since).list.length, 8)
    assert.deepEqual(filterAccess(list, { ...DEFAULT_FILTERS, status: 'abgewiesen' }, since).list.map((e) => e.status), [403, 503])
    assert.deepEqual(filterAccess(list, { ...DEFAULT_FILTERS, way: 'lan' }, since).list.map((e) => e.status), [403])
  })
  test('Suche: Pfad, Land (Code und Name), Provider, Status-Wort, Docker-Netz', () => {
    const s = (q: string) => filterAccess(list, { ...DEFAULT_FILTERS, search: q }, since).list.map((e) => e.path)
    assert.deepEqual(s('wp-login'), ['/wp-login.php'])
    assert.deepEqual(s('niederlande'), ['/wp-login.php'])
    assert.deepEqual(s('digitalocean'), ['/wp-login.php'])
    assert.deepEqual(s('docker-netz'), ['/'])
    assert.deepEqual(s('nicht gefunden'), ['/fehlt', '/wp-login.php'])
    assert.deepEqual(s('502'), ['/api'])
  })
})

describe('Darstellung', () => {
  test('Tagestrenner mit Heute und Gestern', () => {
    assert.equal(dayLabel(at(0), NOW), 'Heute, Do 12.11.')
    assert.equal(dayLabel(at(10 * 60 * 60), NOW), 'Gestern, Mi 11.11.')
    assert.equal(dayLabel(at(40 * 60 * 60), NOW), 'Di 10.11.')
    const days = byDay([{ id: 'a', entries: [entry({ at: at(0) })] }, { id: 'b', entries: [entry({ at: at(60) })] }, { id: 'c', entries: [entry({ at: at(10 * 60 * 60) })] }], NOW)
    assert.deepEqual(days.map((d) => [d.label, d.groups.length]), [['Heute, Do 12.11.', 2], ['Gestern, Mi 11.11.', 1]])
  })
  test('Zeit: einzeln mit Sekunden, zusammengefasst als Spanne', () => {
    assert.equal(groupTime({ id: 'a', entries: [entry({ at: at(0) })] }), '09:12:43')
    assert.equal(groupTime({ id: 'a', entries: [entry({ at: at(0) }), entry({ at: at(20) })] }), '09:12:43')
    assert.equal(groupTime({ id: 'a', entries: [entry({ at: at(26 * 60) }), entry({ at: at(29 * 60) })] }), '08:43–08:46')
    assert.equal(fmtDuration(0.4), '< 1 ms')
    assert.equal(fmtDuration(12.3), '12 ms')
    // de-CH: Dezimalpunkt
    assert.equal(fmtDuration(1400), '1.4 s')
    assert.equal(fmtDuration(null), '–')
  })
  test('CSV: Absender gekürzt, Formeln entschärft, Sperre genannt', () => {
    const csv = accessCsv([entry({ path: '=HYPERLINK("x")', status: 403, block: 'ip-filter', way: 'lan', dockerNet: true, ip: '172.25.0.x' })])
    const [head, row] = csv.trim().split('\n')
    assert.match(head!, /"Absender \(gekürzt\)"/)
    assert.match(row!, /"'=HYPERLINK\(""x""\)"/)
    assert.match(row!, /"IP-Filter","Docker-Netz"/)
    assert.match(row!, /"172\.25\.0\.x"/)
  })
})

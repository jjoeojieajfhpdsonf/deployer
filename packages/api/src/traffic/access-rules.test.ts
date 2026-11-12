import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCESS_GROUP_WINDOW_MS, GATEWAY_GUIDE_URL, accessHints, accessKind, accessOrigin, botLabel, browserFamily, deviceName,
  dockerBlockWarning, groupAccess, isDockerNet, matchesStatus, providerShort, type AccessEntryDto,
} from '@airlock/shared'

/**
 * Zugriffe neu: reine Regeln aus packages/shared/src/access.ts – Status,
 * Herkunft, Zusammenfassen, Erklärungen, Warnung «Docker-Netz abgewiesen».
 */

const T0 = Date.parse('2026-11-12T09:12:43.000Z')
let n = 0
function entry(o: Partial<AccessEntryDto> = {}): AccessEntryDto {
  n++
  return {
    id: `e${n}`, at: new Date(T0).toISOString(), method: 'GET', host: 'hallo.example.ch', path: '/', status: 200, block: null,
    way: 'public', dockerNet: false, ip: '84.72.10.x', country: 'CH', city: '', network: { asn: 13030, name: 'Init7 (Switzerland) Ltd.', datacenter: false },
    browser: 'Safari 18', system: 'macOS', device: 'desktop', language: 'de-CH', referrer: '', source: '', campaign: null, proto: 'HTTP/2', tls: 'TLS 1.3',
    durationMs: 0.4, bytes: 1234, bot: null, probe: false, scanner: false, headers: [],
    ...o,
  }
}
const at = (sec: number) => new Date(T0 - sec * 1000).toISOString()

describe('Status', () => {
  test('Einteilung: Sperre vor Code, 3xx umgeleitet, übrige 4xx Clientfehler', () => {
    assert.equal(accessKind({ status: 200, block: null }), 'ok')
    assert.equal(accessKind({ status: 304, block: null }), 'redirect')
    assert.equal(accessKind({ status: 404, block: null }), 'not-found')
    assert.equal(accessKind({ status: 405, block: null }), 'client')
    assert.equal(accessKind({ status: 403, block: 'ip-filter' }), 'blocked')
    assert.equal(accessKind({ status: 503, block: 'pause' }), 'blocked')
    assert.equal(accessKind({ status: 502, block: null }), 'error')
  })
  test('Filter: Erfolg = 2xx/3xx, Abgewiesen = Sperren von Airlock, Fehler = 5xx ohne Pause', () => {
    assert.ok(matchesStatus({ status: 301, block: null }, 'erfolg'))
    assert.ok(!matchesStatus({ status: 404, block: null }, 'erfolg'))
    assert.ok(matchesStatus({ status: 404, block: null }, 'nicht-gefunden'))
    assert.ok(matchesStatus({ status: 503, block: 'pause' }, 'abgewiesen'))
    assert.ok(!matchesStatus({ status: 503, block: 'pause' }, 'fehler'))
    assert.ok(matchesStatus({ status: 500, block: null }, 'fehler'))
    assert.ok(!matchesStatus({ status: 403, block: null }, 'abgewiesen'))
    assert.ok(matchesStatus({ status: 403, block: null }, 'alle'))
  })
})

describe('Herkunft', () => {
  test('Docker-Netz: 172.16.0.0/12, auch gekürzt und als ::ffff:', () => {
    assert.ok(isDockerNet('172.25.0.1'))
    assert.ok(isDockerNet('172.16.0.x'))
    assert.ok(isDockerNet('::ffff:172.31.255.1'))
    assert.ok(!isDockerNet('172.32.0.1'))
    assert.ok(!isDockerNet('172.15.0.1'))
    assert.ok(!isDockerNet('192.168.1.20'))
  })
  test('Provider kurz: ohne Rechtsform und Klammern; Rechenzentren mit eigenem Namen', () => {
    assert.equal(providerShort({ asn: 13030, name: 'Init7 (Switzerland) Ltd.' }), 'Init7')
    assert.equal(providerShort({ asn: 3320, name: 'Deutsche Telekom AG' }), 'Deutsche Telekom')
    assert.equal(providerShort({ asn: 14061, name: 'DigitalOcean, LLC' }), 'DigitalOcean')
    assert.equal(providerShort({ asn: 1, name: 'AG' }), 'AG')
  })
  test('Gerät aus System und Typ (Airlock kennt keine Tailnet-Namen)', () => {
    assert.equal(deviceName('iOS 18', 'mobile'), 'iPhone')
    assert.equal(deviceName('iOS 17', 'tablet'), 'iPad')
    assert.equal(deviceName('macOS', 'desktop'), 'Mac')
    assert.equal(deviceName('Windows 11', 'desktop'), 'Windows-PC')
    assert.equal(deviceName('', 'desktop'), '')
  })
  test('Ort und Zusatz: Internet mit Provider, Tailnet mit Gerät, Docker-Netz mit Adresse', () => {
    assert.deepEqual(accessOrigin(entry()), { place: 'Internet', detail: 'Init7' })
    assert.deepEqual(accessOrigin(entry({ way: 'tailnet', network: null, system: 'iOS 18', device: 'mobile', ip: '100.88.41.x' })), { place: 'Tailnet', detail: 'iPhone' })
    assert.deepEqual(accessOrigin(entry({ way: 'lan', network: null, system: '', ip: '192.168.1.x' })), { place: 'Heimnetz', detail: '192.168.1.x' })
    assert.deepEqual(accessOrigin(entry({ way: 'lan', dockerNet: true, network: null, ip: '172.25.0.x' })), { place: 'Docker-Netz', detail: '172.25.0.x' })
  })
  test('Kennzeichen: Bot (User-Agent), Bot? (Rechenzentrum, Scanner-Pfad)', () => {
    assert.equal(botLabel({ bot: 'ua', scanner: false }), 'Bot')
    assert.equal(botLabel({ bot: 'datacenter', scanner: false }), 'Bot?')
    assert.equal(botLabel({ bot: null, scanner: true }), 'Bot?')
    assert.equal(botLabel({ bot: null, scanner: false }), null)
    assert.equal(browserFamily('Safari 18'), 'Safari')
    assert.equal(browserFamily('Samsung Internet 26'), 'Samsung Internet')
  })
})

describe('Zusammenfassen', () => {
  test('Gleicher Pfad, Status, Zugang und Herkunft innerhalb 5 Minuten → eine Zeile an der Stelle des neuesten', () => {
    const list = [
      entry({ at: at(0), path: '/' }),
      entry({ at: at(1), path: '/', way: 'tailnet', network: null, ip: '100.88.41.x' }),
      entry({ at: at(60), path: '/' }),
      entry({ at: at(299), path: '/' }),
      entry({ at: at(301), path: '/' }),
      entry({ at: at(302), path: '/impressum' }),
    ]
    const g = groupAccess(list)
    assert.deepEqual(g.map((x) => x.entries.length), [3, 1, 1, 1])
    assert.equal(g[0]!.id, list[0]!.id)
    assert.deepEqual(g.map((x) => x.entries[0]!.path), ['/', '/', '/', '/impressum'])
    // Die vierte Zeile liegt 301 s nach der neuesten → neue Gruppe
    assert.equal(g[2]!.entries[0]!.at, at(301))
    assert.equal(ACCESS_GROUP_WINDOW_MS, 300_000)
  })
  test('Anderer Status, andere Sperre, anderes Netz oder Bot trennen', () => {
    const list = [
      entry({ at: at(0) }),
      entry({ at: at(1), status: 404 }),
      entry({ at: at(2), status: 403, block: 'ip-filter' }),
      entry({ at: at(3), network: { asn: 3303, name: 'Swisscom (Schweiz) AG', datacenter: false } }),
      entry({ at: at(4), bot: 'ua' }),
      entry({ at: at(5), method: 'HEAD' }),
    ]
    assert.equal(groupAccess(list).length, 6)
  })
})

describe('Erklärungen', () => {
  test('Docker-Netz + abgewiesen → maskiertes Tailnet mit Anleitung; nicht bei Pause', () => {
    const h = accessHints(entry({ way: 'lan', dockerNet: true, status: 403, block: 'ip-filter', network: null }))
    assert.equal(h.length, 1)
    assert.equal(h[0]!.kind, 'gateway')
    assert.match(h[0]!.title, /ts-docker-nosnat/)
    assert.equal(h[0]!.link?.href, GATEWAY_GUIDE_URL)
    assert.deepEqual(accessHints(entry({ way: 'lan', dockerNet: true, status: 503, block: 'pause', network: null })), [])
    assert.deepEqual(accessHints(entry({ way: 'lan', dockerNet: true, status: 200, network: null })), [])
  })
  test('Scanner-Pfad: harmlos bei 404, sonst prüfen', () => {
    const ok = accessHints(entry({ path: '/wp-login.php', status: 404, scanner: true }))
    assert.equal(ok[0]!.tone, 'info')
    assert.match(ok[0]!.title, /harmlos solange 404/)
    const bad = accessHints(entry({ path: '/.env', status: 200, scanner: true }))
    assert.equal(bad[0]!.tone, 'warn')
    assert.match(bad[0]!.title, /Antwort 200/)
  })
  test('Rechenzentrum → vermutlich Bot', () => {
    const h = accessHints(entry({ network: { asn: 14061, name: 'DigitalOcean, LLC', datacenter: true } }))
    assert.equal(h[0]!.kind, 'datacenter')
    assert.match(h[0]!.text, /DigitalOcean/)
    assert.deepEqual(accessHints(entry()), [])
  })
})

describe('Warnung Docker-Netz', () => {
  const now = T0
  const ev = (minAgo: number, host = 'hallo.int.example.ch') => ({ at: now - minAgo * 60_000, host })
  test('Mehr als 3 in einer Stunde → Warnung mit häufigsten Namen und letzter Zeit', () => {
    assert.equal(dockerBlockWarning([ev(1), ev(2), ev(3)], now), null)
    const w = dockerBlockWarning([ev(1), ev(2), ev(3), ev(59, 'foto.int.example.ch'), ev(61)], now)!
    assert.equal(w.count, 4)
    assert.deepEqual(w.hosts, ['hallo.int.example.ch', 'foto.int.example.ch'])
    assert.equal(w.last, new Date(now - 60_000).toISOString())
  })
  test('Älter als eine Stunde zählt nicht', () => {
    assert.equal(dockerBlockWarning([ev(61), ev(62), ev(63), ev(64), ev(1)], now), null)
  })
})

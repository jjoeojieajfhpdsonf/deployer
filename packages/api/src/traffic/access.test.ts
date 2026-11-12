import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { INTERNAL_REFERRER, isDatacenterAsn } from '@airlock/shared'
import { accessId, blockOf, cleanReferrer, pickHeaders, protoName, readAccessLog, shortenIp, toAccessEntry } from './access.js'
import { parseAccessLine } from './parse.js'
import { caddyLine } from './test-lines.js'

/**
 * Zugriffe neu: Zeile aus visits.log → Eintrag des Reiters (gekürzte IP,
 * ausgewählte Header, Sperre, Herkunft) und Lesen über rotierte Dateien.
 */

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
const lookups = {
  asn: (ip: string) => (ip.startsWith('159.') ? { asn: 14061, name: 'DigitalOcean, LLC' } : ip.startsWith('84.') ? { asn: 13030, name: 'Init7 (Switzerland) Ltd.' } : null),
  city: (ip: string) => (ip.startsWith('84.') ? { city: 'Bern', country: 'CH' } : null),
  isDatacenter: isDatacenterAsn,
}
const line = (o: Parameters<typeof caddyLine>[0]) => parseAccessLine(caddyLine(o))!

describe('Eintrag aus einer Zeile', () => {
  test('IP gekürzt: IPv4 ohne letztes Oktett, IPv6 drei Gruppen', () => {
    assert.equal(shortenIp('192.168.1.77'), '192.168.1.x')
    assert.equal(shortenIp('2001:db8:85a3:0:0:8a2e:370:7334'), '2001:db8:85a3:…')
    assert.equal(shortenIp('::ffff:10.0.0.5'), '10.0.0.x')
    assert.equal(shortenIp(undefined), '–')
  })

  test('Tailnet-Zugriff vom iPhone: Gerät, Sprache, Protokoll, TLS, Dauer; IP gekürzt', () => {
    const e = toAccessEntry(line({
      ip: '100.88.41.7', host: 'hallo.int.example.ch', uri: '/impressum?token=geheim', ua: IPHONE, tls: 772, duration: 0.0123,
      headers: { 'Accept-Language': 'de-CH,de;q=0.9', 'Sec-Fetch-Site': 'none', Authorization: 'REDACTED' },
    }), false, lookups)
    assert.equal(e.way, 'tailnet')
    assert.equal(e.dockerNet, false)
    assert.equal(e.ip, '100.88.41.x')
    assert.equal(e.path, '/impressum')
    assert.equal(e.browser, 'Safari 18')
    assert.equal(e.system, 'iOS 18')
    assert.equal(e.device, 'mobile')
    assert.equal(e.language, 'de-CH')
    assert.equal(e.proto, 'HTTP/2')
    assert.equal(e.tls, 'TLS 1.3')
    assert.equal(e.durationMs, 12.3)
    assert.equal(e.network, null)
    assert.equal(e.country, '')
    assert.equal(JSON.stringify(e).includes('100.88.41.7'), false)
    assert.equal(JSON.stringify(e).includes('geheim'), false)
    const names = e.headers.map(([k]) => k)
    assert.deepEqual(names, ['user-agent', 'accept-language', 'sec-fetch-site'])
    assert.ok(e.headers[0]![1].endsWith('…'))
  })

  test('Docker-Netz abgewiesen: Absender ist die Verbindung (Gateway), gekürzt; Sperre IP-Filter', () => {
    const e = toAccessEntry(line({ ip: '172.25.0.1', host: 'hallo.int.example.ch', status: 403, blocked: true, contentType: 'text/plain' }), false, lookups)
    assert.equal(e.way, 'lan')
    assert.equal(e.dockerNet, true)
    assert.equal(e.ip, '172.25.0.x')
    assert.equal(e.block, 'ip-filter')
    assert.deepEqual(e.headers.at(-1), ['x-airlock-block', 'ip-filter'])
  })

  test('Internet: Absender laut Cloudflare, nicht cloudflared im Docker-Netz; Land, Stadt, Netz, Rechenzentrum', () => {
    const e = toAccessEntry(line({ ip: '159.89.1.2', remoteIp: '172.30.0.5', host: 'hallo.example.ch', uri: '/wp-login.php', status: 404, country: 'NL', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }), true, lookups)
    assert.equal(e.way, 'public')
    assert.equal(e.dockerNet, false)
    assert.equal(e.ip, '159.89.1.x')
    assert.equal(e.country, 'NL')
    assert.deepEqual(e.network, { asn: 14061, name: 'DigitalOcean, LLC', datacenter: true })
    assert.equal(e.bot, 'datacenter')
    assert.equal(e.scanner, true)
    const f = toAccessEntry(line({ ip: '84.72.10.3', host: 'hallo.example.ch', country: 'XX' }), true, lookups)
    assert.equal(f.country, 'CH')
    assert.equal(f.city, 'Bern')
  })

  test('Besucher zusammen: Quelle und Kampagne wie in der Auswertung, sonst nichts aus der Query', () => {
    const own = new Set(['hallo.example.ch', 'hallo.int.example.ch'])
    const ext = toAccessEntry(line({ host: 'hallo.example.ch', referer: 'https://www.google.com/search?q=geheim' }), true, lookups, own)
    assert.equal(ext.source, 'google.com')
    assert.equal(ext.campaign, null)
    const inner = toAccessEntry(line({ host: 'hallo.example.ch', referer: 'https://hallo.int.example.ch/blog' }), true, lookups, own)
    assert.equal(inner.source, INTERNAL_REFERRER)
    assert.equal(toAccessEntry(line({ host: 'hallo.example.ch' }), true, lookups, own).source, '')
    const utm = toAccessEntry(line({ host: 'hallo.example.ch', uri: '/?utm_source=newsletter&utm_medium=mail&utm_campaign=herbst&token=geheim' }), true, lookups, own)
    assert.deepEqual(utm.campaign, { source: 'newsletter', medium: 'mail', campaign: 'herbst' })
    assert.equal(utm.source, 'newsletter')
    assert.equal(JSON.stringify(utm).includes('geheim'), false)
    assert.equal(JSON.stringify(ext).includes('geheim'), false)
  })

  test('Eigene Prüfung und Bot nach User-Agent erkannt', () => {
    assert.equal(toAccessEntry(line({ ua: 'airlock-probe (adresse)' }), false, lookups).probe, true)
    assert.equal(toAccessEntry(line({ ua: 'curl/8.5.0' }), false, lookups).bot, 'ua')
    assert.equal(toAccessEntry(line({ ua: null }), false, lookups).bot, 'ua')
  })

  test('Sperre: X-Airlock-Block, Pause-Seite, Rate-Limit am CSP-Endpunkt', () => {
    assert.equal(blockOf({ blockValue: 'ip-filter', paused: false, status: 403, path: '/' }), 'ip-filter')
    assert.equal(blockOf({ blockValue: 'neu', paused: false, status: 403, path: '/' }), 'other')
    assert.equal(blockOf({ blockValue: '', paused: true, status: 503, path: '/' }), 'pause')
    assert.equal(blockOf({ blockValue: '', paused: false, status: 429, path: '/.well-known/airlock/csp-report/abc' }), 'rate-limit')
    assert.equal(blockOf({ blockValue: '', paused: false, status: 429, path: '/api' }), null)
    const p = line({ status: 503, respHeaders: { 'X-Airlock-State': 'paused' } })
    assert.equal(p.paused, true)
  })

  test('Nie Cookie oder Authorization in den Headern; Referrer ohne Query', () => {
    const a = line({ headers: { Authorization: 'REDACTED', 'Sec-Fetch-Mode': 'navigate' } })
    const h = pickHeaders(a).map(([k]) => k)
    assert.ok(!h.includes('cookie') && !h.includes('authorization'))
    assert.ok(h.includes('sec-fetch-mode'))
    assert.equal(cleanReferrer('https://www.google.com/search?q=hallo#x'), 'https://www.google.com/search')
    assert.equal(cleanReferrer('kaputt'), '')
    assert.equal(protoName('HTTP/1.1'), 'HTTP/1.1')
    assert.equal(protoName('HTTP/3.0'), 'HTTP/3')
  })

  test('Kennung stabil (gleiche Zeile → gleiche Kennung), verschieden bei anderer Anfrage', () => {
    const a = line({ uri: '/a' })
    assert.equal(accessId(a), accessId(line({ uri: '/a' })))
    assert.notEqual(accessId(a), accessId(line({ uri: '/b' })))
  })
})

describe('Lesen aus visits.log und rotierten Dateien', () => {
  let dir = ''
  after(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  test('Nur Namen des Projekts, seit dem Zeitpunkt, neueste zuerst, auch aus .gz; capped', async () => {
    dir = await mkdtemp(join(tmpdir(), 'zugriffe-'))
    const t = 1_794_400_000
    const cur = [
      caddyLine({ ts: t + 100, host: 'hallo.int.example.ch', uri: '/neu' }),
      caddyLine({ ts: t + 90, host: 'andere.int.example.ch', uri: '/fremd' }),
      caddyLine({ ts: t + 80, host: 'Hallo.INT.example.ch:443', uri: '/gross' }),
      'kein json',
    ].join('\n')
    const old = [
      caddyLine({ ts: t + 10, host: 'hallo.int.example.ch', uri: '/alt' }),
      caddyLine({ ts: t - 5000, host: 'hallo.int.example.ch', uri: '/zu-alt' }),
    ].join('\n')
    await writeFile(join(dir, 'visits.log'), `${cur}\n`)
    await writeFile(join(dir, 'visits-2026-11-11T08-00-00.000.log.gz'), gzipSync(`${old}\n`))
    // Ganz alte rotierte Datei: wird gar nicht gelesen
    await writeFile(join(dir, 'visits-2026-11-01T08-00-00.000.log'), `${caddyLine({ ts: t - 900_000, host: 'hallo.int.example.ch', uri: '/uralt' })}\n`)
    await utimes(join(dir, 'visits-2026-11-01T08-00-00.000.log'), new Date((t - 900_000) * 1000), new Date((t - 900_000) * 1000))
    await writeFile(join(dir, 'andere.log'), `${caddyLine({ ts: t + 50, host: 'hallo.int.example.ch', uri: '/falsche-datei' })}\n`)

    const hosts = new Map([['hallo.int.example.ch', { public: false }]])
    const r = await readAccessLog(dir, { hosts, sinceMs: (t - 1000) * 1000, limit: 10, lookups })
    assert.deepEqual(r.entries.map((e) => e.path), ['/neu', '/gross', '/alt'])
    assert.equal(r.capped, false)
    const c = await readAccessLog(dir, { hosts, sinceMs: (t - 1000) * 1000, limit: 2, lookups })
    assert.deepEqual(c.entries.map((e) => e.path), ['/neu', '/gross'])
    assert.equal(c.capped, true)
  })
})

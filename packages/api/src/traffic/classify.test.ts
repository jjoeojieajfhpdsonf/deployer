import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { INTERNAL_REFERRER, isScannerPath } from '@airlock/shared'
import {
  botReason, countryOf, deviceOf, inCidr, isAsset, isBotAgent, isHealthcheck, normalizePath, referrerOf, verdictOf, wayOf,
} from './classify.js'

const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const ANDROID_TAB = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
const ANDROID_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36'

describe('Besucher: Zugang', () => {
  test('öffentlicher Name → Internet, egal welche Adresse', () => {
    assert.equal(wayOf('203.0.113.9', true), 'public')
    assert.equal(wayOf('100.88.1.2', true), 'public')
  })
  test('Tailnet: 100.64.0.0/10 und fd7a:115c:a1e0::/48', () => {
    assert.equal(wayOf('100.64.0.1', false), 'tailnet')
    assert.equal(wayOf('100.127.255.254', false), 'tailnet')
    assert.equal(wayOf('fd7a:115c:a1e0::1234', false), 'tailnet')
    // 100.128.x liegt ausserhalb
    assert.equal(wayOf('100.128.0.1', false), 'lan')
  })
  test('alles andere intern → Heimnetz (192.168.x, Docker-Gateway, Server selbst)', () => {
    assert.equal(wayOf('192.168.1.20', false), 'lan')
    assert.equal(wayOf('172.20.0.1', false), 'lan')
    assert.equal(wayOf('127.0.0.1', false), 'lan')
  })
  test('inCidr', () => {
    assert.ok(inCidr('192.168.1.7', '192.168.1.0/24'))
    assert.ok(!inCidr('192.168.2.7', '192.168.1.0/24'))
    assert.ok(inCidr('::ffff:10.0.0.1', '10.0.0.0/8'))
    assert.ok(!inCidr('2001:db8::1', '10.0.0.0/8'))
  })
})

describe('Besucher: Bot-Filter', () => {
  test('isbot erkennt Crawler, Uptime-Dienste und Werkzeuge', () => {
    for (const ua of ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'UptimeRobot/2.0', 'curl/8.5.0', 'python-requests/2.31', 'Go-http-client/1.1']) {
      assert.equal(isBotAgent(ua), true, ua)
    }
  })
  test('Browser sind keine Bots; ohne User-Agent schon', () => {
    assert.equal(isBotAgent(SAFARI), false)
    assert.equal(isBotAgent(IPHONE), false)
    assert.equal(isBotAgent(''), true)
    assert.equal(isBotAgent('   '), true)
  })
})

describe('Besucher: Healthchecks und statische Dateien', () => {
  test('Healthcheck-Pfad des Projekts und übliche Pfade', () => {
    assert.ok(isHealthcheck('/api/status', '/api/status'))
    assert.ok(isHealthcheck('/api/status/', '/api/status'))
    assert.ok(isHealthcheck('/healthz', '/'))
    assert.ok(isHealthcheck('/HEALTH', null))
    assert.ok(!isHealthcheck('/', '/'))
    assert.ok(!isHealthcheck('/status', null))
  })
  test('Seite nach Content-Type, ohne Content-Type nach Endung', () => {
    assert.equal(isAsset('/', 'text/html; charset=utf-8'), false)
    assert.equal(isAsset('/app.js', 'text/javascript'), true)
    assert.equal(isAsset('/api/data', 'application/json'), true)
    assert.equal(isAsset('/logo.svg', 'image/svg+xml'), true)
    // 304 ohne Content-Type
    assert.equal(isAsset('/blog/eintrag', ''), false)
    assert.equal(isAsset('/index.html', ''), false)
    assert.equal(isAsset('/style.css', ''), true)
    assert.equal(isAsset('/font.woff2', ''), true)
  })
})

describe('Besucher: Gerät, Referrer, Land, Pfad', () => {
  test('Gerät aus dem User-Agent', () => {
    assert.equal(deviceOf(SAFARI), 'desktop')
    assert.equal(deviceOf(IPHONE), 'mobile')
    assert.equal(deviceOf(ANDROID_PHONE), 'mobile')
    assert.equal(deviceOf(IPAD), 'tablet')
    assert.equal(deviceOf(ANDROID_TAB), 'tablet')
  })
  test('Referrer: nur Host ohne www., eigene Namen = Klick innerhalb der Seite (nicht «direkt»), sonst utm_source', () => {
    const own = new Set(['foto.int.example.ch', 'foto.example.ch'])
    assert.equal(referrerOf('https://www.google.com/search?q=geheim', '', own), 'google.com')
    assert.equal(referrerOf('https://news.ycombinator.com/item?id=1', '', own), 'news.ycombinator.com')
    assert.equal(referrerOf('https://foto.example.ch/galerie', '', own), INTERNAL_REFERRER)
    assert.equal(referrerOf('', 'utm_source=Newsletter&x=1', own), 'newsletter')
    assert.equal(referrerOf('', 'ref=<script>', own), '')
    assert.equal(referrerOf('kein url', '', own), '')
    assert.equal(referrerOf('', '', own), '')
  })
  test('Land: zwei Buchstaben, XX unbekannt, T1 Tor', () => {
    assert.equal(countryOf('CH'), 'CH')
    assert.equal(countryOf('de'), 'DE')
    assert.equal(countryOf('XX'), '')
    assert.equal(countryOf('T1'), 'T1')
    assert.equal(countryOf(''), '')
    assert.equal(countryOf('1'), '')
  })
  test('Pfad: ohne Steuerzeichen, höchstens 200 Zeichen', () => {
    assert.equal(normalizePath('/a\u0000b'), '/ab')
    assert.equal(normalizePath('/' + 'x'.repeat(500)).length, 200)
  })
})

describe('Besucher: Bot-Regel (botReason)', () => {
  test('User-Agent zuerst: Crawler und fehlender User-Agent → ua, egal aus welchem Netz', () => {
    assert.equal(botReason('Googlebot/2.1 (+http://www.google.com/bot.html)', 15169), 'ua')
    assert.equal(botReason('', 13030), 'ua')
    assert.equal(botReason('curl/8.4.0', null), 'ua')
  })
  test('Browser aus bekannten Hoster-Netzen → datacenter (AWS, Hetzner, DigitalOcean, OVH)', () => {
    for (const asn of [16509, 24940, 14061, 16276]) assert.equal(botReason(SAFARI, asn), 'datacenter', String(asn))
  })
  test('Browser von Zugangsanbietern und Cloudflare WARP → Mensch', () => {
    // Swisscom, Init7, Sunrise, Cloudflare
    for (const asn of [3303, 13030, 6730, 13335]) assert.equal(botReason(IPHONE, asn), null, String(asn))
    assert.equal(botReason(SAFARI, null), null)
  })
})

describe('Besucher: Scanner-Pfade (bot?)', () => {
  test('typische Lückensuche erkannt, auch unter Unterordnern und gross geschrieben', () => {
    for (const p of ['/wp-login.php', '/blog/wp-admin/setup-config.php', '/.git/config', '/.env', '/.env.production', '/phpMyAdmin/index.php', '/xmlrpc.php', '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php']) {
      assert.equal(isScannerPath(p), true, p)
    }
  })
  test('normale Tippfehler nicht', () => {
    for (const p of ['/', '/kontakt', '/blog/wordpress-tipps', '/environment', '/gitlab-anleitung', '/impresum']) assert.equal(isScannerPath(p), false, p)
  })
})

describe('Besucher: was gezählt wird', () => {
  const base = { userAgent: SAFARI, blocked: false, method: 'GET', path: '/', contentType: 'text/html' }
  const o = { healthPath: '/health', hasPages: true }
  test('Seite eines Browsers → Aufruf', () => assert.equal(verdictOf(base, o), 'page'))
  test('eigene Prüfung von Airlock → gar nicht (auch nicht live)', () => {
    assert.equal(verdictOf({ ...base, userAgent: 'airlock-probe (adresse)' }, o), 'ignore')
    assert.equal(verdictOf({ ...base, userAgent: 'airlock-csp-check' }, o), 'ignore')
  })
  test('gesperrt, POST, Healthcheck, CSP-Meldung → nur live', () => {
    assert.equal(verdictOf({ ...base, blocked: true }, o), 'live')
    assert.equal(verdictOf({ ...base, method: 'POST' }, o), 'live')
    assert.equal(verdictOf({ ...base, method: 'HEAD' }, o), 'live')
    assert.equal(verdictOf({ ...base, path: '/health' }, o), 'live')
    assert.equal(verdictOf({ ...base, path: '/.well-known/airlock/csp-report/abc' }, o), 'live')
  })
  test('Bot → getrennt gezählt', () => assert.equal(verdictOf({ ...base, userAgent: 'Googlebot/2.1' }, o), 'bot'))
  test('Browser aus einem Rechenzentrum → vermutlich Bot; Provider und ohne ASN-Datei → Mensch', () => {
    assert.equal(verdictOf(base, { ...o, asn: 24940 }), 'bot')
    assert.equal(verdictOf(base, { ...o, asn: 13030 }), 'page')
    assert.equal(verdictOf(base, { ...o, asn: null }), 'page')
  })
  test('statische Datei: nicht gezählt – ausser die Seite besteht nur daraus', () => {
    const css = { ...base, path: '/style.css', contentType: 'text/css' }
    assert.equal(verdictOf(css, o), 'live')
    assert.equal(verdictOf(css, { ...o, hasPages: false }), 'page')
  })
})

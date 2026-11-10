import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { browserCanProbe, splitAddresses, type RouteDto } from '@deployer/shared'
import { interpretProbe, hostOf, probeViaCaddy } from './address-probe.js'

describe('Adressen-Prüfung im Browser (Mixed Content)', () => {
  test('https-Seite darf http-Adressen nicht prüfen', () => {
    assert.equal(browserCanProbe('http://app.100-64-0-1.nip.io', 'https:'), false)
  })
  test('https-Seite prüft https-Adressen selbst', () => {
    assert.equal(browserCanProbe('https://app.int.example.ch', 'https:'), true)
  })
  test('http-Seite prüft alles selbst', () => {
    assert.equal(browserCanProbe('http://app.100-64-0-1.nip.io', 'http:'), true)
    assert.equal(browserCanProbe('https://app.int.example.ch', 'http:'), true)
  })
})

describe('Auswertung der Caddy-Antwort', () => {
  test('Sperrseite des IP-Filters: Caddy kennt den Namen', () => {
    assert.equal(interpretProbe(403, 'Kein Zugriff von 172.18.0.3 auf app.1-2-3-4.nip.io: …').state, 'routed')
  })
  test('ein 403 des Projekts selbst ist eine Antwort', () => {
    assert.equal(interpretProbe(403, '<html>Forbidden</html>').state, 'ok')
  })
  test('Auffangroute: Name unbekannt', () => {
    assert.equal(interpretProbe(404, 'Kein Projekt unter diesem Namen.').state, 'unknown')
  })
  test('404 des Projekts ist eine Antwort', () => {
    assert.equal(interpretProbe(404, 'Not Found').state, 'ok')
  })
  test('502–504: Projekt antwortet nicht', () => {
    for (const s of [502, 503, 504]) assert.equal(interpretProbe(s, '').state, 'down')
  })
  test('200 und Weiterleitung gelten als erreichbar', () => {
    assert.equal(interpretProbe(200, '<!doctype html>').state, 'ok')
    assert.equal(interpretProbe(308, '').state, 'ok')
  })
  test('hostOf nimmt nur http(s)', () => {
    assert.equal(hostOf('http://App.1-2-3-4.nip.io/x'), 'app.1-2-3-4.nip.io')
    assert.equal(hostOf('file:///etc/passwd'), null)
    assert.equal(hostOf('kein url'), null)
  })
})

describe('probeViaCaddy gegen einen Stellvertreter-Server', () => {
  test('schickt den Namen im Host-Header und wertet die Sperrseite aus', async () => {
    let seenHost = ''
    const srv = createServer((req, res) => {
      seenHost = req.headers.host ?? ''
      res.statusCode = 403
      res.end(`Kein Zugriff von 172.18.0.3 auf ${seenHost}: dieser Name ist nur aus den freigegebenen Netzen erreichbar.`)
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as AddressInfo).port
    try {
      const r = await probeViaCaddy(`127.0.0.1:${port}`, 'http://app.1-2-3-4.nip.io')
      assert.equal(seenHost, 'app.1-2-3-4.nip.io')
      assert.equal(r.state, 'routed')
      assert.equal(r.url, 'http://app.1-2-3-4.nip.io')
    } finally {
      srv.close()
    }
  })

  test('grosse Seite: liest nur den Anfang, Ergebnis ok', async () => {
    const srv = createServer((_req, res) => { res.end('x'.repeat(2_000_000)) })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as AddressInfo).port
    try {
      assert.equal((await probeViaCaddy(`127.0.0.1:${port}`, 'http://app.1-2-3-4.nip.io')).state, 'ok')
    } finally {
      srv.close()
    }
  })

  test('Caddy nicht erreichbar: Zustand error mit Grund', async () => {
    const r = await probeViaCaddy('127.0.0.1:1', 'http://app.1-2-3-4.nip.io', 1_000)
    assert.equal(r.state, 'error')
    assert.match(r.detail, /nicht erreichbar/)
  })
})

describe('Haupt- und weitere Adressen', () => {
  const route = (over: Partial<RouteDto>): RouteDto => ({ target: 'tailnet', targets: ['lan', 'tailnet'], hostname: 'app.int.example.ch', aliases: [], urls: [], ...over })

  test('mit Wildcard-Zertifikat: nip.io unter «Weitere Adressen»', () => {
    const r = route({
      aliases: ['app.100-64-0-1.nip.io', 'app.192-168-1-5.nip.io'],
      urls: ['https://app.int.example.ch', 'http://app.100-64-0-1.nip.io', 'http://app.192-168-1-5.nip.io'],
    })
    const pub = route({ target: 'public', targets: ['public'], hostname: 'app.example.ch', urls: ['https://app.example.ch'] })
    const { primary, more } = splitAddresses([pub, r])
    assert.deepEqual(primary.map((a) => a.url), ['https://app.example.ch', 'https://app.int.example.ch'])
    assert.deepEqual(more.map((a) => a.url), ['http://app.100-64-0-1.nip.io', 'http://app.192-168-1-5.nip.io'])
  })

  test('ohne Zertifikat bleibt alles oben', () => {
    const r = route({
      aliases: ['app.100-64-0-1.nip.io'],
      urls: ['http://app.int.example.ch', 'http://app.100-64-0-1.nip.io'],
    })
    const { primary, more } = splitAddresses([r])
    assert.equal(primary.length, 2)
    assert.equal(more.length, 0)
  })

  test('nur nip.io (keine Basisdomain): die Hauptadresse bleibt oben', () => {
    const r = route({ hostname: 'app.100-64-0-1.nip.io', aliases: ['app.192-168-1-5.nip.io'], urls: ['http://app.100-64-0-1.nip.io', 'http://app.192-168-1-5.nip.io'] })
    assert.equal(splitAddresses([r]).more.length, 0)
  })
})

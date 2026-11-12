import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseAccessLine } from './parse.js'
import { caddyLine } from './test-lines.js'

describe('Besucher: Zeile aus Caddys Zugriffs-Log lesen', () => {
  test('echte Zeile (Caddy 2.11, JSON-Encoder): Felder, Header in kanonischer Schreibweise', () => {
    // Zeile wie aus `caddy run` mit Logger visits (Header Cf-Ipcountry, Referer)
    const line = '{"level":"info","ts":1794433682.044769,"logger":"http.log.access.visits","msg":"handled request","request":{"remote_ip":"127.0.0.1","remote_port":"64577","client_ip":"127.0.0.1","proto":"HTTP/1.1","method":"GET","host":"a.localhost","uri":"/seite?x=1","headers":{"Accept":["*/*"],"Cf-Ipcountry":["CH"],"User-Agent":["Mozilla/5.0 Test"],"Referer":["https://www.google.com/search?q=x"]}},"bytes_read":0,"user_id":"","duration":0.00050925,"size":5,"status":200,"resp_headers":{"Server":["Caddy"],"Content-Type":["text/plain; charset=utf-8"]}}'
    const a = parseAccessLine(line)!
    assert.equal(a.at, 1794433682045)
    assert.equal(a.ip, '127.0.0.1')
    assert.equal(a.host, 'a.localhost')
    assert.equal(a.method, 'GET')
    assert.equal(a.path, '/seite')
    assert.equal(a.query, 'x=1')
    assert.equal(a.status, 200)
    assert.equal(a.userAgent, 'Mozilla/5.0 Test')
    assert.equal(a.referer, 'https://www.google.com/search?q=x')
    assert.equal(a.country, 'CH')
    assert.equal(a.contentType, 'text/plain; charset=utf-8')
    assert.equal(a.blocked, false)
  })

  test('hinter dem Tunnel: client_ip ist der Besucher, remote_ip cloudflared', () => {
    const a = parseAccessLine(caddyLine({ ip: '203.0.113.9', remoteIp: '172.30.0.5' }))!
    assert.equal(a.ip, '203.0.113.9')
    assert.equal(a.remoteIp, '172.30.0.5')
  })

  test('Host ohne Port und klein, Sperrseite erkannt, fehlender Content-Type leer', () => {
    const a = parseAccessLine(caddyLine({ host: 'Foto.INT.example.ch:443', blocked: true, status: 403, contentType: null }))!
    assert.equal(a.host, 'foto.int.example.ch')
    assert.equal(a.blocked, true)
    assert.equal(a.contentType, '')
  })

  test('andere Logger, kaputtes JSON und Zeilen ohne Adresse werden übersprungen', () => {
    assert.equal(parseAccessLine(caddyLine({ logger: 'http.log.access.site' })), null)
    assert.equal(parseAccessLine('{"logger":"http.log.access.visits", kaputt'), null)
    assert.equal(parseAccessLine('2026/11/11 14:30:00 [INFO] http.log.access.visits'), null)
    assert.equal(parseAccessLine(JSON.stringify({ ts: 1, logger: 'http.log.access.visits', request: { host: 'x' } })), null)
  })

  test('ohne User-Agent: leerer Text (zählt später als Bot)', () => {
    assert.equal(parseAccessLine(caddyLine({ ua: null }))!.userAgent, '')
  })
})

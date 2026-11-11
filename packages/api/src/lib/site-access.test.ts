import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSiteAccess, shortenIp } from './site-access.js'

const line = (o: Record<string, unknown>) => JSON.stringify({ level: 'info', logger: 'http.log.access.site', msg: 'handled request', ...o })

test('IP gekürzt: IPv4 ohne letztes Oktett, IPv6 drei Gruppen', () => {
  assert.equal(shortenIp('192.168.1.77'), '192.168.1.x')
  assert.equal(shortenIp('2001:db8:85a3:0:0:8a2e:370:7334'), '2001:db8:85a3:…')
  assert.equal(shortenIp('::ffff:10.0.0.5'), '10.0.0.x')
  assert.equal(shortenIp(undefined), '–')
})

test('Nur Zeilen des Site-Loggers für die Namen des Projekts, neueste zuerst', () => {
  const t = 1_800_000_000
  const log = [
    line({ ts: t, status: 200, duration: 0.0012, size: 1840, request: { method: 'GET', host: 'hallo.example.ch', uri: '/', client_ip: '84.72.10.3' } }),
    line({ ts: t + 5, status: 404, duration: 0.0004, request: { method: 'GET', host: 'hallo.example.ch:443', uri: '/favicon.ico', remote_ip: '100.88.1.2' } }),
    line({ ts: t + 6, status: 200, request: { method: 'GET', host: 'andere.example.ch', uri: '/' } }),
    JSON.stringify({ logger: 'http.log.access.airlock', ts: t + 7, request: { host: 'hallo.example.ch' } }),
    'kein json',
  ].join('\n')
  const r = parseSiteAccess(log, { hosts: ['hallo.example.ch'], sinceMs: 0 })
  assert.equal(r.length, 2)
  assert.equal(r[0]!.status, 404)
  assert.equal(r[0]!.ip, '100.88.1.x')
  assert.equal(r[1]!.durationMs, 1.2)
  assert.equal(r[1]!.bytes, 1840)
  assert.equal(parseSiteAccess(log, { hosts: ['hallo.example.ch'], sinceMs: (t + 1) * 1000 }).length, 1)
})

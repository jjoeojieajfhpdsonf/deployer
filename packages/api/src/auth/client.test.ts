import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { accessOf, clientIp, deviceLabel, inCidr } from './client.js'
import { passkeyHostFor } from './rp.js'

describe('Gerät, Zugang, Absender', () => {
  test('Gerät aus dem User-Agent', () => {
    assert.equal(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0'), 'Firefox auf macOS')
    assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'), 'Edge auf Windows')
    assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari auf iPhone')
    assert.equal(deviceLabel('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'), 'Chrome auf Linux')
    assert.equal(deviceLabel(null), null)
    assert.equal(deviceLabel('irgendwas/1.0'), null)
  })

  test('Zugang aus der Adresse', () => {
    assert.equal(accessOf('100.101.102.103', '192.168.1.0/24'), 'tailnet')
    assert.equal(accessOf('192.168.1.20', '192.168.1.0/24'), 'lan')
    assert.equal(accessOf('::ffff:192.168.1.20', '192.168.1.0/24'), 'lan')
    assert.equal(accessOf('172.18.0.1', '192.168.1.0/24'), 'gateway')
    assert.equal(accessOf('172.20.5.9', '172.20.0.0/16'), 'lan', 'LAN im 172er-Bereich')
    assert.equal(accessOf('127.0.0.1', null), 'server')
    assert.equal(accessOf('8.8.8.8', null), 'unknown')
    assert.equal(accessOf(null, null), 'unknown')
    assert.equal(inCidr('10.1.2.3', '10.0.0.0/8'), true)
    assert.equal(inCidr('11.1.2.3', '10.0.0.0/8'), false)
  })

  test('X-Forwarded-For nur von Caddy', () => {
    const caddy = new Set(['172.18.0.5'])
    assert.equal(clientIp('172.18.0.5', '192.168.1.20', caddy), '192.168.1.20')
    // Vorgetäuschter Kopf eines anderen Absenders: zählt nicht
    assert.equal(clientIp('172.18.0.9', '1.2.3.4', caddy), '172.18.0.9')
    // Mehrere Einträge: der letzte (von Caddy angehängt) gilt
    assert.equal(clientIp('172.18.0.5', '6.6.6.6, 100.64.0.7', caddy), '100.64.0.7')
    assert.equal(clientIp('::ffff:172.18.0.5', ['192.168.1.30'], caddy), '192.168.1.30')
    assert.equal(clientIp('172.18.0.5', 'kein-ip', caddy), '172.18.0.5')
    assert.equal(clientIp('172.18.0.5', undefined, caddy), '172.18.0.5')
  })
})

describe('Wo Passkeys gelten (RP-ID)', () => {
  const base = { https: true, tls: true, baseDomain: 'int.example.ch', label: 'deployer', dev: false, origin: null }

  test('Hauptadresse über HTTPS: verfügbar', () => {
    const r = passkeyHostFor({ ...base, host: 'deployer.int.example.ch' })
    assert.deepEqual(r.rp, { rpID: 'deployer.int.example.ch', origin: 'https://deployer.int.example.ch' })
    assert.equal(r.dto.available, true)
    assert.equal(passkeyHostFor({ ...base, host: 'Deployer.INT.example.ch:443' }).dto.available, true)
  })

  test('nip.io-Ausweich: nicht verfügbar, mit Link zur Hauptadresse', () => {
    const r = passkeyHostFor({ ...base, host: 'deployer.100-64-1-1.nip.io', https: false })
    assert.equal(r.rp, null)
    assert.deepEqual(r.dto, { available: false, rpId: 'deployer.int.example.ch', mainUrl: 'https://deployer.int.example.ch', reason: 'other_host' })
  })

  test('ohne HTTPS bzw. ohne Zertifikat oder Basis: nicht verfügbar', () => {
    assert.equal(passkeyHostFor({ ...base, host: 'deployer.int.example.ch', https: false }).dto.reason, 'no_https')
    assert.equal(passkeyHostFor({ ...base, host: 'deployer.int.example.ch', tls: false }).dto.reason, 'no_https')
    assert.equal(passkeyHostFor({ ...base, host: 'x', baseDomain: null }).dto.reason, 'no_base_domain')
  })

  test('nie die Basis selbst oder ein Projektname', () => {
    assert.equal(passkeyHostFor({ ...base, host: 'int.example.ch' }).rp, null)
    assert.equal(passkeyHostFor({ ...base, host: 'blog.int.example.ch' }).rp, null)
  })

  test('localhost nur in der Entwicklung', () => {
    const dev = passkeyHostFor({ ...base, host: 'localhost:5173', https: false, dev: true, origin: 'http://localhost:5173' })
    assert.deepEqual(dev.rp, { rpID: 'localhost', origin: 'http://localhost:5173' })
    assert.equal(passkeyHostFor({ ...base, host: 'localhost:5173', https: false, dev: false, origin: 'http://localhost:5173' }).rp, null)
  })
})

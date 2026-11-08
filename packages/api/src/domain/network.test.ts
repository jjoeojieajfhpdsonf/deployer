import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'

/** Netz des Servers aus `ip route` / `ip addr` lesen. */

let mod: typeof import('./network.js')

before(async () => {
  process.env.DATABASE_URL ??= 'postgres://x@localhost/x'
  process.env.ADMIN_PASSWORD ??= 'x'
  mod = await import('./network.js')
})

const ADDRS = `---
1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever
2: wlp3s0    inet 192.168.1.23/24 brd 192.168.1.255 scope global dynamic noprefixroute wlp3s0\\       valid_lft 85000sec
3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever
5: br-1a2b3c    inet 172.27.0.1/16 brd 172.27.255.255 scope global br-1a2b3c\\       valid_lft forever
7: tailscale0    inet 100.101.102.103/32 scope global tailscale0\\       valid_lft forever`

describe('parseIpOutput', () => {
  test('LAN über die Standardroute, Tailscale über tailscale0', () => {
    const d = mod.parseIpOutput(`1.1.1.1 via 192.168.1.1 dev wlp3s0 src 192.168.1.23 uid 0\n    cache\n${ADDRS}`)
    assert.deepEqual(d, { lanIp: '192.168.1.23', lanCidr: '192.168.1.0/24', lanDev: 'wlp3s0', tailscaleIp: '100.101.102.103' })
  })
  test('Standardroute über Tailscale (Exit-Node): LAN trotzdem die private Adresse', () => {
    const d = mod.parseIpOutput(`1.1.1.1 dev tailscale0 table 52 src 100.101.102.103 uid 0\n${ADDRS}`)
    assert.equal(d.lanIp, '192.168.1.23')
    assert.equal(d.tailscaleIp, '100.101.102.103')
  })
  test('ohne Tailscale', () => {
    const d = mod.parseIpOutput(`1.1.1.1 via 10.0.0.1 dev eth0 src 10.0.0.42 uid 0\n---\n2: eth0    inet 10.0.0.42/22 brd 10.0.3.255 scope global eth0`)
    assert.deepEqual(d, { lanIp: '10.0.0.42', lanCidr: '10.0.0.0/22', lanDev: 'eth0', tailscaleIp: null })
  })
  test('nur Docker-Netze: keine LAN-IP statt einer falschen', () => {
    const d = mod.parseIpOutput(`---\n3: docker0    inet 172.17.0.1/16 scope global docker0`)
    assert.equal(d.lanIp, null)
  })
})

test('networkOf', () => {
  assert.equal(mod.networkOf('192.168.1.23/24'), '192.168.1.0/24')
  assert.equal(mod.networkOf('10.0.2.200/22'), '10.0.0.0/22')
  assert.equal(mod.networkOf('kaputt'), null)
})

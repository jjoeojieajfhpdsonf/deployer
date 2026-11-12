import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateEgressEvents, inCidr4, parseEgressLine } from './events.js'

/** Nacht 3, Etappe 4: Zeilen des Firewall-Dienstes lesen und bündeln (Format aus dem Smoke-Test) */

const G = { observe: 7801, block: 7802 }

describe('Zeilen aus events.log', () => {
  test('TCP, UDP, ICMP, IPv6 – Ziel, Port, Urteil', () => {
    const tcp = parseEgressLine('7801 1794482145.285395 IP 192.168.16.3.37619 > 192.168.16.1.23835: tcp 0', G)
    assert.deepEqual(tcp, { at: new Date(1794482145000), verdict: 'beobachtet', protocol: 'tcp', source: '192.168.16.3', destination: '192.168.16.1', port: 23835 })
    const udp = parseEgressLine('7802 1794482146.373525 IP 172.20.0.3.40000 > 192.168.0.1.53: UDP, length 30', G)
    assert.equal(udp?.verdict, 'gesperrt')
    assert.equal(udp?.protocol, 'udp')
    assert.equal(udp?.port, 53)
    const icmp = parseEgressLine('7802 1794482146.373525 IP 172.20.0.3 > 192.168.0.1: ICMP echo request, id 3, seq 0, length 64', G)
    assert.deepEqual({ p: icmp?.protocol, d: icmp?.destination, port: icmp?.port }, { p: 'icmp', d: '192.168.0.1', port: null })
    const v6 = parseEgressLine('7801 1794482146.1 IP6 fd00::2.40000 > FD00::1.80: tcp 0', G)
    assert.deepEqual({ s: v6?.source, d: v6?.destination, port: v6?.port }, { s: 'fd00::2', d: 'fd00::1', port: 80 })
  })

  test('Unbekanntes wird verworfen: fremde Gruppe, abgeschnittene Zeile, Müll', () => {
    assert.equal(parseEgressLine('7900 1794482145.2 IP 1.2.3.4.5 > 5.6.7.8.9: tcp 0', G), null)
    assert.equal(parseEgressLine('7801 1794482070.340418  [|nflog]', G), null)
    assert.equal(parseEgressLine('7801 1794482070.3 IP 1.2.3.4.5 > $(rm).9: tcp 0', G), null)
    assert.equal(parseEgressLine('', G), null)
    assert.equal(parseEgressLine('7801 1794482070.3 IP 1.2.3.4.5 > 5.6.7.8.99999: tcp 0', G), null)
  })
})

describe('Bündeln', () => {
  test('gleiches Ziel in derselben Stunde: ein Eintrag mit Zähler; unbekannte Quelle fällt weg', () => {
    const lines = [
      '7801 1794480000.1 IP 172.20.0.3.1000 > 192.168.0.12.445: tcp 0',
      '7801 1794480010.1 IP 172.20.0.4.1001 > 192.168.0.12.445: tcp 0',
      '7801 1794480020.1 IP 172.20.0.3.1002 > 192.168.0.12.445: tcp 0',
      '7802 1794480020.1 IP 172.20.0.3.1002 > 192.168.0.12.445: tcp 0',
      '7801 1794483700.1 IP 172.20.0.3.1003 > 192.168.0.12.445: tcp 0',
      '7801 1794480000.1 IP 10.99.0.3.1000 > 192.168.0.12.445: tcp 0',
      '7801 1794480000.1 IP 172.20.0.3.1000 > 172.20.0.1.22: tcp 0',
    ]
    const ev = lines.map((l) => parseEgressLine(l, G)).filter((e) => e !== null)
    const rows = aggregateEgressEvents(ev, (src) => (inCidr4(src, '172.20.0.0/16') ? 'p1' : null), (dst) => dst === '172.20.0.1')
    const first = rows.find((r) => r.verdict === 'beobachtet' && r.destination === '192.168.0.12' && r.bucket.getTime() === 1794477600000)
    assert.equal(first?.count, 3)
    assert.equal(first?.port, 445)
    assert.deepEqual([first?.firstSeen.getTime(), first?.lastSeen.getTime()], [1794480000000, 1794480020000])
    assert.equal(rows.filter((r) => r.destination === '192.168.0.12').length, 3, 'beobachtet (2 Stunden) + gesperrt')
    assert.equal(rows.find((r) => r.destination === '172.20.0.1')?.toServer, true)
    assert.equal(rows.length, 4)
  })

  test('inCidr4', () => {
    assert.equal(inCidr4('172.20.5.9', '172.20.0.0/16'), true)
    assert.equal(inCidr4('172.21.0.1', '172.20.0.0/16'), false)
    assert.equal(inCidr4('10.0.0.1', '10.0.0.1'), true)
    assert.equal(inCidr4('fd00::1', '172.20.0.0/16'), false)
  })
})

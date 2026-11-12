import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EGRESS_BLOCKED_V4, EGRESS_BLOCKED_V6 } from '@airlock/shared'
import { normalizeCidr, renderEgressRules, type EgressNetworkRules } from './rules.js'

/**
 * Nacht 3, Etappe 4: Regel-Erzeugung als reine Funktion, festgehalten in
 * Golden-Files (golden/*.nft). Neu schreiben nach einer gewollten Änderung:
 *
 *   UPDATE_GOLDEN=1 pnpm --filter @airlock/api exec tsx --test src/egress/rules.test.ts
 *
 * und die Änderung im Diff ansehen. Dass nft die Dateien annimmt und der
 * Dienst sie gegen seine Grammatik prüft, zeigt scripts/smoke-ausgang.sh.
 */

const here = dirname(fileURLToPath(import.meta.url))
const goldenDir = join(here, 'golden')
const repo = join(here, '..', '..', '..', '..')

function golden(name: string, text: string): void {
  const file = join(goldenDir, `${name}.nft`)
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(goldenDir, { recursive: true })
    writeFileSync(file, text)
  }
  assert.equal(text, readFileSync(file, 'utf8'), `Golden-File ${name}.nft weicht ab (UPDATE_GOLDEN=1 schreibt neu)`)
}

const shop: EgressNetworkRules = { network: 'air_shop', bridge: 'br-0a1b2c3d4e5f', mode: 'internet', enforce: false, allow: [] }

describe('Regeln für den Container-Ausgang (Golden-Files)', () => {
  test('ohne Projekt-Netz: nur die leeren Basisketten', () => {
    golden('leer', renderEgressRules([]))
  })

  test('internet, beobachten: protokolliert private Ziele, sperrt nichts', () => {
    const t = renderEgressRules([shop])
    golden('internet-beobachten', t)
    assert.doesNotMatch(t, /reject/)
    assert.match(t, /log group 7801/)
    assert.doesNotMatch(t, /log group 7802/)
  })

  test('internet, durchsetzen, mit Ausnahmen (NAS mit Port, Netz, IPv6, doppelt)', () => {
    const t = renderEgressRules([{
      ...shop,
      enforce: true,
      allow: [
        { address: '192.168.1.10', family: 4, port: 445, protocol: 'tcp' },
        { address: '192.168.1.10', family: 4, port: 445, protocol: 'tcp' },
        { address: '10.20.0.0/16', family: 4, port: null, protocol: 'tcp' },
        { address: 'fd00:0:0:0:0:0:0:5', family: 6, port: 53, protocol: 'udp' },
      ],
    }])
    golden('internet-durchsetzen-ausnahmen', t)
    assert.equal(t.match(/ip daddr 192\.168\.1\.10 tcp dport 445 return/g)?.length, 2, 'je einmal in p_ und h_')
  })

  test('abgeschottet, durchsetzen: alles ausser Antworten und eigenem Netz gesperrt, kein DNS', () => {
    const t = renderEgressRules([{ ...shop, mode: 'abgeschottet', enforce: true }])
    golden('abgeschottet-durchsetzen', t)
    assert.doesNotMatch(t, /dport 53/)
  })

  test('mehrere Netze: nach Bridge sortiert, gleiche Eingabe gleicher Text', () => {
    const a: EgressNetworkRules = { network: 'air_blog', bridge: 'br-ffffffffffff', mode: 'internet', enforce: true, allow: [] }
    const b: EgressNetworkRules = { network: 'air_wiki', bridge: 'br-000000000001', mode: 'abgeschottet', enforce: false, allow: [] }
    const t = renderEgressRules([a, b, shop])
    golden('mehrere', t)
    assert.equal(renderEgressRules([shop, b, a]), t)
  })

  /**
   * Vorlagen für scripts/smoke-ausgang.sh (auf dem Server gibt es kein node):
   * eigene Tabelle und NFLOG-Gruppen, Platzhalter für die Bridge
   * (br-5e0b0000c0de) und die Ausnahme (192.0.2.80, TCP 18080), die das
   * Skript durch das Test-Netz bzw. das Gateway und einen freien Port ersetzt.
   */
  test('Vorlagen des Smoke-Tests: beobachten, durchsetzen, abgeschottet', () => {
    const o = { table: 'airlock_smoke', observeGroup: 7811, blockGroup: 7812 }
    const net: EgressNetworkRules = {
      network: 'air_smoke', bridge: 'br-5e0b0000c0de', mode: 'internet', enforce: false,
      allow: [{ address: '192.0.2.80', family: 4, port: 18080, protocol: 'tcp' }],
    }
    golden('smoke-beobachten', renderEgressRules([net], o))
    golden('smoke-durchsetzen', renderEgressRules([{ ...net, enforce: true }], o))
    golden('smoke-abgeschottet', renderEgressRules([{ ...net, mode: 'abgeschottet', enforce: true }], o))
  })
})

describe('Eingaben, die nie in die Regeln gelangen', () => {
  test('Bridge ausserhalb br-<12 hex> (eth0, docker0, tailscale0) wird abgelehnt', () => {
    for (const bridge of ['eth0', 'docker0', 'tailscale0', 'br-0a1b2c3d4e5', 'br-0A1B2C3D4E5F', 'br-0a1b2c3d4e5f"']) {
      assert.throws(() => renderEgressRules([{ ...shop, bridge }]), /Bridge/)
    }
  })
  test('doppelte Bridge, ungültiger Port, Netzname, Tabelle', () => {
    assert.throws(() => renderEgressRules([shop, shop]), /doppelt/)
    assert.throws(() => renderEgressRules([{ ...shop, allow: [{ address: '1.2.3.4', family: 4, port: 70000, protocol: 'tcp' }] }]), /Port/)
    assert.throws(() => renderEgressRules([{ ...shop, network: 'air_x"; flush ruleset' }]), /Netzname/)
    assert.throws(() => renderEgressRules([], { table: 'filter; flush', observeGroup: 1, blockGroup: 2 }), /Tabelle/)
    assert.throws(() => renderEgressRules([{ ...shop, allow: [{ address: '1.2.3.4 } accept', family: 4, port: null, protocol: 'tcp' }] }]), /Adresse/)
  })
})

describe('Adressen normalisieren', () => {
  test('Host-Bits weg, IPv6 ausgeschrieben', () => {
    assert.equal(normalizeCidr('192.168.1.77/24', 4), '192.168.1.0/24')
    assert.equal(normalizeCidr('10.1.2.3', 4), '10.1.2.3')
    assert.equal(normalizeCidr('10.1.2.3/32', 4), '10.1.2.3')
    assert.equal(normalizeCidr('172.31.255.1/12', 4), '172.16.0.0/12')
    assert.equal(normalizeCidr('fd00::5', 6), 'fd00:0:0:0:0:0:0:5')
    assert.equal(normalizeCidr('FD12:3456::1/48', 6), 'fd12:3456:0:0:0:0:0:0/48')
    assert.equal(normalizeCidr('2001:db8:abcd:12ff::/52', 6), '2001:db8:abcd:1000:0:0:0:0/52')
  })
})

test('Firewall-Dienst prüft dieselben gesperrten Netze wie Airlock erzeugt', () => {
  const sh = readFileSync(join(repo, 'firewall', 'airlock-fw'), 'utf8')
  assert.ok(sh.includes(`V4LIST='${EGRESS_BLOCKED_V4.join(', ')}'`), 'V4LIST in firewall/airlock-fw')
  assert.ok(sh.includes(`V6LIST='${EGRESS_BLOCKED_V6.join(', ')}'`), 'V6LIST in firewall/airlock-fw')
  assert.ok(sh.includes("LIMIT='limit rate 20/minute burst 20 packets'"), 'LIMIT in firewall/airlock-fw')
})

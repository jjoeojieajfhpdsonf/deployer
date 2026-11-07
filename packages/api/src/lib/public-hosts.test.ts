import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePublicHostname, reconcileIngress, PublicHostError, TUNNEL_SERVICE, tunnelCname } from './public-hosts.js'

const zones = [{ id: 'z1', name: 'example.ch' }, { id: 'z2', name: 'beispiel.ch' }]
const o = { zones, defaultZone: 'example.ch', internalBaseDomain: 'int.example.ch', reservedLabels: ['deployer', 'ext-scan'] }

describe('resolvePublicHostname', () => {
  test('Subdomain + Standard-Zone', () => {
    assert.deepEqual(resolvePublicHostname({ subdomain: 'Solar' }, o), { hostname: 'solar.example.ch', zone: zones[0] })
  })
  test('voller Hostname in einer anderen Zone des Kontos', () => {
    assert.equal(resolvePublicHostname({ hostname: 'blog.beispiel.ch.' }, o).zone.id, 'z2')
  })
  test('abgelehnt: intern, Apex, zweite Ebene, fremde Zone, reserviert, ungültig', () => {
    const bad: [Record<string, string>, RegExp][] = [
      [{ hostname: 'solar.int.example.ch' }, /internen Basisdomain/],
      [{ hostname: 'int.example.ch' }, /internen Basisdomain/],
      [{ hostname: 'example.ch' }, /Zone selbst/],
      [{ hostname: 'a.b.example.ch' }, /mehr als eine Ebene/],
      [{ hostname: 'solar.fremd.ch' }, /keiner Zone/],
      [{ subdomain: 'deployer' }, /reserviert/],
      [{ hostname: 'bad_name.example.ch' }, /kein gültiger/],
      [{}, /Subdomain oder einen Hostnamen/],
    ]
    for (const [input, re] of bad) {
      assert.throws(() => resolvePublicHostname(input, o), (e: unknown) => e instanceof PublicHostError && re.test(e.message), JSON.stringify(input))
    }
  })
  test('ohne Standard-Zone braucht es den vollen Namen', () => {
    assert.throws(() => resolvePublicHostname({ subdomain: 'x' }, { ...o, defaultZone: null }), /Keine Standard-Domain/)
  })
})

describe('reconcileIngress', () => {
  const foreign = { hostname: 'ha.example.ch', service: 'http://192.168.1.5:8123' }
  test('eigene Namen zuerst, fremde Regeln danach in alter Reihenfolge, Pflicht-Regel am Ende', () => {
    const r = reconcileIngress([foreign, { hostname: 'alt.example.ch', service: TUNNEL_SERVICE }, { service: 'http_status:404' }], ['solar.example.ch', 'Blog.example.ch'], ['alt.example.ch'])
    assert.deepEqual(r.ingress, [
      { hostname: 'blog.example.ch', service: TUNNEL_SERVICE },
      { hostname: 'solar.example.ch', service: TUNNEL_SERVICE },
      foreign,
      { service: 'http_status:404' },
    ])
    assert.deepEqual(r.managed, ['blog.example.ch', 'solar.example.ch'])
  })
  test('eine fremde Wildcard verdeckt die eigenen Namen nicht', () => {
    const wild = { hostname: '*.example.ch', service: 'http://nas:5000' }
    const r = reconcileIngress([wild, { service: 'http_status:404' }], ['solar.example.ch'], [])
    assert.deepEqual(r.ingress.map((x) => x.hostname), ['solar.example.ch', '*.example.ch', undefined])
  })
  test('fremde Regeln nur mit Pfad und eine eigene Auffangregel bleiben', () => {
    const pathOnly = { path: '^/status$', service: 'http://status:80' }
    const own404 = { service: 'http://homeassistant:8123' }
    const r = reconcileIngress([pathOnly, own404], ['x.example.ch'], [])
    assert.deepEqual(r.ingress, [{ hostname: 'x.example.ch', service: TUNNEL_SERVICE }, pathOnly, own404])
  })
  test('leere Wunschliste: nur fremde Regeln und die Pflicht-Regel', () => {
    const r = reconcileIngress([foreign, { hostname: 'alt.example.ch', service: TUNNEL_SERVICE }, { service: 'http_status:404' }], [], ['alt.example.ch'])
    assert.deepEqual(r.ingress, [foreign, { service: 'http_status:404' }])
  })
  test('leere Konfiguration bekommt die Pflicht-Regel', () => {
    assert.deepEqual(reconcileIngress([], [], []).ingress, [{ service: 'http_status:404' }])
  })
  test('verbotene Namen (deployer) kommen nie in den Tunnel', () => {
    const r = reconcileIngress([], ['deployer.example.ch', 'x.example.ch'], [], ['deployer.example.ch'])
    assert.deepEqual(r.managed, ['x.example.ch'])
  })
  test('eine fremde Regel mit demselben Namen wie eine gewünschte wird ersetzt, nicht verdoppelt', () => {
    const r = reconcileIngress([{ hostname: 'solar.example.ch', service: 'http://anders:80' }, { service: 'http_status:404' }], ['solar.example.ch'], [])
    assert.equal(r.ingress.filter((x) => x.hostname === 'solar.example.ch').length, 1)
    assert.equal(r.ingress[0]!.service, TUNNEL_SERVICE)
  })
  test('CNAME-Ziel', () => {
    assert.equal(tunnelCname('abc-123'), 'abc-123.cfargotunnel.com')
  })
})

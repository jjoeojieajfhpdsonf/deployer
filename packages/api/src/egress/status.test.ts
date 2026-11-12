import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { applyStateOf, parseStatusFile, serviceOf } from './status.js'

/** Nacht 3, Etappe 4: status.json des Firewall-Dienstes deuten */

const now = new Date('2026-11-12T03:00:00Z')
const fresh = (extra: object = {}) => ({ state: 'ok', heartbeat: '2026-11-12T02:59:55Z', nft: 'nftables v1.1.6', applied: { sha256: 'aaa', at: '2026-11-12T02:59:00Z', networks: 3 }, lastSha256: 'aaa', error: null, ...extra })

describe('Zustand des Dienstes', () => {
  test('frisches Lebenszeichen: läuft', () => {
    const s = serviceOf(fresh(), now)
    assert.equal(s.state, 'laeuft')
    assert.equal(s.networks, 3)
    assert.equal(s.version, 'nftables v1.1.6')
  })
  test('ohne Datei, unlesbar oder älter als 60 s: aus (Regeln bleiben stehen)', () => {
    assert.equal(serviceOf(null, now).state, 'aus')
    assert.equal(parseStatusFile('{kaputt'), null)
    const old = serviceOf(fresh({ heartbeat: '2026-11-12T02:58:30Z' }), now)
    assert.equal(old.state, 'aus')
    assert.match(old.message ?? '', /bleiben im Kernel/)
  })
  test('Notausgang, Fehler, nicht unterstützt', () => {
    assert.equal(serviceOf(fresh({ state: 'disabled' }), now).state, 'abgeschaltet')
    assert.match(serviceOf(fresh({ state: 'disabled' }), now).message ?? '', /airlock-fw enable/)
    assert.equal(serviceOf(fresh({ state: 'error', error: 'Zeile 4: unbekannte Regel' }), now).state, 'fehler')
    assert.equal(serviceOf(fresh({ state: 'unsupported' }), now).state, 'nicht-unterstuetzt')
  })
})

describe('Stand eines Projekts', () => {
  const base = { mode: 'internet' as const, hasNetwork: true, skipped: null, status: fresh(), desiredSha: 'aaa' }
  const svc = (st: object = fresh()) => serviceOf(st, now)
  test('angewendet, ausstehend, abgelehnt', () => {
    assert.equal(applyStateOf({ ...base, service: svc() }).state, 'angewendet')
    assert.equal(applyStateOf({ ...base, service: svc(), desiredSha: 'bbb' }).state, 'ausstehend')
    const err = fresh({ state: 'error', lastSha256: 'bbb', error: 'Zeile 4' })
    assert.equal(applyStateOf({ ...base, status: err, service: svc(err), desiredSha: 'bbb' }).state, 'fehler')
  })
  test('frei, ohne Netz, Dienst aus, abgeschaltet, übersprungen', () => {
    assert.equal(applyStateOf({ ...base, mode: 'frei', service: svc() }).state, 'frei')
    assert.equal(applyStateOf({ ...base, hasNetwork: false, service: svc() }).state, 'ohne-netz')
    assert.equal(applyStateOf({ ...base, service: serviceOf(null, now), status: null }).state, 'dienst-aus')
    assert.equal(applyStateOf({ ...base, service: svc(fresh({ state: 'disabled' })) }).state, 'abgeschaltet')
    assert.equal(applyStateOf({ ...base, skipped: 'eigener Bridge-Name', service: svc() }).state, 'fehler')
  })
})

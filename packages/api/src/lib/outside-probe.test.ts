import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { classify, checkFromOutside, type Observation } from './outside-probe.js'

const cf = (status: number, over: Partial<Observation> = {}): Observation => ({ status, cfRay: true, maintenance: false, body: '', ...over })
const netErr = (error: string): Observation => ({ status: null, cfRay: false, maintenance: false, error })

describe('Prüfung von aussen: live', () => {
  test('200 über Cloudflare ist erreichbar', () => {
    const v = classify(cf(200), 'live')
    assert.equal(v.ok, true)
    assert.equal(v.viaCloudflare, true)
  })
  test('eine 401 der App selbst zählt als erreichbar', () => {
    assert.equal(classify(cf(401), 'live').ok, true)
  })
  test('Access: Weiterleitung zum Login ist erreichbar', () => {
    const v = classify(cf(302, { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' }), 'live', { access: true })
    assert.equal(v.ok, true)
    assert.match(v.message, /Access/)
  })
  test('Tunnel nicht verbunden (530) und DNS fehlt: noch nicht, weiter warten', () => {
    for (const o of [cf(530), netErr('Name löst nicht auf')]) {
      const v = classify(o, 'live')
      assert.equal(v.ok, false)
      assert.equal(v.final, false)
    }
  })
  test('Caddys eigene 404 ist nicht das Projekt', () => {
    assert.equal(classify(cf(404, { body: 'Kein Projekt unter diesem Namen.' }), 'live').ok, false)
    assert.equal(classify(cf(404, { body: 'Not Found' }), 'live').ok, true)
  })
  test('Caddys 403 (falscher Absender) ist endgültig', () => {
    const v = classify(cf(403, { body: 'Kein Zugriff von 172.18.0.1 auf x' }), 'live')
    assert.deepEqual([v.ok, v.final], [false, true])
  })
  test('noch die Wartungsseite: nicht live', () => {
    assert.equal(classify(cf(503, { maintenance: true }), 'live').ok, false)
  })
  test('Antwort ohne Cloudflare wird erwähnt', () => {
    const v = classify({ status: 200, cfRay: false, maintenance: false }, 'live')
    assert.equal(v.ok, true)
    assert.match(v.message, /nicht über Cloudflare/)
  })
})

describe('Prüfung von aussen: pausiert und weg', () => {
  test('pausiert verlangt 503 mit Kennung', () => {
    assert.equal(classify(cf(503, { maintenance: true }), 'paused').ok, true)
    assert.equal(classify(cf(503), 'paused').ok, false, '503 der App ist nicht die Wartungsseite')
    assert.equal(classify(cf(200), 'paused').ok, false)
  })
  test('weg: Name löst nicht auf oder Cloudflare hat keine Route', () => {
    assert.equal(classify(netErr('Name löst nicht auf'), 'gone').ok, true)
    assert.equal(classify(cf(530), 'gone').ok, true)
    assert.equal(classify(cf(200), 'gone').ok, false)
  })
})

describe('Wiederholen bis zum Ergebnis', () => {
  test('wartet, bis der Name antwortet', async () => {
    const seq = [netErr('Name löst nicht auf'), cf(530), cf(200)]
    let n = 0
    const r = await checkFromOutside('x.example.ch', 'live', { look: async () => seq[Math.min(n++, seq.length - 1)]!, intervalMs: 1, deadlineMs: 1000 })
    assert.equal(r.ok, true)
    assert.equal(n, 3)
  })
  test('gibt nach Ablauf den letzten Stand zurück', async () => {
    const r = await checkFromOutside('x.example.ch', 'live', { look: async () => cf(530), intervalMs: 1, deadlineMs: 20 })
    assert.equal(r.ok, false)
    assert.equal(r.status, 530)
  })
})

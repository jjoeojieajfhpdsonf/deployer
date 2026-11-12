import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { TrafficMeter, edgeKey, formatRate, liveSummary, liveTone, placeLabels, routeOf, type LiveRoute } from './live-traffic.js'

/** Etappe 4: Live-Verkehr im Aufbau – Weg, Zähler, Bündeln (ohne DOM) */

const EDGES = [
  { from: 'way:public', to: 'host:shop.example.ch' },
  { from: 'way:lan', to: 'host:shop.int.example.ch' },
  { from: 'host:shop.example.ch', to: 'svc:web' },
  { from: 'host:shop.int.example.ch', to: 'svc:web' },
]
const ev = (o: Partial<{ access: 'public' | 'lan' | 'tailnet'; host: string; service: string | null; blocked: boolean }> = {}) =>
  ({ access: 'public' as const, host: 'shop.example.ch', service: 'web', blocked: false, ...o })
const FULL: LiveRoute = { edges: [edgeKey('way:public', 'host:shop.example.ch'), edgeKey('host:shop.example.ch', 'svc:web')], blocked: false }
const T0 = Date.parse('2026-11-10T14:00:00+01:00')

describe('Weg einer Anfrage', () => {
  test('Zugang → Host → Dienst', () => {
    assert.deepEqual(routeOf(ev(), EDGES), FULL)
  })
  test('geblockt: endet am Eingang', () => {
    assert.deepEqual(routeOf(ev({ blocked: true, service: null }), EDGES), { edges: ['way:public>host:shop.example.ch'], blocked: true })
  })
  test('ohne Dienst (Pause-Seite): nur bis zum Host, ohne ✕', () => {
    assert.deepEqual(routeOf(ev({ service: null }), EDGES), { edges: ['way:public>host:shop.example.ch'], blocked: false })
  })
  test('Host oder Zugang unbekannt: kein Weg', () => {
    assert.equal(routeOf(ev({ host: 'alt.example.ch' }), EDGES), null)
    assert.equal(routeOf(ev({ access: 'tailnet' }), EDGES), null)
  })
  test('Gross-/Kleinschreibung des Hosts egal', () => {
    assert.deepEqual(routeOf(ev({ host: 'SHOP.example.ch' }), EDGES), FULL)
  })
})

describe('Zähler', () => {
  test('pro Linie über 60 s, 4xx/5xx/abgewiesen getrennt', () => {
    const m = new TrafficMeter()
    for (let i = 0; i < 10; i++) m.add(FULL, 200, T0 + i * 1000)
    m.add(FULL, 404, T0 + 11_000)
    m.add(FULL, 502, T0 + 12_000)
    m.add({ edges: [FULL.edges[0]!], blocked: true }, 403, T0 + 13_000)
    const c = m.counts(T0 + 14_000)
    assert.deepEqual(c.get(FULL.edges[0]!), { n: 13, n4: 1, n5: 1, blocked: 1 })
    assert.deepEqual(c.get(FULL.edges[1]!), { n: 12, n4: 1, n5: 1, blocked: 0 })
    assert.deepEqual(m.totals(T0 + 14_000), { n: 13, n4: 1, n5: 1, blocked: 1 })
  })
  test('ältere Anfragen fallen nach 60 s heraus', () => {
    const m = new TrafficMeter()
    m.add(FULL, 200, T0)
    m.add(FULL, 200, T0 + 30_000)
    assert.equal(m.counts(T0 + 59_000).get(FULL.edges[0]!)?.n, 2)
    assert.equal(m.counts(T0 + 61_000).get(FULL.edges[0]!)?.n, 1)
    assert.equal(m.counts(T0 + 91_000).has(FULL.edges[0]!), false)
  })
  test('Format: «12/min», ab 1000 gekürzt', () => {
    assert.equal(formatRate(12), '12/min')
    assert.equal(formatRate(1200), '1.2k/min')
    assert.equal(formatRate(25_000), '25k/min')
  })
  test('Legende mit Worten', () => {
    assert.equal(liveSummary({ n: 0, n4: 0, n5: 0, blocked: 0 }), 'keine Anfragen in der letzten Minute')
    assert.equal(liveSummary({ n: 34, n4: 2, n5: 1, blocked: 3 }), '34/min · 2× 4xx · 1× 5xx · 3 abgewiesen')
  })
  test('Farbe nach Status', () => {
    assert.deepEqual([liveTone(200), liveTone(304), liveTone(404), liveTone(503)], ['ok', 'ok', '4xx', '5xx'])
  })
})

describe('Bündeln über 20 Anfragen pro Sekunde', () => {
  test('bis 20/s: jeder bekommt einen Punkt', () => {
    const m = new TrafficMeter()
    const r = Array.from({ length: 20 }, (_, i) => m.add(FULL, 200, T0 + i * 50))
    assert.ok(r.every((x) => x.dot && !x.bundled))
    assert.equal(m.bundledEdges(T0 + 999).size, 0)
  })
  test('ab der 21. in einer Sekunde: gebündelt, höchstens ein Punkt alle 200 ms', () => {
    const m = new TrafficMeter()
    const r = Array.from({ length: 100 }, (_, i) => m.add(FULL, 200, T0 + i * 10)) // 100 in 1 s
    assert.ok(r.slice(0, 20).every((x) => x.dot && !x.bundled))
    const bundled = r.slice(20)
    assert.ok(bundled.every((x) => x.bundled))
    const dots = bundled.filter((x) => x.dot).length
    assert.ok(dots >= 3 && dots <= 5, `Punkte gebündelt: ${dots}`)
    assert.deepEqual([...m.bundledEdges(T0 + 1000)].sort(), [...FULL.edges].sort())
    // Alle zählen trotzdem
    assert.equal(m.counts(T0 + 1000).get(FULL.edges[0]!)?.n, 100)
  })
  test('unter 15/s wieder einzeln (Hysterese)', () => {
    const m = new TrafficMeter()
    for (let i = 0; i < 30; i++) m.add(FULL, 200, T0 + i * 30)
    assert.equal(m.bundledEdges(T0 + 900).size, 2)
    // Eine Sekunde später ist die Rate gefallen
    assert.equal(m.bundledEdges(T0 + 2500).size, 0)
    assert.deepEqual(m.add(FULL, 200, T0 + 2600), { dot: true, bundled: false })
  })
  test('andere Wege bleiben einzeln', () => {
    const m = new TrafficMeter()
    for (let i = 0; i < 40; i++) m.add(FULL, 200, T0 + i * 10)
    const lan: LiveRoute = { edges: ['way:lan>host:shop.int.example.ch', 'host:shop.int.example.ch>svc:web'], blocked: false }
    assert.deepEqual(m.add(lan, 200, T0 + 400), { dot: true, bundled: false })
  })
})

describe('Zähler nicht übereinander', () => {
  test('gleiche Spalte, fast gleiche Höhe: nach unten geschoben', () => {
    const out = placeLabels([{ key: 'a', x: 100, y: 50 }, { key: 'b', x: 105, y: 55 }, { key: 'c', x: 300, y: 52 }])
    assert.deepEqual(out.map((l) => [l.key, l.y]), [['a', 50], ['b', 68], ['c', 52]])
  })
})

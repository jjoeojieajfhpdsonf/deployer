import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { MAP_HEIGHT, MAP_WIDTH, countryShapes, type Topology } from './world-map.js'

const require = createRequire(import.meta.url)

describe('Weltkarte: TopoJSON → SVG-Pfade', () => {
  test('kleine Topologie: Bögen delta-dekodiert, umgedrehte Bögen, Code aus der Nummer', () => {
    const t: Topology = {
      transform: { scale: [1, 1], translate: [-180, -90] },
      // Quadrat 0..10 / 0..10 Grad (um 180/90 verschoben), zwei Bögen
      arcs: [[[180, 90], [10, 0], [0, 10]], [[180, 90], [0, 10], [10, 0]]],
      objects: { countries: { geometries: [
        { type: 'Polygon', id: '756', properties: { name: 'Switzerland' }, arcs: [[0, -2]] },
        { type: 'Polygon', id: '010', properties: { name: 'Antarctica' }, arcs: [[0]] },
        { type: 'Polygon', properties: { name: 'Kosovo' }, arcs: [[1]] },
      ] } },
    }
    const s = countryShapes(t)
    assert.deepEqual(s.map((x) => x.code), ['CH', 'XK'])
    // (0,0) → x 180, y 84; (10,0) → 190; (10,10) → y 74
    assert.equal(s[0]!.d, 'M180.0,84.0L190.0,84.0L190.0,74.0L180.0,74.0L180.0,84.0Z')
  })

  test('Natural Earth 1:110 Mio. (world-atlas): Schweiz, Deutschland, USA vorhanden, Antarktis nicht, alles im Ausschnitt', () => {
    const t = require('world-atlas/countries-110m.json') as Topology
    const s = countryShapes(t)
    const codes = new Set(s.map((x) => x.code))
    for (const c of ['CH', 'DE', 'US', 'BR', 'JP', 'AU', 'ZA', 'GB', 'FR', 'RS', 'BJ', 'BF', 'YE', 'ZW', 'XK']) assert.ok(codes.has(c), c)
    assert.ok(!codes.has('AQ'))
    assert.ok(s.length > 170)
    assert.equal(codes.size, s.length, 'jeder Code nur einmal')
    for (const x of s) {
      for (const [, a, b] of x.d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)) {
        assert.ok(Number(a) >= 0 && Number(a) <= MAP_WIDTH && Number(b) >= 0 && Number(b) <= MAP_HEIGHT, `${x.code} ausserhalb`)
      }
    }
  })
})

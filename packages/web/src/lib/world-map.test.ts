import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { MAP_HEIGHT, MAP_MIN_W, MAP_VIEWS, MAP_WIDTH, clampBox, countryShapes, panBox, sameBox, zoomBox, type MapBox, type Topology } from './world-map.js'

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
    // Punkt «letzter Aufruf»: Mitte des Landes (Schweiz um 8° O / 47° N; USA ohne Alaska)
    const ch = s.find((x) => x.code === 'CH')!
    assert.ok(Math.abs(ch.cx - 188.2) < 1.5 && Math.abs(ch.cy - (84 - 46.8)) < 1.5, `CH ${ch.cx},${ch.cy}`)
    const us = s.find((x) => x.code === 'US')!
    assert.ok(us.cx > 180 - 105 && us.cx < 180 - 90, `US ${us.cx}`)
    for (const x of s) {
      for (const [, a, b] of x.d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)) {
        assert.ok(Number(a) >= 0 && Number(a) <= MAP_WIDTH && Number(b) >= 0 && Number(b) <= MAP_HEIGHT, `${x.code} ausserhalb`)
      }
    }
  })
})

describe('Weltkarte: Zoomen und Verschieben', () => {
  const world: MapBox = MAP_VIEWS.world
  const ratio = (b: MapBox) => b.w / b.h
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6

  test('jeder Ausschnitt hat das Seitenverhältnis der Fläche (auch Europa)', () => {
    assert.ok(near(ratio(MAP_VIEWS.europe), MAP_WIDTH / MAP_HEIGHT))
    // Europa: 72° N bis 34° N, Portugal bis Kaspisches Meer im Bild
    assert.equal(MAP_VIEWS.europe.y, 84 - 72)
    assert.ok(MAP_VIEWS.europe.x < 180 - 22 && MAP_VIEWS.europe.x + MAP_VIEWS.europe.w > 180 + 45)
  })

  test('vergrössern um die Mitte, der Punkt unter dem Zeiger bleibt stehen', () => {
    const z = zoomBox(world, 2)
    assert.ok(near(z.w, 180) && near(z.x, 90) && near(ratio(z), ratio(world)))
    // Schweiz (188, 37) unter dem Zeiger: Anteil im Ausschnitt vorher = nachher
    const at = zoomBox(world, 4, 188, 37)
    assert.ok(near((188 - at.x) / at.w, 188 / 360) && near((37 - at.y) / at.h, 37 / MAP_HEIGHT))
  })

  test('Grenzen: nie kleiner als die Welt, höchstens 12-fach, nie über den Rand', () => {
    assert.deepEqual(zoomBox(world, 0.5), world)
    const deep = zoomBox(zoomBox(world, 8), 8)
    assert.ok(near(deep.w, MAP_MIN_W))
    // in der Ecke vergrössert: bleibt in der Karte
    const corner = zoomBox(world, 3, 0, 0)
    assert.ok(near(corner.x, 0) && near(corner.y, 0))
    const out = zoomBox(zoomBox(world, 4, 350, 140), 0.9, 350, 140)
    assert.ok(out.x + out.w <= MAP_WIDTH + 1e-9 && out.y + out.h <= MAP_HEIGHT + 1e-9)
  })

  test('verschieben: bleibt in der Karte; die ganze Welt lässt sich nicht verschieben', () => {
    assert.deepEqual(panBox(world, 40, 10), world)
    const z = zoomBox(world, 4)
    const p = panBox(z, 10, -5)
    assert.ok(near(p.x, z.x + 10) && near(p.y, z.y - 5))
    const far = panBox(z, -1000, 1000)
    assert.ok(near(far.x, 0) && near(far.y + far.h, MAP_HEIGHT))
    assert.deepEqual(clampBox({ x: -5, y: -5, w: 999, h: 1 }), world)
  })

  test('gleicher Ausschnitt', () => {
    assert.ok(sameBox(world, { ...world }))
    assert.ok(!sameBox(world, zoomBox(world, 1.5)))
  })
})

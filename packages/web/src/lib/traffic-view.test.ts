import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  activeNow, axisLabels, deltaLabel, flagOf, mapLevel, mapSteps, metricValue, niceMax, rangeFromSlug, rangeSlug, shareLabel, stepLabel,
  wayFromSlug, waySlug, windowLabel, yTicks,
} from './traffic-view.js'

describe('Besucher: Kennzahlen und Achse', () => {
  test('runde Obergrenze und Achsenwerte', () => {
    assert.equal(niceMax(0), 1)
    assert.equal(niceMax(22), 25)
    assert.equal(niceMax(106), 200)
    assert.equal(niceMax(7.9), 10)
    assert.deepEqual(yTicks(25), [25, 0])
    assert.deepEqual(yTicks(200), [200, 100, 0])
  })
  test('Seiten pro Besuch: Aufrufe je Besucher, ohne Besucher kein Wert', () => {
    assert.equal(metricValue({ views: 20, visitors: 4, notFound: 0, bots: 0 }, 'pagesPerVisit'), 5)
    assert.equal(metricValue({ views: 20, visitors: 0, notFound: 0, bots: 0 }, 'pagesPerVisit'), null)
    assert.equal(metricValue({ views: 20, visitors: 0, notFound: 3, bots: 0 }, 'notFound'), 3)
  })
  test('Vergleich zum Vorzeitraum nur mit Basis', () => {
    assert.equal(deltaLabel(112, 100), '+12 %')
    assert.equal(deltaLabel(80, 100), '−20 %')
    assert.equal(deltaLabel(100, 100), '±0 %')
    assert.equal(deltaLabel(5, 0), null)
    assert.equal(deltaLabel(5, null), null)
  })
  test('Anteile', () => {
    assert.equal(shareLabel(35, 145), '24 %')
    assert.equal(shareLabel(1, 300), '<1 %')
    assert.equal(shareLabel(0, 10), '0 %')
  })
})

describe('Besucher: Karte', () => {
  test('bis zu vier Stufen mit runden Grenzen, weniger bei wenigen Aufrufen', () => {
    assert.deepEqual(mapSteps(96), [1, 3, 10, 30])
    assert.deepEqual(mapSteps(2000), [1, 5, 50, 300])
    assert.deepEqual(mapSteps(4), [1, 2, 3])
    assert.deepEqual(mapSteps(1), [1])
    assert.deepEqual(mapSteps(0), [])
  })
  test('Stufe eines Landes und Legende', () => {
    const s = mapSteps(96)
    assert.deepEqual([1, 2, 3, 9, 10, 29, 30, 96].map((v) => mapLevel(v, s)), [1, 1, 2, 2, 3, 3, 4, 4])
    assert.equal(mapLevel(0, s), 0)
    // Nur eine Stufe: die stärkste Farbe
    assert.equal(mapLevel(1, mapSteps(1)), 4)
    assert.deepEqual(s.map((_, i) => stepLabel(s, i)), ['1–2', '3–9', '10–29', '30+'])
  })
  test('Flagge aus dem Ländercode, nichts für Tor und Unbekannt', () => {
    assert.equal(flagOf('CH'), '🇨🇭')
    assert.equal(flagOf('T1'), '')
    assert.equal(flagOf(''), '')
  })
})

describe('Besucher: Zeit', () => {
  test('Zeitfenster eines Punkts', () => {
    const at = new Date(2026, 10, 12, 15).toISOString()
    const end = new Date(2026, 10, 12, 16).toISOString()
    assert.equal(windowLabel({ at, end }, 'hour'), '12.11., 15:00–16:00')
    assert.equal(windowLabel({ at: new Date(2026, 10, 1).toISOString(), end: new Date(2026, 11, 1).toISOString() }, 'month'), 'November 2026')
  })
  test('Achse: Stunden über einen Tag mit Datum am Tageswechsel, Tage mit «gestern» und «heute»', () => {
    const start = new Date(2026, 10, 11, 19).getTime()
    const hours = Array.from({ length: 21 }, (_, i) => ({ at: new Date(start + i * 3_600_000).toISOString() }))
    assert.deepEqual([...axisLabels(hours, 'hour').values()], ['12.11.', '6:00', '12:00'])
    const now = new Date(2026, 10, 12, 15).getTime()
    const days = Array.from({ length: 7 }, (_, i) => ({ at: new Date(2026, 10, 6 + i).toISOString() }))
    const labels = axisLabels(days, 'day', now)
    assert.equal(labels.get(6), 'heute')
    assert.equal(labels.get(5), 'gestern')
    assert.equal(labels.get(0), '06.11.')
  })
  test('gerade aktiv: Seitenaufrufe der letzten 5 Minuten', () => {
    const now = Date.parse('2026-11-12T15:00:00Z')
    const e = (minAgo: number, page = true) => ({ at: new Date(now - minAgo * 60_000).toISOString(), page })
    assert.equal(activeNow([e(1), e(4.9), e(6), e(2, false)], now), 2)
  })
})

describe('Besucher: Adresse der Seite', () => {
  test('Zeitraum und Zugang als Wörter, Unbekanntes → Standard', () => {
    assert.equal(rangeFromSlug('30-tage'), '30d')
    assert.equal(rangeFromSlug('heute'), 'today')
    assert.equal(rangeFromSlug('24h'), '7d')
    assert.equal(rangeFromSlug(null), '7d')
    assert.equal(rangeSlug('12m'), '12-monate')
    assert.equal(wayFromSlug('heimnetz'), 'lan')
    assert.equal(wayFromSlug('vpn'), 'all')
    assert.equal(waySlug('public'), 'internet')
    assert.equal(waySlug('all'), null)
  })
})

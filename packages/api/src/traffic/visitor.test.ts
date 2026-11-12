import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { VisitorCounter, localDay } from './visitor.js'

const TZ = 'Europe/Zurich'
// 11.11.2026, 15:30 Ortszeit (14:30 UTC)
const T = Date.parse('2026-11-11T14:30:00Z')
const H = 60 * 60_000

describe('Besucher: Hash und Tagessalz', () => {
  test('derselbe Besucher (IP + User-Agent) zählt am selben Tag einmal je Projekt', () => {
    const v = new VisitorCounter(TZ, T)
    assert.equal(v.firstToday('p1', '203.0.113.9', 'UA', T), true)
    assert.equal(v.firstToday('p1', '203.0.113.9', 'UA', T + H), false)
    // anderes Projekt: eigener Besuch
    assert.equal(v.firstToday('p2', '203.0.113.9', 'UA', T + H), true)
    // anderer Browser auf derselben IP: anderer Besucher
    assert.equal(v.firstToday('p1', '203.0.113.9', 'UA2', T + H), true)
  })

  test('Tageswechsel (Ortszeit): neues Salz, derselbe Besucher zählt wieder', () => {
    const v = new VisitorCounter(TZ, T)
    const before = v.hash('203.0.113.9', 'UA', T)
    assert.equal(v.firstToday('p1', '203.0.113.9', 'UA', T), true)
    // 23:59 Ortszeit = 22:59 UTC: noch derselbe Tag
    assert.equal(v.firstToday('p1', '203.0.113.9', 'UA', Date.parse('2026-11-11T22:59:00Z')), false)
    assert.equal(v.hash('203.0.113.9', 'UA', Date.parse('2026-11-11T22:59:00Z')), before)
    // 00:01 Ortszeit = 23:01 UTC: neuer Tag
    const next = Date.parse('2026-11-11T23:01:00Z')
    assert.equal(v.firstToday('p1', '203.0.113.9', 'UA', next), true)
    assert.equal(v.currentDay, '2026-11-12')
    assert.notEqual(v.hash('203.0.113.9', 'UA', next), before)
  })

  test('verspätete Zeile von gestern dreht das Salz nicht zurück', () => {
    const v = new VisitorCounter(TZ, Date.parse('2026-11-11T23:01:00Z'))
    assert.equal(v.currentDay, '2026-11-12')
    v.firstToday('p1', '1.2.3.4', 'UA', Date.parse('2026-11-11T22:00:00Z'))
    assert.equal(v.currentDay, '2026-11-12')
  })

  test('das Salz ist zufällig und nur im Speicher: zwei Zähler (z. B. nach Neustart) hashen verschieden', () => {
    const a = new VisitorCounter(TZ, T)
    const b = new VisitorCounter(TZ, T)
    assert.notEqual(a.hash('203.0.113.9', 'UA', T), b.hash('203.0.113.9', 'UA', T))
    // Gleiches Salz → gleicher Hash; der Hash enthält die IP nicht im Klartext
    const salt = Buffer.alloc(32, 7)
    const c = new VisitorCounter(TZ, T, () => Buffer.from(salt))
    const d = new VisitorCounter(TZ, T, () => Buffer.from(salt))
    const h = c.hash('203.0.113.9', 'UA', T)
    assert.equal(h, d.hash('203.0.113.9', 'UA', T))
    assert.ok(!h.includes('203'))
    assert.equal(h.length, 22)
  })

  test('Besuch: erster Aufruf ist Einstieg, letzter nach 30 Min. Pause der Ausstieg', () => {
    const v = new VisitorCounter(TZ, T)
    const w = { way: 'public' as const, track: true }
    assert.deepEqual(v.see('p1', '1.2.3.4', 'UA', T, { ...w, path: '/' }), { first: true, entry: true })
    assert.deepEqual(v.see('p1', '1.2.3.4', 'UA', T + 5 * 60_000, { ...w, path: '/blog' }), { first: false, entry: false })
    assert.deepEqual(v.see('p1', '1.2.3.4', 'UA', T + 10 * 60_000, { ...w, path: '/kontakt' }), { first: false, entry: false })
    v.sweep(T + 30 * 60_000)
    assert.equal(v.takeEnded().length, 0)
    v.sweep(T + 41 * 60_000)
    assert.deepEqual(v.takeEnded(), [{ projectId: 'p1', at: T + 10 * 60_000, way: 'public', path: '/kontakt' }])
    assert.equal(v.openVisits, 0)
    // Später am Tag wieder da: neuer Besuch (Einstieg), aber kein neuer Besucher
    assert.deepEqual(v.see('p1', '1.2.3.4', 'UA', T + 2 * H, { ...w, path: '/blog' }), { first: false, entry: true })
  })

  test('neuer Besuch desselben Besuchers ohne Sweep: alter wird beendet', () => {
    const v = new VisitorCounter(TZ, T)
    const w = { way: 'tailnet' as const, track: true }
    v.see('p1', '1.2.3.4', 'UA', T, { ...w, path: '/a' })
    v.see('p1', '1.2.3.4', 'UA', T + H, { ...w, path: '/b' })
    assert.deepEqual(v.takeEnded().map((e) => e.path), ['/a'])
  })

  test('DNT/Sec-GPC (track = false): Besucher ja, Besuch nein', () => {
    const v = new VisitorCounter(TZ, T)
    assert.deepEqual(v.see('p1', '1.2.3.4', 'UA', T, { path: '/', way: 'public', track: false }), { first: true, entry: false })
    assert.equal(v.openVisits, 0)
    v.closeAll()
    assert.deepEqual(v.takeEnded(), [])
  })

  test('Tageswechsel und Herunterfahren beenden offene Besuche', () => {
    const v = new VisitorCounter(TZ, T)
    v.see('p1', '1.2.3.4', 'UA', Date.parse('2026-11-11T22:50:00Z'), { path: '/spaet', way: 'lan', track: true })
    v.see('p1', '5.6.7.8', 'UA', Date.parse('2026-11-11T23:05:00Z'), { path: '/neu', way: 'lan', track: true })
    assert.deepEqual(v.takeEnded().map((e) => e.path), ['/spaet'])
    v.closeAll()
    assert.deepEqual(v.takeEnded().map((e) => e.path), ['/neu'])
  })

  test('localDay in der Zeitzone der Anzeige', () => {
    assert.equal(localDay(Date.parse('2026-11-11T23:30:00Z'), TZ), '2026-11-12')
    assert.equal(localDay(Date.parse('2026-11-11T23:30:00Z'), 'UTC'), '2026-11-11')
  })
})

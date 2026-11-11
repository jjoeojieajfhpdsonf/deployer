import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { lastSlot, nextSlot, isDue, isStale, shouldNotifyStale, checkDue, type DueInput } from './rules.js'

const ZH = 'Europe/Zurich'
const H = 60 * 60_000
const at = (iso: string) => new Date(iso)

describe('Backup: Termin des nächtlichen Laufs (Ortszeit)', () => {
  test('Winterzeit: 03:30 in Zürich ist 02:30 UTC', () => {
    assert.equal(lastSlot(at('2026-11-11T10:00:00Z'), '03:30', ZH).toISOString(), '2026-11-11T02:30:00.000Z')
  })
  test('Sommerzeit: 03:30 in Zürich ist 01:30 UTC', () => {
    assert.equal(lastSlot(at('2026-07-01T10:00:00Z'), '03:30', ZH).toISOString(), '2026-07-01T01:30:00.000Z')
  })
  test('vor dem heutigen Termin gilt der von gestern', () => {
    assert.equal(lastSlot(at('2026-11-11T01:00:00Z'), '03:30', ZH).toISOString(), '2026-11-10T02:30:00.000Z')
    assert.equal(lastSlot(at('2026-03-01T00:10:00Z'), '03:30', ZH).toISOString(), '2026-02-28T02:30:00.000Z')
  })
  test('über die Umstellung hinweg (29. März 2026)', () => {
    assert.equal(lastSlot(at('2026-03-29T12:00:00Z'), '03:30', ZH).toISOString(), '2026-03-29T01:30:00.000Z')
    assert.equal(nextSlot(at('2026-03-28T12:00:00Z'), '03:30', ZH).toISOString(), '2026-03-29T01:30:00.000Z')
  })
  test('nächster Termin', () => {
    assert.equal(nextSlot(at('2026-11-11T10:00:00Z'), '03:30', ZH).toISOString(), '2026-11-12T02:30:00.000Z')
    assert.equal(nextSlot(at('2026-11-11T01:00:00Z'), '03:30', ZH).toISOString(), '2026-11-11T02:30:00.000Z')
  })
  test('UTC und unlesbare Uhrzeit', () => {
    assert.equal(lastSlot(at('2026-11-11T10:00:00Z'), '23:59', 'UTC').toISOString(), '2026-11-10T23:59:00.000Z')
    assert.throws(() => lastSlot(new Date(), '3:30', ZH))
  })
})

describe('Backup: ist der Lauf fällig?', () => {
  const base: DueInput = {
    now: at('2026-11-11T02:31:00Z'), enabled: true, configured: true, time: '03:30', timeZone: ZH,
    lastScheduledAt: at('2026-11-10T02:30:30Z'), configuredAt: at('2026-11-01T12:00:00Z'),
  }
  test('kurz nach 03:30, gestern gelaufen: fällig', () => assert.equal(isDue(base), true))
  test('heute schon gelaufen: nicht nochmal', () => assert.equal(isDue({ ...base, lastScheduledAt: at('2026-11-11T02:30:10Z') }), false))
  test('vor 03:30: nicht fällig', () => assert.equal(isDue({ ...base, now: at('2026-11-11T02:00:00Z') }), false))
  test('aus oder nicht eingerichtet: nie', () => {
    assert.equal(isDue({ ...base, enabled: false }), false)
    assert.equal(isDue({ ...base, configured: false }), false)
  })
  test('erst am Nachmittag eingerichtet: kein sofortiger Lauf, erst in der Nacht', () => {
    const o = { ...base, now: at('2026-11-11T15:00:00Z'), configuredAt: at('2026-11-11T14:00:00Z'), lastScheduledAt: null }
    assert.equal(isDue(o), false)
    assert.equal(isDue({ ...o, now: at('2026-11-12T02:30:00Z') }), true)
  })
  test('Server war um 03:30 aus: einmal nachholen', () => {
    const o = { ...base, now: at('2026-11-11T07:00:00Z') }
    assert.equal(isDue(o), true)
    assert.equal(isDue({ ...o, lastScheduledAt: at('2026-11-11T07:00:05Z') }), false)
  })
})

describe('Backup: «48 h ohne Erfolg»', () => {
  const now = at('2026-11-11T12:00:00Z')
  const base = { now, enabled: true, configured: true, lastSuccessAt: at('2026-11-09T11:00:00Z'), configuredAt: at('2026-10-01T00:00:00Z'), lastStaleNotifiedAt: null }
  test('49 h her: stale und melden', () => {
    assert.equal(isStale(base), true)
    assert.equal(shouldNotifyStale(base), true)
  })
  test('47 h her: nicht stale', () => {
    assert.equal(isStale({ ...base, lastSuccessAt: new Date(now.getTime() - 47 * H) }), false)
  })
  test('höchstens einmal pro Tag', () => {
    assert.equal(shouldNotifyStale({ ...base, lastStaleNotifiedAt: new Date(now.getTime() - 23 * H) }), false)
    assert.equal(shouldNotifyStale({ ...base, lastStaleNotifiedAt: new Date(now.getTime() - 24 * H) }), true)
  })
  test('Meldung vor dem letzten Erfolg zählt nicht (neue Störung, neue Meldung)', () => {
    assert.equal(shouldNotifyStale({ ...base, lastStaleNotifiedAt: at('2026-11-09T10:00:00Z') }), true)
  })
  test('nie erfolgreich: Frist ab Einrichtung', () => {
    assert.equal(isStale({ ...base, lastSuccessAt: null, configuredAt: new Date(now.getTime() - 10 * H) }), false)
    assert.equal(isStale({ ...base, lastSuccessAt: null, configuredAt: new Date(now.getTime() - 49 * H) }), true)
  })
  test('aus oder nicht eingerichtet: nie', () => {
    assert.equal(shouldNotifyStale({ ...base, enabled: false }), false)
    assert.equal(shouldNotifyStale({ ...base, configured: false }), false)
  })
})

describe('Backup: restic check einmal pro Woche', () => {
  const now = at('2026-11-11T12:00:00Z')
  test('nie geprüft oder vor 7 Tagen: fällig', () => {
    assert.equal(checkDue(null, now), true)
    assert.equal(checkDue(new Date(now.getTime() - 7 * 24 * H), now), true)
  })
  test('vor 6 Tagen: nicht fällig', () => assert.equal(checkDue(new Date(now.getTime() - 6 * 24 * H), now), false))
})

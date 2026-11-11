import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseLocalDateTime, toLocalDateTime, backAtProblem, pauseOptionsSchema, renderPausePage, pauseHeaders, formatBackAt,
  fillPauseTokens, DEFAULT_PAUSE_PAGE, PAUSE_BACK_MAX_MS,
} from '@airlock/shared'
import { sinceSeconds, isoOrNull } from './dates.js'
import { allowReport, clientErrorSchema } from '../http/routes/client-errors.js'

// «Voraussichtlich zurück»: das Jahr 333333 hat die Oberfläche schwarz gemacht
// (new Date(v).toISOString() warf RangeError beim Rendern).
const now = new Date('2026-11-10T19:00:00Z')

describe('datetime-local wirft nie', () => {
  test('333333-03-03T03:33 → «Ungültiges Datum», kein Wurf', () => {
    assert.doesNotThrow(() => parseLocalDateTime('333333-03-03T03:33', now))
    assert.deepEqual(parseLocalDateTime('333333-03-03T03:33', now), { iso: null, error: 'Ungültiges Datum' })
  })

  test('unplausible Jahre ausserhalb aktuelles Jahr bis +2', () => {
    assert.equal(parseLocalDateTime('2025-12-31T10:00', now).error, 'Ungültiges Datum')
    assert.equal(parseLocalDateTime('2029-01-01T10:00', now).error, 'Ungültiges Datum')
    assert.equal(parseLocalDateTime('2028-06-01T10:00', now).error, null)
  })

  test('unmögliche Tage und halbe Eingaben', () => {
    assert.equal(parseLocalDateTime('2027-02-31T10:00', now).error, 'Ungültiges Datum')
    assert.equal(parseLocalDateTime('2027-13-01T10:00', now).error, 'Ungültiges Datum')
    assert.equal(parseLocalDateTime('2027-01-01T25:00', now).error, 'Ungültiges Datum')
    assert.equal(parseLocalDateTime('2027-01', now).error, 'Ungültiges Datum')
    assert.equal(parseLocalDateTime('kein datum', now).error, 'Ungültiges Datum')
  })

  test('leer ist erlaubt (kein «zurück um»)', () => {
    assert.deepEqual(parseLocalDateTime('', now), { iso: null, error: null })
  })

  test('gültige Eingabe ergibt ISO und zurück', () => {
    const r = parseLocalDateTime('2026-12-01T08:00', now)
    assert.equal(r.error, null)
    assert.ok(r.iso && Number.isFinite(Date.parse(r.iso)))
    assert.equal(toLocalDateTime(r.iso), '2026-12-01T08:00')
  })

  test('toLocalDateTime mit Unsinn → leer statt Wurf', () => {
    assert.equal(toLocalDateTime('333333-03-03T03:33'), '')
    assert.equal(toLocalDateTime('nicht lesbar'), '')
    assert.equal(toLocalDateTime(null), '')
  })
})

describe('Regel für «Voraussichtlich zurück» (Feld, API, MCP)', () => {
  const n = now.getTime()
  test('Zukunft bis ein Jahr: ok', () => {
    assert.equal(backAtProblem(new Date(n + 3_600_000).toISOString(), n), null)
  })
  test('Vergangenheit, zu weit, unlesbar', () => {
    assert.equal(backAtProblem(new Date(n - 1).toISOString(), n), 'Liegt in der Vergangenheit')
    assert.equal(backAtProblem(new Date(n + PAUSE_BACK_MAX_MS + 60_000).toISOString(), n), 'Höchstens ein Jahr im Voraus')
    assert.equal(backAtProblem('333333-03-03T03:33', n), 'Ungültiges Datum')
  })

  test('Server-Schema: 400 mit Feldfehler backAt', () => {
    const bad = pauseOptionsSchema.safeParse({ backAt: '2020-01-01T00:00:00Z' })
    assert.equal(bad.success, false)
    assert.deepEqual(bad.error!.issues.map((i) => i.path.join('.')), ['backAt'])
    assert.equal(pauseOptionsSchema.safeParse({ backAt: '+333333-03-03T03:33:00Z' }).success, false)
    assert.equal(pauseOptionsSchema.safeParse({ backAt: new Date(Date.now() + 86_400_000).toISOString() }).success, true)
    assert.equal(pauseOptionsSchema.safeParse({ backAt: null }).success, true)
  })
})

describe('Renderer und Header werfen nie', () => {
  test('ungültiges back_at: Seite ohne Zeile, kein Retry-After, kein Wurf', () => {
    assert.doesNotThrow(() => renderPausePage(DEFAULT_PAUSE_PAGE, { backAt: '333333-03-03T03:33' }))
    assert.doesNotMatch(renderPausePage(DEFAULT_PAUSE_PAGE, { backAt: 'Unsinn' }), /Voraussichtlich zurück/)
    assert.equal(pauseHeaders('Unsinn')['Retry-After'], undefined)
    assert.equal(formatBackAt('Unsinn', 'de'), '')
    assert.doesNotThrow(() => formatBackAt('2026-12-01T08:00:00Z', 'de', 'Keine/Zone'))
    assert.match(fillPauseTokens('<p>{{back_at}}</p>', DEFAULT_PAUSE_PAGE, { backAt: 'Unsinn' }), /<p><\/p>/)
  })
})

describe('Datumswerte aus Anfragen (API)', () => {
  test('since: ISO, ms, leer; Unsinn ist 400 statt NaN', () => {
    assert.equal(sinceSeconds('2026-11-10T19:00:00Z'), Math.floor(now.getTime() / 1000))
    assert.equal(sinceSeconds(undefined), undefined)
    assert.throws(() => sinceSeconds('333333-03-03T03:33'), /since: Ungültiges Datum/)
    assert.throws(() => sinceSeconds('gestern'), /Ungültiges Datum/)
  })
  test('isoOrNull: nie werfen', () => {
    assert.equal(isoOrNull(Number.NaN), null)
    assert.equal(isoOrNull('Unsinn'), null)
    assert.equal(isoOrNull(0), '1970-01-01T00:00:00.000Z')
  })
})

describe('Fehlermeldungen der Oberfläche', () => {
  test('nur der Pfad, ohne Query (Tokens, Namen)', () => {
    assert.equal(clientErrorSchema.safeParse({ message: 'x', path: '/projekte/abc' }).success, true)
    assert.equal(clientErrorSchema.safeParse({ message: 'x', path: '/projekte?token=geheim' }).success, false)
  })
  test('Grenzen der Felder', () => {
    assert.equal(clientErrorSchema.safeParse({ message: 'x'.repeat(501) }).success, false)
    // Bereiche der Error Boundary: App, Seite, Zusatz in der Shell
    for (const scope of ['app', 'page', 'part']) assert.equal(clientErrorSchema.safeParse({ message: 'x', scope }).success, true, scope)
    assert.equal(clientErrorSchema.safeParse({ message: 'x', scope: 'anderes' }).success, false)
  })
  test('höchstens 30 pro Minute', () => {
    const t = 10_000_000
    let ok = 0
    for (let i = 0; i < 40; i++) if (allowReport(t + i)) ok++
    assert.equal(ok, 30)
    assert.equal(allowReport(t + 61_000), true, 'neues Fenster')
  })
})

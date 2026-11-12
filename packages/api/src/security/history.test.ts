import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { scanHistory, firstSeen, type HistoryRun } from './history.js'
import { observedHeaders } from './headers.js'

const run = (id: string, day: number, status: HistoryRun['status'] = 'done', score: number | null = 80): HistoryRun => ({
  id, status, level: 'standard', startedAt: new Date(Date.UTC(2026, 10, day, 8)), finishedAt: status === 'done' ? new Date(Date.UTC(2026, 10, day, 8, 5)) : null,
  score, grade: score === null ? null : 'B', trigger: 'deploy',
})

describe('Verlauf der Scans', () => {
  test('neu und behoben gegenüber dem vorherigen abgeschlossenen Scan, neueste zuerst', () => {
    const h = scanHistory([run('a', 1), run('b', 3), run('c', 2, 'failed', null)], [
      { scanRunId: 'a', fingerprint: 'x', status: 'open' },
      { scanRunId: 'a', fingerprint: 'y', status: 'open' },
      { scanRunId: 'b', fingerprint: 'y', status: 'accepted' },
      { scanRunId: 'b', fingerprint: 'z', status: 'open' },
    ])
    assert.deepEqual(h.map((x) => x.id), ['b', 'c', 'a'])
    // b vergleicht mit a (c ist gescheitert): z neu, x behoben; y akzeptiert zählt als vorhanden
    assert.equal(h[0]!.newCount, 1)
    assert.equal(h[0]!.fixedCount, 1)
    // Gescheitert und erster Scan: kein Vergleich
    assert.equal(h[1]!.newCount, null)
    assert.equal(h[2]!.fixedCount, null)
  })

  test('im selben Scan behoben (Header-Nachscan) zählt als behoben', () => {
    const h = scanHistory([run('a', 1), run('b', 2)], [
      { scanRunId: 'a', fingerprint: 'x', status: 'open' },
      { scanRunId: 'b', fingerprint: 'x', status: 'fixed' },
    ])
    assert.equal(h[0]!.fixedCount, 1)
    assert.equal(h[0]!.newCount, 0)
  })

  test('erstes Auftreten und Anzahl Scans je Fingerabdruck', () => {
    const m = firstSeen([run('a', 1), run('b', 3)], [
      { scanRunId: 'b', fingerprint: 'x' },
      { scanRunId: 'a', fingerprint: 'x' },
      { scanRunId: 'b', fingerprint: 'y' },
      // Scan ausserhalb der Liste (gescheitert) zählt nicht
      { scanRunId: 'q', fingerprint: 'y' },
    ])
    assert.deepEqual(m.get('x'), { firstSeenAt: '2026-11-01T08:00:00.000Z', seenIn: 2 })
    assert.deepEqual(m.get('y'), { firstSeenAt: '2026-11-03T08:00:00.000Z', seenIn: 1 })
  })
})

describe('Gesehene Header-Werte', () => {
  test('frame-ancestors aus der CSP, sonst X-Frame-Options; Report-Only eigens', () => {
    assert.deepEqual(observedHeaders({
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      server: 'nginx',
    }), { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'frame-ancestors': "'none'", 'referrer-policy': 'no-referrer' })
    assert.deepEqual(observedHeaders({ 'x-frame-options': 'DENY', 'content-security-policy-report-only': "default-src 'self'" }), {
      'content-security-policy-report-only': "default-src 'self'", 'frame-ancestors': 'X-Frame-Options: DENY',
    })
    assert.deepEqual(observedHeaders({ 'strict-transport-security': ['max-age=300', 'max-age=1'] }), { 'strict-transport-security': 'max-age=300' })
  })
})

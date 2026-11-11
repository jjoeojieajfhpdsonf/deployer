import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { logLevel, mergeLogLines, parseDockerLines, rangeMinutes } from '@airlock/shared'

describe('UI-Qualität 4: Logzeilen', () => {
  test('Stufe aus Wort, logfmt, JSON (pino und Text)', () => {
    assert.equal(logLevel('2026/11/10 ERROR connection refused'), 'error')
    assert.equal(logLevel('[warn] disk almost full'), 'warn')
    assert.equal(logLevel('time=… level=warning msg=slow'), 'warn')
    assert.equal(logLevel('{"level":50,"msg":"boom"}'), 'error')
    assert.equal(logLevel('{"level":30,"msg":"ok"}'), 'info')
    assert.equal(logLevel('{"level":"debug","msg":"x"}'), 'debug')
    assert.equal(logLevel('Traceback (most recent call last):'), 'error')
    assert.equal(logLevel('GET /health 200 4 ms'), null)
    // Kein Treffer in Wörtern, die nur so aussehen
    assert.equal(logLevel('errors_total=0 warnings_seen=0'), null)
  })

  test('Docker-Zeilen mit Zeitstempel: Zeit in Millisekunden, Dienst, Stufe', () => {
    const raw = '2026-11-10T12:46:01.123456789Z Server listening on 3000\n2026-11-10T12:46:02.5Z ERROR db gone\nohne Zeit\n'
    const lines = parseDockerLines(raw, 'web')
    assert.equal(lines.length, 3)
    assert.deepEqual(lines[0], { at: '2026-11-10T12:46:01.123Z', service: 'web', text: 'Server listening on 3000', level: null })
    assert.equal(lines[1]!.at, '2026-11-10T12:46:02.500Z')
    assert.equal(lines[1]!.level, 'error')
    assert.equal(lines[2]!.at, null)
  })

  test('Dienste nach Zeit mischen und auf die neuesten kürzen', () => {
    const web = parseDockerLines('2026-11-10T12:00:01.000Z w1\n2026-11-10T12:00:03.000Z w2', 'web')
    const db = parseDockerLines('2026-11-10T12:00:02.000Z d1', 'db')
    assert.deepEqual(mergeLogLines([web, db]).map((l) => l.text), ['w1', 'd1', 'w2'])
    assert.deepEqual(mergeLogLines([web, db], 2).map((l) => l.text), ['d1', 'w2'])
  })

  test('Zeitraum: 15 Min. als Standard', () => {
    assert.equal(rangeMinutes('1h'), 60)
    assert.equal(rangeMinutes('24h'), 1440)
    assert.equal(rangeMinutes(undefined), 15)
    assert.equal(rangeMinutes('quatsch'), 15)
  })
})

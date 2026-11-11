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

  test('Decoder: zerrissene Docker-Rahmen und halbe Zeilen über mehrere Stücke', async () => {
    process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
    process.env.ADMIN_PASSWORD ??= 'x'
    const { DockerLogDecoder } = await import('../drivers/docker.js')
    const frame = (s: string) => { const b = Buffer.from(s); const h = Buffer.alloc(8); h[0] = 1; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]) }
    const all = Buffer.concat([frame('2026-11-10T12:00:01.000Z erste Zeile\n2026-11-10T12:00:02.000Z zwei'), frame('te Zeile\n'), frame('2026-11-10T12:00:03.000Z äöü\n')])
    const d = new DockerLogDecoder()
    const lines: string[] = []
    // In 7-Byte-Stücken: Köpfe, Rahmen, Zeilen und ein Umlaut werden zerschnitten
    for (let i = 0; i < all.length; i += 7) lines.push(...d.push(all.subarray(i, i + 7)))
    lines.push(...d.flush())
    assert.deepEqual(lines, ['2026-11-10T12:00:01.000Z erste Zeile', '2026-11-10T12:00:02.000Z zweite Zeile', '2026-11-10T12:00:03.000Z äöü'])
    // Ohne Rahmen (TTY): Text, ebenfalls zeilenweise
    const t = new DockerLogDecoder()
    assert.deepEqual([...t.push(Buffer.from('hallo wel')), ...t.push(Buffer.from('t\nzweite')), ...t.flush()], ['hallo welt', 'zweite'])
  })

  test('Zeitraum: 15 Min. als Standard', () => {
    assert.equal(rangeMinutes('1h'), 60)
    assert.equal(rangeMinutes('24h'), 1440)
    assert.equal(rangeMinutes(undefined), 15)
    assert.equal(rangeMinutes('quatsch'), 15)
  })
})

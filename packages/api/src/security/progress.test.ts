import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { planStages, progressOf, tailOf, logLines, summary, describeScan, describeStages, StageTimeout, STAGE_INFO } from './progress.js'
import { requestLogLevel, isStreamRoute } from '../lib/request-log.js'

describe('Stufenplan von Anfang an', () => {
  test('Image-Projekt: alle Stufen warten, testssl mit Grund übersprungen', () => {
    const p = planStages({ external: false, level: 'standard', kind: 'image', hasSource: false })
    assert.deepEqual(Object.keys(p), ['trivy-image', 'trivy-source', 'headers', 'zap-baseline', 'nuclei', 'testssl'])
    assert.equal(p['trivy-image']!.state, 'waiting')
    assert.equal(p['trivy-source']!.state, 'skipped')
    assert.match(p['trivy-source']!.note!, /kein Quellordner/)
    assert.equal(p.testssl!.state, 'skipped')
    assert.ok(p.headers!.checks, 'jede Stufe nennt, was sie prüft')
  })

  test('statische Seite: Image übersprungen mit Grund', () => {
    const p = planStages({ external: false, level: 'standard', kind: 'static', hasSource: true })
    assert.equal(p['trivy-image']!.state, 'skipped')
    assert.equal(p['trivy-image']!.note, 'kein Image, statische Seite')
    assert.equal(p['trivy-source']!.state, 'waiting')
  })

  test('aktiver Scan: ZAP Full statt Baseline, mit längerem Zeitlimit', () => {
    const p = planStages({ external: false, level: 'active', kind: 'dockerfile', hasSource: true })
    assert.ok(p['zap-full'])
    assert.equal(p['zap-baseline'], undefined)
    assert.equal(p['zap-full']!.timeoutMs, STAGE_INFO['zap-full'].timeoutMs)
  })

  test('externes Ziel: kein Image, kein Quellcode, testssl läuft', () => {
    const p = planStages({ external: true, level: 'standard' })
    assert.equal(p['trivy-image']!.state, 'skipped')
    assert.equal(p.testssl!.state, 'waiting')
  })
})

describe('Fortschritt aus Logzeilen', () => {
  test('Trivy: DB-Download in MB (Fortschrittsbalken mit \\r)', () => {
    const log = '2026-11-10T19:04:01Z INFO Need to update DB\r12.00 MiB / 58.91 MiB [--->___] 20%\r34.50 MiB / 58.91 MiB [------>____] 58.56% 10.2 MiB p/s'
    assert.equal(progressOf('trivy-image', log), 'Schwachstellen-Datenbank: 35 von 59 MB geladen')
  })

  test('ZAP: gecrawlte URLs', () => {
    assert.equal(progressOf('zap-baseline', 'Using the Automation Framework\nTotal of 42 URLs\nPASS: Vulnerable JS Library [10003]'), '42 URLs gecrawlt')
  })

  test('mehrere Images: Zusatz im Namen stört nicht', () => {
    assert.equal(progressOf('trivy-image nginx:1.27', '1.00 MiB / 2.00 MiB'), 'Schwachstellen-Datenbank: 1 von 2 MB geladen')
  })

  test('nichts Bekanntes: null', () => {
    assert.equal(progressOf('nuclei', 'irgendwas'), null)
  })

  test('Live-Ausgabe: Farbcodes weg, nur die letzten Zeilen, lange Zeilen gekürzt', () => {
    const text = Array.from({ length: 30 }, (_, i) => `\x1b[32mZeile ${i}\x1b[0m`).join('\n') + '\n' + 'x'.repeat(500)
    const t = tailOf(text, 5)
    assert.equal(t.length, 5)
    assert.equal(t[0], 'Zeile 26')
    assert.ok(t[4]!.endsWith('…') && t[4]!.length < 260)
    assert.deepEqual(logLines('a\r\n\r\nb'), ['a', 'b'])
  })
})

describe('Zusammenfassung und MCP', () => {
  const stages = {
    'trivy-image': { ran: true, state: 'done' as const, findings: 2, durationMs: 61_000 },
    'trivy-source': { ran: false, state: 'skipped' as const, note: 'kein Quellordner' },
    headers: { ran: false, state: 'running' as const, startedAt: '2026-11-10T18:04:00.000Z', timeoutMs: 60_000, progress: 'läuft', tail: ['a', 'b'] },
    nuclei: { ran: false, state: 'waiting' as const },
  }

  test('summary nennt erledigte Stufen und die laufende', () => {
    assert.equal(summary(stages), '2 von 4 Stufen erledigt, läuft: Security-Header')
  })

  test('describeScan: Laufzeit, Auslöser, Warteschlange', () => {
    const d = describeScan({
      id: 's1', status: 'running', level: 'standard', startedAt: '2026-11-10T18:04:00.000Z', finishedAt: null, error: null,
      stages, trigger: 'mcp', actor: 'token:claude-code-mac', queue: null,
    }, Date.parse('2026-11-10T18:09:00.000Z'))
    assert.equal('running_for_s' in d ? d.running_for_s : null, 300)
    assert.equal(d.triggered_by, 'MCP (token:claude-code-mac)')
    assert.equal(d.progress, '2 von 4 Stufen erledigt, läuft: Security-Header')
  })

  test('describeScan: wartend mit Position', () => {
    const d = describeScan({
      id: 's2', status: 'queued', level: 'standard', startedAt: '2026-11-10T18:04:00.000Z', finishedAt: null, error: null,
      stages: {}, trigger: 'deploy', actor: 'admin', queue: { position: 1, ahead: 1 },
    })
    assert.equal(d.queue_position, 1)
    assert.equal(d.scans_ahead, 1)
  })

  test('describeStages: Zustand, Dauer, Live-Ausgabe nur bei laufenden', () => {
    const d = describeStages(stages)
    assert.equal(d[0]!.duration_s, 61)
    assert.equal(d[0]!.findings, 2)
    assert.equal('last_output' in d[0]!, false)
    assert.deepEqual(d[2]!.last_output, ['a', 'b'])
    assert.equal(d[2]!.timeout_min, 1)
    assert.ok(d[3]!.checks.length > 0)
  })

  test('Zeitlimit: klare Meldung', () => {
    assert.equal(new StageTimeout(15 * 60_000).message, 'Zeitlimit von 15 Min. überschritten – Stufe abgebrochen')
  })
})

describe('Zugriffs-Log', () => {
  test('Polling (erfolgreiche GETs) auf debug', () => {
    assert.equal(requestLogLevel('GET', 200, 30), 'debug')
    assert.equal(requestLogLevel('GET', 304, 30), 'debug')
  })
  test('Änderungen, Fehler und langsame Antworten bleiben sichtbar', () => {
    assert.equal(requestLogLevel('POST', 202, 30), 'info')
    assert.equal(requestLogLevel('GET', 404, 30), 'info')
    assert.equal(requestLogLevel('GET', 200, 8_000), 'info')
    assert.equal(requestLogLevel('GET', 502, 30), 'warn')
    // UI-Qualität 3: ein Ereignisstrom über Minuten ist kein langsamer Aufruf
    assert.equal(requestLogLevel('GET', 200, 600_000, true), 'debug')
    // … erkannt am Routenmuster (nach writeHead kennt Node den Content-Type nicht mehr)
    assert.equal(isStreamRoute('/api/v1/events'), true)
    assert.equal(isStreamRoute('/api/v1/deployments/:id/events'), true)
    assert.equal(isStreamRoute('/api/v1/projects/:id/logs/stream'), true)
    assert.equal(isStreamRoute('/api/v1/projects/:id/logs'), false)
  })
})

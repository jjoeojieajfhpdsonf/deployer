import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { parseIntrusionArgs, runCli, type IntrusionCliResult } from '../cli.js'
import { DEFAULT_MATRIX, renderMessage } from '../notify/render.js'

/** Nacht 3, Etappe 5: Kommandozeile, Benachrichtigung und Rechte des Socket-Proxys */

describe('Kommandozeile', () => {
  test('intrusion-check: Schalter lesen, Unsinn ablehnen', () => {
    const errs: string[] = []
    assert.deepEqual(parseIntrusionArgs(['--only-label', 'airlock.smoke=ab12', '--learn-minutes', '0'], (e) => errs.push(e)), { scope: { key: 'airlock.smoke', value: 'ab12' }, learnMinutes: 0 })
    assert.equal(parseIntrusionArgs(['--learn-minutes', '-1'], (e) => errs.push(e)), null)
    assert.equal(parseIntrusionArgs(['--only-label', 'kaputt'], (e) => errs.push(e)), null)
    assert.equal(parseIntrusionArgs(['--weg'], (e) => errs.push(e)), null)
    assert.equal(errs.length, 3)
  })

  test('intrusion-check und release-isolation geben aus, was passiert ist', async () => {
    const out: string[] = []
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`E ${l}`) }
    const r: IntrusionCliResult = {
      containers: 1, learning: 0, created: 1, updated: 0, errors: [],
      signals: [{ severity: 'hoch', kind: 'prozess_verdaechtig', project: 'shop', title: 'Shell gestartet: sh', count: 1, samples: ['sh -c sleep 300'] }],
      active: [{ severity: 'hoch', kind: 'prozess_verdaechtig', project: 'shop', title: 'Shell gestartet: sh', count: 1, status: 'offen' }],
    }
    const deps = {
      service: async () => { throw new Error('nicht gebraucht') }, adminName: '',
      intrusion: async () => r,
      releaseIsolation: async () => ({ name: 'Shop', released: true, restored: 2, failed: [] }),
    }
    assert.equal(await runCli(['intrusion-check'], io, deps), 0)
    assert.ok(out.some((l) => /hoch\s+prozess_verdaechtig\s+\[shop\] Shell gestartet: sh \(\+1\)/.test(l)))
    assert.ok(out.includes('Aktive Vorfälle: 1'))
    out.length = 0
    assert.equal(await runCli(['release-isolation', 'shop'], io, deps), 0)
    assert.ok(out[0]!.startsWith('Isolation von «Shop» aufgehoben'))
    assert.equal(await runCli(['release-isolation'], io, deps), 2)
  })
})

describe('Benachrichtigung', () => {
  test('Vorfall: Standard Push und E-Mail; kritisch mit höchster Priorität', () => {
    assert.deepEqual(DEFAULT_MATRIX.incident, { push: true, email: true })
    const m = renderMessage('incident', { title: 'Krypto-Miner läuft: xmrig', project: 'Shop', severity: 'kritisch', count: 3, since: '2026-11-12 22:00 UTC', samples: ['xmrig -o pool'], reaction: 'Automatisch: Container gestoppt' })
    assert.equal(m.title, 'Kritisch: Krypto-Miner läuft: xmrig – Shop')
    assert.equal(m.priority, 5)
    assert.match(m.body, /3× gesehen seit 2026-11-12 22:00 UTC/)
    assert.match(m.body, /• xmrig -o pool/)
    assert.match(m.body, /Automatisch: Container gestoppt/)
    assert.equal(renderMessage('incident', { title: 'x', severity: 'hoch', count: 1, since: 'jetzt' }).priority, 4)
  })
})

describe('Socket-Proxy', () => {
  test('docker top, diff und die Rechte einer Datei liegen unter CONTAINERS – EXEC bleibt aus', () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url))
    const compose = parse(readFileSync(`${root}compose.yaml`, 'utf8')) as { services: Record<string, { environment?: Record<string, unknown> }> }
    const env = compose.services['socket-proxy']!.environment ?? {}
    assert.equal(String(env.CONTAINERS), '1')
    assert.equal(String(env.EXEC ?? '0'), '0')
  })
})

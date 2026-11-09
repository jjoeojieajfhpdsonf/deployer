import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseCaddyTlsLog } from './caddy-tls-log.js'

// Zeilen im Format von Caddy 2.10 (JSON, ts in Sekunden)
const T0 = Date.parse('2026-11-09T20:00:00Z')
const at = (sec: number) => (T0 + sec * 1000) / 1000
const line = (o: Record<string, unknown>) => JSON.stringify(o)
const W = '*.int.jherren.com'

const LOG = [
  line({ level: 'info', ts: at(-600), logger: 'tls.obtain', msg: 'certificate obtained successfully', identifier: W, issuer: 'acme-v02.api.letsencrypt.org-directory' }), // alt, vor dem Start
  'kein JSON: Caddy-Banner',
  line({ level: 'info', ts: at(1), logger: 'http', msg: 'server running', name: 'srv1' }),
  line({ level: 'info', ts: at(2), logger: 'tls.obtain', msg: 'acquiring lock', identifier: W }),
  line({ level: 'error', ts: at(10), logger: 'tls.issuance.acme.acme_client', msg: 'challenge failed', identifier: W, error: 'no TXT record found' }),
  line({ level: 'info', ts: at(20), logger: 'tls.issuance.acme.acme_client', msg: 'validations succeeded; finalizing order' }),
  line({ level: 'info', ts: at(25), logger: 'tls.obtain', msg: 'certificate obtained successfully', identifier: W, issuer: 'acme-staging-v02.api.letsencrypt.org-directory' }),
].join('\n')

describe('parseCaddyTlsLog', () => {
  test('erkennt den Staging-Abruf seit dem Start', () => {
    const r = parseCaddyTlsLog(LOG, W, T0)
    assert.ok(r.obtained)
    assert.equal(r.obtained.staging, true)
    assert.match(r.obtained.issuer, /acme-staging/)
  })

  test('letzter Fehler und letzte Zeile', () => {
    const r = parseCaddyTlsLog(LOG, W, T0)
    assert.equal(r.lastError, 'challenge failed: no TXT record found')
    assert.match(r.lastLine!, /certificate obtained successfully/)
  })

  test('alte Zeilen vor dem Start zählen nicht', () => {
    const r = parseCaddyTlsLog(LOG.split('\n').slice(0, 2).join('\n'), W, T0)
    assert.equal(r.obtained, null)
  })

  test('Abruf für einen anderen Namen zählt nicht', () => {
    const r = parseCaddyTlsLog(line({ level: 'info', ts: at(5), msg: 'certificate obtained successfully', identifier: 'deployer.int.jherren.com', issuer: 'acme-staging' }), W, T0)
    assert.equal(r.obtained, null)
  })

  test('Produktion wird als nicht-Staging erkannt', () => {
    const r = parseCaddyTlsLog(line({ level: 'info', ts: at(5), msg: 'certificate obtained successfully', identifier: W, issuer: 'acme-v02.api.letsencrypt.org-directory' }), W, T0)
    assert.equal(r.obtained?.staging, false)
  })

  test('leerer Log', () => {
    assert.deepEqual(parseCaddyTlsLog('', W, T0), { obtained: null, lastError: null, lastLine: null })
  })
})

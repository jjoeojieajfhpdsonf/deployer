import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { expiryDecision, expiresAt, type ExpiryInput } from './expiry-rule.js'

const DAY = 24 * 60 * 60 * 1000
const now = new Date('2026-12-31T12:00:00Z')
const ago = (d: number) => new Date(now.getTime() - d * DAY)

const base: ExpiryInput = {
  sourceType: 'files', keep: false, desiredState: 'running',
  lastChangeAt: ago(1), expiryWarnedAt: null,
}

describe('Ablauf von Chat-Deploys', () => {
  test('frisch geändert: nichts', () => {
    assert.equal(expiryDecision(base, now, 30), 'none')
  })
  test('27 Tage ohne Änderung: warnen', () => {
    assert.equal(expiryDecision({ ...base, lastChangeAt: ago(27) }, now, 30), 'warn')
  })
  test('schon gewarnt: nicht nochmal', () => {
    assert.equal(expiryDecision({ ...base, lastChangeAt: ago(28), expiryWarnedAt: ago(1) }, now, 30), 'none')
  })
  test('30 Tage ohne Änderung: stoppen', () => {
    assert.equal(expiryDecision({ ...base, lastChangeAt: ago(30) }, now, 30), 'stop')
  })
  test('"behalten" nimmt das Projekt aus', () => {
    assert.equal(expiryDecision({ ...base, keep: true, lastChangeAt: ago(400) }, now, 30), 'none')
    assert.equal(expiresAt({ ...base, keep: true }, 30), null)
  })
  test('nur Quelle files läuft ab', () => {
    assert.equal(expiryDecision({ ...base, sourceType: 'image', lastChangeAt: ago(400) }, now, 30), 'none')
  })
  test('gestoppte Projekte nicht erneut stoppen', () => {
    assert.equal(expiryDecision({ ...base, desiredState: 'stopped', lastChangeAt: ago(400) }, now, 30), 'none')
  })
  test('Frist ist einstellbar', () => {
    assert.equal(expiryDecision({ ...base, lastChangeAt: ago(8) }, now, 7), 'stop')
    assert.equal(expiresAt({ ...base, lastChangeAt: now }, 7)?.getTime(), now.getTime() + 7 * DAY)
  })
  test('REVIEW: Anzeige und Job rechnen mit demselben Feld', () => {
    // expiresAt und expiryDecision beruhen beide nur auf lastChangeAt.
    const p = { ...base, lastChangeAt: ago(10) }
    const at = expiresAt(p, 30)!
    assert.equal(expiryDecision(p, new Date(at.getTime() - 1), 30) !== 'stop', true)
    assert.equal(expiryDecision(p, at, 30), 'stop')
  })
})

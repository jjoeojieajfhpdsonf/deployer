import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderMessage, DEFAULT_MATRIX, EVENT_LABEL, notifyEvents, mergeMatrix } from '../notify/render.js'

describe('Backup: Benachrichtigungen', () => {
  test('neue Arten backup_failed und backup_stale, standardmässig auf beiden Kanälen', () => {
    assert.ok(notifyEvents.includes('backup_failed'))
    assert.ok(notifyEvents.includes('backup_stale'))
    assert.deepEqual(DEFAULT_MATRIX.backup_failed, { push: true, email: true })
    assert.deepEqual(DEFAULT_MATRIX.backup_stale, { push: true, email: true })
    assert.ok(EVENT_LABEL.backup_failed && EVENT_LABEL.backup_stale)
  })
  test('alte gespeicherte Matrix ohne die neuen Arten: Vorgabe gilt', () => {
    const m = mergeMatrix({ deploy_failed: { push: false, email: false } })
    assert.deepEqual(m.backup_failed, { push: true, email: true })
  })
  test('Fehlschlag: Auslöser, Ziel, Fehler, letzter Erfolg', () => {
    const m = renderMessage('backup_failed', { trigger: 'schedule', target: 'S3 s3.example.com/airlock', error: 'restic backup gescheitert (Exit 1): Fatal: …', lastSuccess: '9. Nov. 2026, 03:31' })
    assert.equal(m.title, 'Backup fehlgeschlagen')
    assert.match(m.body, /nächtliche Sicherung nach S3 s3\.example\.com\/airlock/)
    assert.match(m.body, /Exit 1/)
    assert.match(m.body, /Letztes erfolgreiches Backup: 9\. Nov\. 2026/)
    assert.ok(m.priority >= 4)
  })
  test('Fehlschlag ohne je einen Erfolg; von Hand gestartet', () => {
    const m = renderMessage('backup_failed', { trigger: 'manual', error: 'x', lastSuccess: null })
    assert.match(m.body, /von Hand gestartete/)
    assert.match(m.body, /noch kein erfolgreiches Backup/)
  })
  test('48 h ohne Erfolg', () => {
    const m = renderMessage('backup_stale', { lastSuccess: '8. Nov. 2026, 03:31', lastError: 'Repository nicht erreichbar' })
    assert.equal(m.title, 'Seit über 48 Stunden kein Backup')
    assert.match(m.body, /8\. Nov\. 2026/)
    assert.match(m.body, /Letzter Fehler: Repository nicht erreichbar/)
  })
})

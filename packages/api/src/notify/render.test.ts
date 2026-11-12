import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { notifyEvents, EVENT_LABEL } from './render.js'

/**
 * Abgrenzung HomeBento: Auslastung des Servers (CPU, Arbeitsspeicher) meldet
 * HomeBento. Airlock meldet nur, was seine Projekte betrifft – Deploy,
 * Security, Vorfälle, Zertifikat/Tunnel, volle Platte – und was es selbst
 * betreibt (Backup, Ablauf von Chat-Projekten, Gateway, Wochenbericht).
 */
describe('Benachrichtigungen: keine Server-Alarme', () => {
  test('kein Ereignis zu CPU, RAM oder Last', () => {
    for (const e of notifyEvents) {
      assert.doesNotMatch(e, /cpu|ram|mem|load|server/i, e)
      assert.doesNotMatch(EVENT_LABEL[e], /CPU|RAM|Arbeitsspeicher|Auslastung|Last\b/, e)
    }
  })

  test('die Meldungen, die bleiben', () => {
    assert.deepEqual([...notifyEvents].sort(), [
      'backup_failed', 'backup_stale', 'deploy_failed', 'disk_space', 'expiry', 'external_verification_lost',
      'finding_critical', 'finding_high', 'gateway_warning', 'incident', 'infra_problem', 'project_public', 'weekly_summary',
    ])
  })
})

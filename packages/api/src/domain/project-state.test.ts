import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { projectState } from '@airlock/shared'

const dep = (id: string, status: 'active' | 'failed' | 'pulling' | 'superseded', errorMessage: string | null = null) => ({ id, status, errorMessage })
const base = {
  status: 'running' as const,
  desiredState: 'running' as const,
  activeDeployment: { id: 'd1' },
  lastDeployment: dep('d1', 'active'),
  routes: [{ target: 'lan', pausedAt: null }],
  container: { running: true, exitCode: null },
}

describe('Projektzustand: eine Quelle für Pille, Unterzeile, Fehlerbox, Liste', () => {
  test('läuft', () => {
    assert.equal(projectState(base).key, 'running')
    assert.equal(projectState(base).label, 'läuft')
  })

  test('neue Version gescheitert, alte läuft weiter – mit dem Grund als Unterzeile', () => {
    const s = projectState({ ...base, status: 'failed', lastDeployment: dep('d2', 'failed', 'Healthcheck /health antwortet nicht') })
    assert.equal(s.key, 'failed_old_running')
    assert.equal(s.label, 'neue Version gescheitert, alte läuft weiter')
    assert.equal(s.detail, 'Healthcheck /health antwortet nicht')
  })

  test('Unterzeile nimmt den Titel der Fehlererklärung, wenn es einen gibt (wie die Fehlerbox)', () => {
    const last = { ...dep('d2', 'failed', 'Healthcheck nicht bestanden'), failure: { title: 'Umgebungsvariable SENSOR_URL fehlt' } }
    assert.equal(projectState({ ...base, status: 'failed', lastDeployment: last }).detail, 'Umgebungsvariable SENSOR_URL fehlt')
  })

  test('deployt gerade hat Vorrang, auch wenn der Status noch «running» ist', () => {
    assert.equal(projectState({ ...base, lastDeployment: dep('d2', 'pulling') }).key, 'deploying')
    assert.equal(projectState({ ...base, status: 'deploying' }).key, 'deploying')
  })

  test('gestoppt (gewollt) vor allem anderen ausser Deploy', () => {
    assert.equal(projectState({ ...base, desiredState: 'stopped', container: { running: false, exitCode: 0 } }).key, 'stopped')
  })

  test('nichts läuft: keine aktive Fassung, Container weg oder beendet', () => {
    assert.equal(projectState({ ...base, activeDeployment: null, lastDeployment: dep('d1', 'failed') }).key, 'down')
    const gone = projectState({ ...base, container: { running: false, missing: true, exitCode: null } })
    assert.equal(gone.key, 'down')
    assert.match(gone.detail!, /fehlt/)
    assert.match(projectState({ ...base, container: { running: false, exitCode: 137 } }).detail!, /Exit-Code 137/)
  })

  test('neues Projekt (desiredState stopped): erster Deploy gescheitert ist nicht «gestoppt»', () => {
    const s = projectState({ ...base, desiredState: 'stopped', status: 'failed', activeDeployment: null, lastDeployment: dep('d1', 'failed') })
    assert.equal(s.key, 'down')
    assert.equal(s.tone, 'bad')
    assert.match(s.detail!, /erste Deploy ist gescheitert/)
    // Noch nie deployt: nichts läuft, aber neutral (kein Fehler)
    const fresh = projectState({ ...base, desiredState: 'stopped', status: 'created', activeDeployment: null, lastDeployment: null })
    assert.equal(fresh.key, 'down')
    assert.equal(fresh.tone, 'neutral')
  })

  test('pausiert (öffentlich), intern läuft es weiter', () => {
    const s = projectState({ ...base, routes: [{ target: 'public', pausedAt: '2026-11-10T10:00:00Z' }] })
    assert.equal(s.key, 'paused')
    assert.match(s.detail!, /intern läuft es weiter/)
  })

  test('Container unbekannt (statische Seite, noch keine Monitor-Runde): kein «nichts läuft»', () => {
    assert.equal(projectState({ ...base, container: null }).key, 'running')
  })

  test('jeder Zustand hat ein Wort und einen Ton', () => {
    for (const s of [projectState(base), projectState({ ...base, desiredState: 'stopped' }), projectState({ ...base, activeDeployment: null, lastDeployment: null })]) {
      assert.ok(s.label.length > 0)
      assert.ok(['ok', 'warn', 'bad', 'info', 'neutral'].includes(s.tone))
    }
  })
})

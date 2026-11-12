import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { FindingDto, ProjectDto } from '@airlock/shared'
import { diskettiTip } from './disketti.js'

/** Nur die Felder, die Disketti liest */
const project = (o: Partial<ProjectDto> = {}): ProjectDto => ({
  id: 'p1', name: 'Wetter', slug: 'wetter', sourceType: 'compose',
  state: { key: 'running' }, activeDeployment: { id: 'd0' }, lastDeployment: null,
  ...o,
} as unknown as ProjectDto)

const finding = (o: Partial<FindingDto>): FindingDto => ({
  id: 'f', tool: 'semgrep', severity: 'medium', title: 'Befund', location: 'app.js:1', description: '', fix: '', status: 'open', acceptReason: null, ...o,
})

const failed = (failure: unknown, errorMessage: string | null = null) => project({
  state: { key: 'down' } as ProjectDto['state'], activeDeployment: null,
  lastDeployment: { id: 'd9', status: 'failed', errorMessage, failure } as unknown as ProjectDto['lastDeployment'],
})

describe('Disketti spricht nur über echte Daten', () => {
  test('keine Daten, kein Hinweis (und damit keine Figur)', () => {
    assert.equal(diskettiTip({ project: null, findings: null }), null)
    assert.equal(diskettiTip({ project: project(), findings: null }), null)
    assert.equal(diskettiTip({ project: project(), findings: [] }), null)
  })

  test('akzeptierte und behobene Befunde zählen nicht', () => {
    const r = diskettiTip({ project: project(), findings: [finding({ status: 'accepted' }), finding({ id: 'g', status: 'fixed' })] })
    assert.equal(r, null)
  })

  test('fehlende CSP: «Sieht aus, als fehlt eine CSP. Soll Claude helfen?»', () => {
    const r = diskettiTip({ project: project(), findings: [finding({ id: 'csp', tool: 'header-check', title: 'Content-Security-Policy fehlt', severity: 'medium' })] })
    assert.deepEqual(r, { key: 'finding:csp', kind: 'finding', findingId: 'csp', text: 'Sieht aus, als fehlt eine CSP.', question: 'Soll Claude helfen?' })
  })

  test('der schwerste offene Befund kommt zuerst; Titel aus dem Befund', () => {
    const r = diskettiTip({ project: project(), findings: [
      finding({ id: 'a', severity: 'low', title: 'Kleinigkeit' }),
      finding({ id: 'b', severity: 'high', title: 'SQL-Injection in /suche.' }),
      finding({ id: 'c', severity: 'medium' }),
    ] })
    assert.equal(r?.findingId, 'b')
    assert.equal(r?.text, 'Ein offener Befund (hoch): SQL-Injection in /suche.')
    assert.equal(r?.question, 'Soll Claude helfen?')
  })

  test('anderer Header: Airlock setzt ihn selbst – Disketti zeigt den Weg statt Claude', () => {
    const r = diskettiTip({ project: project(), findings: [finding({ id: 'h', tool: 'header-check', title: 'Strict-Transport-Security fehlt' })] })
    assert.equal(r?.text, 'Sieht aus, als fehlt HSTS.')
    assert.equal(r?.question, 'Soll ich dir zeigen, wie du ihn setzt?')
  })

  test('gescheiterter Deploy vor Befunden; Text aus der festgehaltenen Erklärung', () => {
    const r = diskettiTip({ project: failed({ title: 'Build gescheitert', action: { kind: 'claude', label: 'Mit Claude lösen' } }), findings: [finding({ severity: 'critical' })] })
    assert.deepEqual(r, { key: 'deploy:d9', kind: 'deploy', deploymentId: 'd9', text: 'Der letzte Deploy hat nicht geklappt: Build gescheitert.', question: 'Soll Claude helfen?' })
  })

  test('gescheitert ohne Claude-Weg: «Ja» führt zur Fehlerbox', () => {
    const r = diskettiTip({ project: failed({ title: 'Port belegt', action: { kind: 'set_field' } }), findings: null })
    assert.equal(r?.question, 'Soll ich dir zeigen, was zu tun ist?')
    // Alte Deploys ohne Erklärung: die Fehlermeldung
    assert.equal(diskettiTip({ project: failed(null, 'Image nicht gefunden'), findings: null })?.text, 'Der letzte Deploy hat nicht geklappt: Image nicht gefunden.')
  })

  test('gescheiterter Deploy, aber eine ältere Fassung läuft weiter: zählt (Zustand «alte Fassung läuft»)', () => {
    const p = project({ state: { key: 'failed_old_running' } as ProjectDto['state'], lastDeployment: { id: 'd5', status: 'failed', errorMessage: 'kaputt', failure: null } as unknown as ProjectDto['lastDeployment'] })
    assert.equal(diskettiTip({ project: p, findings: null })?.key, 'deploy:d5')
  })

  test('fertiges Image mit bekannter Schwachstelle: Abhilfe statt Claude', () => {
    const r = diskettiTip({ project: project({ sourceType: 'image' }), findings: [finding({ tool: 'trivy', severity: 'critical', title: 'CVE-2026-1 in openssl' })] })
    assert.equal(r?.question, 'Soll ich dir die Abhilfe zeigen?')
  })

  test('erfolgreicher letzter Deploy ohne Befunde: still', () => {
    const p = project({ lastDeployment: { id: 'd1', status: 'active', errorMessage: null } as unknown as ProjectDto['lastDeployment'] })
    assert.equal(diskettiTip({ project: p, findings: [] }), null)
  })
})

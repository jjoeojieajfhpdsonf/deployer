import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DeployReason, DeploymentDto } from '@airlock/shared'
import { deriveReason, actorFromEvents, commitSubject, headerName, withHistory, type ReasonEvent } from './deploy-reason.js'

const at = (min: number) => new Date(Date.UTC(2026, 10, 10, 20, min))
const ev = (min: number, action: string, params: Record<string, unknown> = {}, actor = 'ui:joel'): ReasonEvent => ({ at: at(min), actor, action, params })

test('Rollback und Neu erstellen haben ihren eigenen Grund', () => {
  assert.deepEqual(deriveReason({ trigger: 'rollback', actor: 'ui:joel', isFirst: false, events: [] }), { kind: 'rollback', detail: null })
  assert.deepEqual(deriveReason({ trigger: 'rollback', recreate: true, actor: 'ui:joel', isFirst: false, events: [] }).kind, 'recreate')
})

test('Erstes Deployment, auch wenn vorher Einstellungen geändert wurden', () => {
  const r = deriveReason({ trigger: 'deploy', actor: 'token:claude', isFirst: true, events: [ev(1, 'header.set', { header: 'x-frame-options' })] })
  assert.equal(r.kind, 'first')
})

test('Code-Änderung schlägt Einstellungen und trägt den Commit-Betreff', () => {
  const r = deriveReason({
    trigger: 'deploy', actor: 'token:claude', isFirst: false,
    events: [ev(5, 'header.set', { header: 'referrer-policy' }), ev(3, 'files.update', { message: 'Hintergrund blau\n\nDetails' })],
  })
  assert.deepEqual(r, { kind: 'code', detail: 'Hintergrund blau' })
})

test('Übernommener Fix ohne Nachricht: Titel aus dem Befund', () => {
  const r = deriveReason({ trigger: 'deploy', actor: 'ui:joel', isFirst: false, events: [ev(2, 'fix.apply', { title: 'CSP fehlt' })] })
  assert.deepEqual(r, { kind: 'code', detail: 'Fix: CSP fehlt' })
})

test('Jüngste Einstellung zählt: Header nach Veröffentlichung', () => {
  const r = deriveReason({
    trigger: 'deploy', actor: 'ui:joel', isFirst: false,
    events: [ev(1, 'project.public', { hostname: 'a.example.ch' }), ev(4, 'header.set', { header: 'strict-transport-security' })],
  })
  assert.deepEqual(r, { kind: 'headers', detail: 'Strict-Transport-Security' })
})

test('Pausiert, intern, öffentlich, auch über MCP', () => {
  assert.equal(deriveReason({ trigger: 'deploy', actor: null, isFirst: false, events: [ev(1, 'project.public.pause')] }).kind, 'paused')
  assert.equal(deriveReason({ trigger: 'deploy', actor: null, isFirst: false, events: [ev(1, 'mcp.set_targets')] }).kind, 'internal')
  assert.deepEqual(deriveReason({ trigger: 'deploy', actor: null, isFirst: false, events: [ev(1, 'project.public.resume', { hostname: 'h.example.ch' })] }), { kind: 'public', detail: 'h.example.ch' })
})

test('Auto-Deploy nach Merge', () => {
  const r = deriveReason({ trigger: 'deploy', actor: 'system:auto-deploy', isFirst: false, events: [ev(1, 'project.auto_deploy', { head: 'abc', message: 'Merge #12' })] })
  assert.deepEqual(r, { kind: 'auto_merge', detail: 'Merge #12' })
})

test('Ohne Hinweis: neu deployt; unbekannte Ereignisse stören nicht', () => {
  assert.deepEqual(deriveReason({ trigger: 'deploy', actor: 'ui:joel', isFirst: false, events: [ev(1, 'auth.login'), ev(2, 'scan.start')] }), { kind: 'redeploy', detail: null })
})

test('Auslöser alter Einträge aus dem Deploy-Ereignis', () => {
  const events = [ev(1, 'project.deploy', { deployment: 'd1' }, 'token:claude-code-mac'), ev(2, 'project.deploy', { deployment: 'd2' }, 'ui:joel')]
  assert.equal(actorFromEvents('d1', events), 'token:claude-code-mac')
  assert.equal(actorFromEvents('d3', events), null)
})

test('Auslöser über MCP: Werkzeugaufruf desselben Tokens kurz vor dem Start', () => {
  const events = [ev(0, 'mcp.update_files', {}, 'token:claude-code-mac'), ev(1, 'project.deploy', { deployment: 'd1' }, 'token:claude-code-mac'), ev(9, 'project.deploy', { deployment: 'd2' }, 'token:backup')]
  assert.equal(actorFromEvents('d1', events, at(0)), 'mcp:claude-code-mac')
  assert.equal(actorFromEvents('d2', events, at(8)), 'token:backup')
})

test('Liste: Nummer, abgeleiteter Grund und Auslöser; gespeicherter Grund bleibt', () => {
  const row = (id: string, min: number, reason: DeployReason | null = null) => ({ id, startedAt: at(min), trigger: 'deploy' as const, reason, actor: reason ? 'ui:joel' : null })
  const toDto = (r: ReturnType<typeof row>) => ({ id: r.id, reason: r.reason ?? undefined, actor: r.actor } as DeploymentDto)
  const events = [ev(1, 'project.deploy', { deployment: 'a' }), ev(3, 'header.set', { header: 'x-frame-options' }), ev(5, 'project.deploy', { deployment: 'b' }, 'token:t')]
  const list = withHistory([row('c', 9, { kind: 'public', detail: null }), row('b', 4), row('a', 0)], 3, events, toDto)
  assert.deepEqual(list.map((d) => [d.seq, d.reason?.kind, d.actor]), [[3, 'public', 'ui:joel'], [2, 'headers', 'token:t'], [1, 'first', 'ui:joel']])
  // Ältester Eintrag der Liste, aber nicht der erste des Projekts: Zeitraum unbekannt
  assert.equal(withHistory([row('b', 4)], 5, events, toDto)[0]!.reason?.kind, 'redeploy')
})

test('Hilfen: Betreff und Header-Schreibweise', () => {
  assert.equal(commitSubject(''), null)
  assert.equal(commitSubject('x'.repeat(200))!.length, 120)
  assert.equal(headerName('x-custom-thing'), 'X-Custom-Thing')
})

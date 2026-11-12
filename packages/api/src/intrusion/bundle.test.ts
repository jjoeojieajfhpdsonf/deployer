import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bundleSignals, mergeSamples, mergeSignals, shouldAutoStop, shouldNotify, NOTIFY_PER_HOUR, type OpenIncident } from './bundle.js'
import { egressTargetsOf, fingerprintOf, type Signal } from './rules.js'
import { mcpIncidents } from './mcp.js'

/** Nacht 3, Etappe 5: Bündeln und Drosseln (rein) */

const AT = new Date('2026-11-12T22:00:00Z')
const P = '11111111-1111-4111-8111-111111111111'
const sig = (o: Partial<Signal> = {}): Signal => ({
  projectId: P, source: 'prozess', kind: 'prozess_verdaechtig', severity: 'hoch', key: 'web|sh', title: 'Shell gestartet: sh',
  subject: 'sh', service: 'web', count: 1, samples: ['sh -i'], at: AT, ...o,
})
const open = (o: Partial<OpenIncident> = {}): OpenIncident => ({
  id: 'i1', fingerprint: fingerprintOf(sig()), severity: 'hoch', status: 'offen', count: 3, samples: ['sh'], lastSeen: new Date(AT.getTime() - 60_000), repeatLoggedAt: new Date(AT.getTime() - 60_000), ...o,
})

describe('Bündeln', () => {
  test('gleiche Hinweise einer Runde werden einer, mit Summe und schwerstem Grad', () => {
    const m = mergeSignals([sig({ count: 2 }), sig({ count: 1, severity: 'kritisch', title: 'x', samples: ['sh -c curl'] })])
    const s = [...m.values()][0]!
    assert.equal(m.size, 1)
    assert.equal(s.count, 3)
    assert.equal(s.severity, 'kritisch')
    assert.equal(s.title, 'x')
    assert.deepEqual(s.samples, ['sh -c curl', 'sh -i'])
  })

  test('ohne offenen Vorfall: neu, Zähler aus dem Fenster (initialCount)', () => {
    const r = bundleSignals([], [sig({ kind: 'login_fehlversuche', count: 1, initialCount: 5, projectId: null, key: '1.2.3.4' })])
    assert.equal(r.create.length, 1)
    assert.equal(r.create[0]!.count, 5)
    assert.equal(r.create[0]!.fingerprint, 'server|login_fehlversuche|1.2.3.4')
  })

  test('offener Vorfall: Zähler hoch, Beispiele vorn, «erneut» höchstens stündlich', () => {
    const r = bundleSignals([open()], [sig({ count: 2, samples: ['bash'] })])
    assert.equal(r.create.length, 0)
    const u = r.update[0]!
    assert.equal(u.count, 5)
    assert.deepEqual(u.samples, ['bash', 'sh'])
    assert.equal(u.logRepeat, false)
    assert.equal(u.escalatedFrom, null)
    assert.equal(bundleSignals([open({ repeatLoggedAt: new Date(AT.getTime() - 2 * 3_600_000) })], [sig()]).update[0]!.logRepeat, true)
  })

  test('schwerer geworden: hochgestuft, «gesehen» wird wieder «offen»', () => {
    const u = bundleSignals([open({ status: 'gesehen', severity: 'mittel' })], [sig({ severity: 'kritisch' })]).update[0]!
    assert.equal(u.severity, 'kritisch')
    assert.equal(u.escalatedFrom, 'mittel')
    assert.equal(u.status, 'offen')
    // gleich schwer: bleibt gesehen
    assert.equal(bundleSignals([open({ status: 'gesehen' })], [sig()]).update[0]!.status, 'gesehen')
  })

  test('erledigt zählt nicht: derselbe Hinweis öffnet einen neuen Vorfall', () => {
    const r = bundleSignals([open({ status: 'erledigt' })], [sig()])
    assert.equal(r.create.length, 1)
    assert.equal(r.update.length, 0)
  })

  test('Beispiele ohne Doppelte, höchstens 20', () => {
    assert.equal(mergeSamples(Array.from({ length: 15 }, (_, i) => `n${i}`), Array.from({ length: 15 }, (_, i) => `o${i}`)).length, 20)
    assert.deepEqual(mergeSamples(['a', 'b'], ['b', 'c']), ['a', 'b', 'c'])
  })
})

describe('Melden und Reagieren', () => {
  const base = { severity: 'hoch' as const, notifiedAt: null, notifiedSeverity: null, sentLastHour: 0, now: AT }
  test('nur hoch und kritisch, je Vorfall einmal', () => {
    assert.equal(shouldNotify(base), true)
    assert.equal(shouldNotify({ ...base, severity: 'mittel' }), false)
    assert.equal(shouldNotify({ ...base, notifiedAt: new Date(AT.getTime() - 3_600_000), notifiedSeverity: 'hoch' }), false)
  })
  test('wieder bei höherem Grad oder nach einem Tag', () => {
    assert.equal(shouldNotify({ ...base, severity: 'kritisch', notifiedAt: new Date(AT.getTime() - 60_000), notifiedSeverity: 'hoch' }), true)
    assert.equal(shouldNotify({ ...base, notifiedAt: new Date(AT.getTime() - 25 * 3_600_000), notifiedSeverity: 'hoch' }), true)
  })
  test('Drosselung: höchstens 5 Meldungen pro Stunde für alle Vorfälle zusammen', () => {
    assert.equal(shouldNotify({ ...base, severity: 'kritisch', sentLastHour: NOTIFY_PER_HOUR }), false)
    assert.equal(shouldNotify({ ...base, sentLastHour: NOTIFY_PER_HOUR - 1 }), true)
  })
  test('Stoppen und pausieren: nur mit Schalter, nur kritisch, nur einmal, nie für den Server', () => {
    const o = { severity: 'kritisch' as const, autoStop: true, reactedAt: null, projectId: P }
    assert.equal(shouldAutoStop(o), true)
    assert.equal(shouldAutoStop({ ...o, autoStop: false }), false)
    assert.equal(shouldAutoStop({ ...o, severity: 'hoch' }), false)
    assert.equal(shouldAutoStop({ ...o, reactedAt: AT }), false)
    assert.equal(shouldAutoStop({ ...o, projectId: null }), false)
  })
})

describe('MCP und Netz-Ziele', () => {
  test('list_incidents: nur Projekte, keine Notiz, höchstens 5 Beispiele', () => {
    const inc = {
      id: 'x', source: 'prozess' as const, kind: 'prozess_verdaechtig' as const, severity: 'hoch' as const, status: 'offen' as const, title: 't',
      subject: 'sh', service: 'web', count: 2, firstSeen: AT.toISOString(), lastSeen: AT.toISOString(), note: 'privat',
      samples: ['1', '2', '3', '4', '5', '6'], notifiedAt: null, reactedAt: null, canMarkNormal: true,
    }
    const out = mcpIncidents({ incidents: [{ ...inc, project: { id: P, name: 'Shop' } }, { ...inc, id: 'y', project: null }], counts: { active: { niedrig: 0, mittel: 0, hoch: 2, kritisch: 0 }, unseen: 2 } })
    const list = out.incidents as Record<string, unknown>[]
    assert.equal(list.length, 1)
    assert.equal(list[0]!.project, 'Shop')
    assert.equal('note' in list[0]!, false)
    assert.equal((list[0]!.examples as string[]).length, 5)
    assert.deepEqual(out.open_by_severity, { hoch: 1 })
  })
  test('Ziele aus den Beispielen eines Netz-Vorfalls', () => {
    assert.deepEqual(egressTargetsOf(['192.168.0.12:445/tcp (3×)', '192.168.0.1:80/tcp (Server) (1×)', 'unsinn; rm']), ['192.168.0.12:445', '192.168.0.1:80'])
  })
})

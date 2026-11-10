import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// Reine Funktionen; das Modul lädt die Datenbank nur als Verbindung (ohne Abfrage)
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
process.env.TZ = 'Europe/Zurich'
const { gateReason, describeRequest, mcpRequestInfo } = await import('./public-requests.js')

const at = new Date('2026-11-10T18:04:00Z') // 19:04 in Zürich
const req = { requestedAt: at, actor: 'token:claude-code-mac', approvedBy: null as string | null, lastError: null as string | null }

describe('Grund, warum gerade nicht veröffentlicht werden kann', () => {
  test('Scan läuft seit 5 Min.', () => {
    const r = gateReason({ why: 'scan_running', runningSince: new Date(at.getTime()), now: at.getTime() + 5 * 60_000 + 20_000 })
    assert.match(r, /^Scan läuft seit 5 Min\./)
  })
  test('1 kritischer Befund offen, mit Titel', () => {
    assert.match(gateReason({ why: 'critical', critical: ['minimist: 1 bekannte Schwachstelle'] }), /^1 kritischer Befund offen: minimist/)
    assert.match(gateReason({ why: 'critical', critical: ['a', 'b', 'c'] }), /^3 kritische Befunde offen: a; b\./)
  })
  test('noch kein Scan', () => {
    assert.match(gateReason({ why: 'no_scan' }), /Noch kein abgeschlossener Scan/)
  })
})

describe('Zustand einer vorgemerkten Anfrage', () => {
  const running = { ok: false as const, why: 'scan_running' as const, reason: 'Scan läuft seit 5 Min.' }
  const critical = { ok: false as const, why: 'critical' as const, reason: '1 kritischer Befund offen: x.' }

  test('wartet auf Scan: nennt wer, wann, worauf', () => {
    const d = describeRequest(req, running)
    assert.equal(d.state, 'waiting')
    assert.equal(d.text, 'Öffentlich angefragt von token:claude-code-mac um 19:04 – wartet auf abgeschlossenen Scan ohne kritischen Befund.')
  })

  test('kritischer Befund: gesperrt mit Grund', () => {
    const d = describeRequest(req, critical)
    assert.equal(d.state, 'blocked')
    assert.match(d.text, /gesperrt, solange ein kritischer Befund offen ist/)
  })

  test('Scan bestanden, aber unbestätigt: nie still – braucht Bestätigung', () => {
    const d = describeRequest(req, { ok: true })
    assert.equal(d.state, 'ready')
    assert.match(d.text, /braucht noch deine Bestätigung/)
  })

  test('bestätigt: wird nach dem Scan automatisch veröffentlicht', () => {
    assert.match(describeRequest({ ...req, approvedBy: 'joel' }, running).text, /Bestätigt von joel: wird danach automatisch veröffentlicht/)
  })

  test('gescheiterter automatischer Versuch', () => {
    const d = describeRequest({ ...req, approvedBy: 'joel', lastError: 'Name belegt' }, { ok: true })
    assert.equal(d.state, 'failed')
    assert.match(d.text, /gescheitert: Name belegt/)
  })
})

describe('MCP-Antwort', () => {
  test('sagt klar: vorgemerkt, nicht öffentlich, wartet auf Scan', () => {
    const m = mcpRequestInfo(req, { ok: false, why: 'scan_running', reason: 'Scan läuft seit 5 Min. – …' })
    assert.equal(m.state, 'vorgemerkt, nicht öffentlich')
    assert.equal(m.waits_for, 'abgeschlossenen Scan ohne kritischen Befund')
    assert.equal(m.confirmed_in_ui, false)
    assert.match(m.next, /Nichts wird still veröffentlicht/)
    assert.match(m.reason, /^Scan läuft/)
  })

  test('kritischer Befund: wartet auf dessen Behebung', () => {
    const m = mcpRequestInfo(req, { ok: false, why: 'critical', reason: '1 kritischer Befund offen: x.' })
    assert.equal(m.waits_for, '1 kritischer Befund offen: x.')
  })
})

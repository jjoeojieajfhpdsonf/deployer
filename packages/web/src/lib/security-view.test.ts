import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { FindingDto, FixRequestDto, HeaderRulesDto } from '@airlock/shared'
import {
  situation, topImpact, findingHint, sortFindings, shortLocation, headerStates, settableInOne, wouldBlock, stageChips, sparkPoints, detailsLink, fixesFor,
} from './security-view.js'

let n = 0
const f = (p: Partial<FindingDto>): FindingDto => ({
  id: `f${++n}`, tool: 'zap', severity: 'medium', title: `Befund ${n}`, location: 'https://x.example.ch/', description: '', fix: '', status: 'open', acceptReason: null, ...p,
})
const fix = (p: Partial<FixRequestDto>): FixRequestDto => ({
  id: `x${++n}`, findingId: null, findingTitle: '', tool: 'trivy', way: 'mcp', status: 'proposed', explanation: '', diff: '', baseCommit: null, commit: null,
  branch: null, prUrl: null, note: null, actor: 'token:claude', createdAt: '2026-11-12T08:00:00Z', updatedAt: '2026-11-12T08:00:00Z', ...p,
})
const rules = (p: Partial<HeaderRulesDto> = {}): HeaderRulesDto => ({
  rules: [], hsts: { ok: true, reason: null }, viaCaddy: true,
  csp: { violations: [], total: 0, suggestion: null, notes: [], analysis: null, readiness: null, inlinePrompt: null }, ...p,
})

describe('Lage in einem Satz', () => {
  test('ohne Befunde', () => {
    assert.deepEqual(situation([], []), { headline: 'Keine offenen Befunde.', detail: null, tone: 'ok' })
  })

  test('kritisch sperrt Öffentlich; Basis-Image zusammengefasst; Vorschläge gezählt', () => {
    const open = [
      f({ tool: 'trivy', severity: 'critical', fix: 'openssl auf 3.0.15 oder neuer aktualisieren (meist: Basis-Image aktualisieren und neu bauen).' }),
      f({ tool: 'trivy', severity: 'low', fix: 'tzdata aktualisieren (meist: Basis-Image aktualisieren und neu bauen).' }),
      f({ severity: 'high', title: 'Session-Cookie ohne Secure' }),
      f({ tool: 'trivy', title: 'Container läuft als root' }),
    ]
    const s = situation(open, [fix({ findingTitle: 'Container läuft als root', tool: 'trivy' }), fix({ findingId: open[2]!.id, status: 'rejected' })])
    assert.equal(s.headline, '1 kritische Lücke und 1 hoher Befund – öffentlich machen ist gesperrt.')
    assert.equal(s.detail, 'Am meisten bringt: Basis-Image aktualisieren (+26). Für 1 Befund liegt ein Vorschlag von Claude bereit.')
    assert.equal(s.tone, 'bad')
  })

  test('nur hohe bzw. mittlere Befunde', () => {
    assert.equal(situation([f({ severity: 'high' }), f({ severity: 'high' })], []).headline, '2 hohe Befunde offen – öffentlich machen ist möglich.')
    const s = situation([f({ severity: 'medium', tool: 'header-check', title: 'Strict-Transport-Security fehlt' }), f({ severity: 'low' })], [])
    assert.equal(s.headline, '2 offene Befunde, keiner kritisch oder hoch.')
    assert.equal(s.detail, 'Am meisten bringt: Strict-Transport-Security setzen (+4).')
  })

  test('Wirkung zählt nur, was der Score wirklich gewinnt (Minimum 0)', () => {
    const many = Array.from({ length: 5 }, () => f({ severity: 'critical' }))
    // 125 Punkte Abzug: ein einzelner Befund hebt den Score nicht über 0
    assert.equal(topImpact(many), null)
    // 101 Punkte Abzug (Score 0): ohne einen kritischen 76 → Score 24, nicht 25
    assert.equal(topImpact([...many.slice(0, 4), f({ severity: 'low' })])?.points, 24)
  })
})

describe('Zeilen der Befundliste', () => {
  const r = rules({ rules: [{ header: 'frame-ancestors', value: "'self'", mode: 'enforce', createdAt: '', updatedAt: '' }] })
  test('Hinweis je Befund', () => {
    const hint = (x: Partial<FindingDto>, fixes: FixRequestDto[] = [], sourceType = 'git') => findingHint(f(x), { fixes, rules: r, sourceType })?.label ?? null
    assert.equal(hint({ severity: 'critical' }), 'blockiert Öffentlich')
    assert.equal(hint({ title: 'Container läuft als root', tool: 'trivy' }, [fix({ findingTitle: 'Container läuft als root' })]), 'Vorschlag bereit')
    assert.equal(hint({ tool: 'header-check', title: 'Content-Security-Policy fehlt' }), 'Header & CSP')
    assert.equal(hint({ tool: 'zap', title: 'CSP: Failure to Define Directive with No Fallback' }), 'Header & CSP')
    assert.equal(hint({ tool: 'header-check', title: 'X-Content-Type-Options: nosniff fehlt' }), 'Ein Klick')
    // Regel besteht schon: kein «Ein Klick»
    assert.equal(hint({ tool: 'header-check', title: 'Schutz gegen Einbetten fehlt (frame-ancestors / X-Frame-Options)' }), null)
    assert.equal(hint({ tool: 'trivy', severity: 'low', fix: 'Basis-Image aktualisieren und neu bauen.' }), 'beim nächsten Build')
    assert.equal(hint({ tool: 'trivy', severity: 'low', fix: 'Basis-Image aktualisieren und neu bauen.' }, [], 'image'), null)
    assert.equal(hint({ status: 'accepted', severity: 'critical' }), null)
    // HSTS ohne HTTPS: kein Ein-Klick
    assert.equal(findingHint(f({ tool: 'header-check', title: 'Strict-Transport-Security fehlt' }), { fixes: [], rules: rules({ hsts: { ok: false, reason: 'kein HTTPS' } }) }), null)
  })

  test('Sortierung nach Schwere, Quelle und Alter', () => {
    const a = f({ severity: 'low', tool: 'trivy', title: 'A', firstSeenAt: '2026-11-01T00:00:00Z' })
    const b = f({ severity: 'critical', tool: 'zap', title: 'B', firstSeenAt: '2026-11-10T00:00:00Z' })
    const c = f({ severity: 'medium', tool: 'header-check', title: 'C' })
    assert.deepEqual(sortFindings([a, b, c], 'schwere').map((x) => x.title), ['B', 'C', 'A'])
    assert.deepEqual(sortFindings([a, b, c], 'quelle', 'image').map((x) => x.title), ['C', 'A', 'B'])
    assert.deepEqual(sortFindings([c, b, a], 'alter').map((x) => x.title), ['A', 'B', 'C'])
  })

  test('Ort ohne Host, Details-Link, Vorschläge zum Befund', () => {
    assert.equal(shortLocation('https://x.example.ch/login?a=1'), '/login?a=1')
    assert.equal(shortLocation('https://x.example.ch/'), '')
    assert.equal(shortLocation('image: api · /usr/lib/libssl.so.3'), 'image: api · /usr/lib/libssl.so.3')
    assert.deepEqual(detailsLink({ title: 'CVE-2026-31337 in openssl', description: '' }), { href: 'https://nvd.nist.gov/vuln/detail/CVE-2026-31337', label: 'CVE-Details' })
    assert.equal(detailsLink({ title: 'Container läuft als root', description: '' }), null)
    const x = f({ title: 'T', tool: 'trivy' })
    const older = fix({ findingId: x.id, createdAt: '2026-11-01T00:00:00Z' })
    const newer = fix({ findingTitle: 'T', tool: 'trivy', createdAt: '2026-11-11T00:00:00Z' })
    assert.deepEqual(fixesFor(x, [older, newer, fix({ findingTitle: 'T', tool: 'zap' })]).map((y) => y.id), [newer.id, older.id])
  })
})

describe('Header & CSP', () => {
  test('Zustände: fehlt, App setzt, Caddy setzt, Vorlage, Regel ruht', () => {
    const states = headerStates({
      rules: rules({
        rules: [
          { header: 'frame-ancestors', value: "'self'", mode: 'enforce', createdAt: '', updatedAt: '' },
          { header: 'content-security-policy', value: "default-src 'self'", mode: 'report-only', createdAt: '', updatedAt: '' },
          { header: 'x-content-type-options', value: 'nosniff', mode: 'enforce', createdAt: '', updatedAt: '' },
        ],
        inherited: [{ header: 'permissions-policy', value: 'camera=()', mode: 'enforce', disabled: false }],
      }),
      observed: { 'referrer-policy': 'strict-origin', 'frame-ancestors': "'self'", 'x-content-type-options': 'NOSNIFF' },
      findings: [f({ tool: 'header-check', title: 'Strict-Transport-Security fehlt' })],
    })
    const by = Object.fromEntries(states.map((s) => [s.key, s]))
    assert.equal(by['strict-transport-security']!.state, 'missing')
    assert.equal(by['frame-ancestors']!.state, 'caddy')
    assert.equal(by['referrer-policy']!.state, 'app')
    assert.equal(by['referrer-policy']!.value, 'strict-origin')
    assert.equal(by['permissions-policy']!.state, 'template')
    assert.equal(by['content-security-policy']!.mode, 'report-only')
    // App setzt einen anderen Wert: Caddy-Regel ruht
    assert.equal(by['x-content-type-options']!.state, 'app')
    assert.match(by['x-content-type-options']!.note ?? '', /ruht/)
    assert.deepEqual(states.map((s) => s.key).at(-1), 'content-security-policy')
  })

  test('ohne gesehene Werte: vorhanden, sofern kein Befund; ein Klick nur ohne Rückfrage', () => {
    const states = headerStates({
      rules: rules(),
      findings: [
        f({ tool: 'header-check', title: 'Referrer-Policy fehlt' }),
        f({ tool: 'header-check', title: 'Strict-Transport-Security fehlt' }),
        f({ tool: 'header-check', title: 'X-Content-Type-Options: nosniff fehlt', status: 'accepted' }),
      ],
    })
    const by = Object.fromEntries(states.map((s) => [s.key, s.state]))
    assert.equal(by['referrer-policy'], 'missing')
    assert.equal(by['x-content-type-options'], 'accepted')
    assert.equal(by['permissions-policy'], 'present')
    assert.deepEqual(settableInOne(states), ['referrer-policy'])
  })

  test('Würde blockieren: gruppiert, meiste Aufrufe zuerst, Analyse ohne Doppel', () => {
    const rows = wouldBlock([
      { directive: 'script-src-elem', blocked: 'https://cdn.jsdelivr.net/npm/x.js', samplePath: '/auswertung', count: 5, lastSeen: '' },
      { directive: 'script-src', blocked: 'https://cdn.jsdelivr.net/npm/y.js', samplePath: '/', count: 2, lastSeen: '' },
      { directive: 'style-src', blocked: 'inline', samplePath: '/', count: 17, lastSeen: '' },
    ], {
      pages: ['/'], inlineScripts: 1, inlineStyles: 1, styleAttributes: 0, eventHandlers: 0, external: {}, error: null,
      conflicts: ['1 Inline-Skript (<script> ohne src)', '1 Inline-Style (<style>)', 'script-src: https://cdn.jsdelivr.net'],
    })
    assert.deepEqual(rows, [
      { text: 'Inline-Style auf', code: '/', count: 17 },
      { text: 'Skript von', code: 'cdn.jsdelivr.net', count: 7 },
      { text: '1 Inline-Skript (<script> ohne src)', code: null, count: null },
    ])
  })
})

describe('Prüfstufen und Verlauf', () => {
  test('Chips je Grundstufe mit Zustand und Anzahl', () => {
    const chips = stageChips({
      'trivy-image a': { ran: true, state: 'done', findings: 2 },
      'trivy-image b': { ran: true, state: 'done', findings: 0 },
      'trivy-source': { ran: false, state: 'skipped' },
      headers: { ran: true, state: 'done', findings: 1 },
      nuclei: { ran: true, state: 'done', findings: 0 },
      'zap-baseline': { ran: false, state: 'failed' },
    }, [f({ tool: 'trivy', severity: 'critical' }), f({ tool: 'trivy', severity: 'low' }), f({ tool: 'header-check', severity: 'low' })])
    assert.deepEqual(chips.map((c) => [c.key, c.label, c.state, c.count]), [
      ['trivy-image', 'Image', 'bad', 2],
      ['trivy-source', 'Eigener Code', 'skip', 0],
      ['headers', 'Header', 'warn', 1],
      ['zap-baseline', 'Webseite', 'failed', 0],
      ['nuclei', 'Dateien & Panels', 'ok', 0],
    ])
  })

  test('Kurve: älteste links, 100 oben', () => {
    assert.deepEqual(sparkPoints([100, null, 0], 108, 28), [{ x: 4, y: 4, v: 100 }, { x: 104, y: 24, v: 0 }])
    assert.deepEqual(sparkPoints([], 100, 20), [])
  })
})

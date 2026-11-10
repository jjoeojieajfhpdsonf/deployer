import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HEADER_DEFAULT } from '@deployer/shared'
import { analyzeHtml, mergeAnalyses, conflictsFor, conflictSummary, suggestWithAnalysis, parseChromeCsp, countPageViews, readinessFrom, VIEWS_NEEDED } from './csp-analysis.js'
import { parsePolicy } from './header-rules.js'
import { buildCaddyConfig, type RouteSpec } from '../drivers/caddy-config.js'

/**
 * CSP-Fix: hallo-welt hatte Inline-<style> und Inline-<script>; die
 * vorgeschlagene «default-src 'self'» wurde scharf geschaltet und hat beides
 * blockiert. Die Fixture bildet so eine Seite nach (plus externe Quellen).
 */
const html = readFileSync(join(import.meta.dirname, 'fixtures', 'csp-inline.html'), 'utf8')
const page = analyzeHtml(html, 'https://hallo-welt.example.ch/')
const merged = mergeAnalyses([page])

describe('Analyse der ausgelieferten Seite', () => {
  test('Inline-Code gezählt: Skript, Style, style-Attribut, onclick; Kommentar und JSON-LD nicht', () => {
    assert.equal(page.inlineScripts, 1)
    assert.equal(page.inlineStyles, 1)
    assert.equal(page.styleAttributes, 1)
    assert.equal(page.eventHandlers, 1)
  })
  test('externe Quellen je Direktive; eigene Herkunft nicht', () => {
    assert.deepEqual(page.external, {
      'script-src': ['https://cdn.jsdelivr.net'],
      'style-src': ['https://fonts.example.com'],
      'img-src': ['data:', 'https://cdn.example.net'],
    })
  })
  test('Links derselben Herkunft für weitere Seiten (keine Assets, keine fremden)', () => {
    assert.deepEqual(page.links, ['/kontakt/', '/ueber.html'])
  })
})

describe('Konflikte einer Regel', () => {
  test("die Regel von hallo-welt («default-src 'self'») blockiert Inline-Code und externe Quellen", () => {
    const c = conflictsFor(HEADER_DEFAULT['content-security-policy'], merged)
    assert.ok(c.some((x) => x.startsWith('1 Inline-Skript')))
    assert.ok(c.some((x) => x.startsWith('1 Inline-Style')))
    assert.ok(c.some((x) => x.startsWith('1 style-Attribut')))
    assert.ok(c.some((x) => x.startsWith('1 Ereignis-Attribut')))
    assert.ok(c.includes('script-src: https://cdn.jsdelivr.net'))
    assert.equal(
      conflictSummary(merged, "default-src 'self'"),
      'Diese CSP blockiert 1 Inline-Skript, 1 Inline-Style, 1 style-Attribut und 1 Ereignis-Attribut – zuerst auslagern.',
    )
  })

  test('Vorschlag ergänzt die externen Quellen, erlaubt aber keinen Inline-Code', () => {
    const s = suggestWithAnalysis(HEADER_DEFAULT['content-security-policy'], merged)
    const m = parsePolicy(s)
    assert.ok(m.get('script-src')!.includes('https://cdn.jsdelivr.net'))
    assert.ok(m.get('style-src')!.includes('https://fonts.example.com'))
    assert.ok(m.get('img-src')!.includes('https://cdn.example.net'))
    assert.ok(!s.includes('unsafe-inline'))
    const c = conflictsFor(s, merged)
    assert.ok(!c.some((x) => x.includes('https://')), 'externe Quellen sind jetzt erlaubt')
    assert.ok(c.some((x) => x.includes('Inline-Skript')), 'Inline-Code bleibt ein Konflikt')
  })

  test("mit 'unsafe-inline' bzw. ohne Inline-Code: kein Konflikt", () => {
    const loose = "default-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:"
    assert.deepEqual(conflictsFor(loose, merged), [])
    const clean = mergeAnalyses([analyzeHtml('<!doctype html><link rel="stylesheet" href="/a.css"><script src="/a.js"></script><p>x</p>', 'https://a.example/')])
    assert.deepEqual(conflictsFor("default-src 'self'", clean), [])
    assert.equal(conflictSummary(clean, "default-src 'self'"), null)
  })

  test("Nonce oder Hash: 'unsafe-inline' wird vom Browser ignoriert – Konflikt bleibt", () => {
    assert.ok(conflictsFor("default-src 'self'; script-src 'self' 'unsafe-inline' 'nonce-abc'; style-src 'self' 'unsafe-inline'", merged).some((x) => x.includes('Inline-Skript')))
  })

  test('Wildcard und Schema-Quellen werden erkannt', () => {
    const p = "default-src 'self'; script-src 'self' 'unsafe-inline' *.jsdelivr.net; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https://*.example.net"
    assert.deepEqual(conflictsFor(p, merged), [])
  })
})

describe('Scharf schalten erst mit Nachweis', () => {
  const base = { enforced: false, analysisError: null as string | null, conflicts: [] as string[], views: 0 as number | null, violationsSince: 0 }
  test('der Fall hallo-welt: Konflikte und keine Aufrufe -> gesperrt, mit Grund', () => {
    const r = readinessFrom({ ...base, conflicts: ['1 Inline-Skript (<script> ohne src)', '1 Inline-Style (<style>)'] })
    assert.equal(r.ok, false)
    assert.match(r.reason, /würde blockieren: 1 Inline-Skript/)
    assert.match(r.reason, /0 von 20 Aufrufen/)
  })
  test('Analyse ohne Konflikt -> frei, auch ohne Aufrufe', () => {
    assert.equal(readinessFrom(base).ok, true)
  })
  test(`genug Aufrufe ohne Verstoss -> frei trotz Konflikt in der Analyse`, () => {
    assert.equal(readinessFrom({ ...base, conflicts: ['x'], views: VIEWS_NEEDED }).ok, true)
    assert.equal(readinessFrom({ ...base, conflicts: ['x'], views: VIEWS_NEEDED, violationsSince: 1 }).ok, false, 'ein Verstoss sperrt')
    assert.equal(readinessFrom({ ...base, conflicts: ['x'], views: VIEWS_NEEDED - 1 }).ok, false)
  })
  test('Analyse unmöglich und Log nicht lesbar -> gesperrt', () => {
    const r = readinessFrom({ ...base, analysisError: 'Caddy bedient das Projekt gerade nicht', views: null })
    assert.equal(r.ok, false)
    assert.match(r.reason, /Analyse nicht möglich/)
  })
})

describe('Funktionsprüfung: Ausgabe von Chromium', () => {
  // Gekürzte echte Ausgabe von zenika/alpine-chrome:124 gegen die Fixture
  const log = [
    '### PAGE http://hallo-welt.example.ch/',
    "[7:7:1110/195129.203735:INFO:CONSOLE(1)] \"Refused to apply inline style because it violates the following Content Security Policy directive: \"default-src 'self'\". Either the 'unsafe-inline' keyword, a hash ('sha256-x'), or a nonce ('nonce-...') is required to enable inline execution.",
    "[7:7:1110/195129.203782:INFO:CONSOLE(1)] \"Refused to execute inline script because it violates the following Content Security Policy directive: \"default-src 'self'\". Either the 'unsafe-inline' keyword …",
    "[7:7:1110/195129.2:INFO:CONSOLE(1)] \"Refused to load the script 'https://cdn.jsdelivr.net/npm/confetti.js' because it violates the following Content Security Policy directive: \"script-src 'self'\".",
    '### PAGE http://hallo-welt.example.ch/ueber.html',
    "[7:7:1110/195130.1:INFO:CONSOLE(1)] \"[Report Only] Refused to apply inline style because it violates …Content Security Policy directive: \"style-src 'self'\"",
    '[7:7:1110/195130.2:INFO:config_dir_policy_loader.cc(118)] Skipping mandatory platform policies',
  ].join('\n')

  test('Verstösse je Seite; Report-Only und anderes Rauschen zählen nicht', () => {
    const r = parseChromeCsp(log)
    assert.deepEqual(r.pages, ['/', '/ueber.html'])
    assert.deepEqual(r.violations, [
      'Inline-Style (default-src) auf /',
      'Inline-Skript (default-src) auf /',
      "script https://cdn.jsdelivr.net/npm/confetti.js (script-src) auf /",
    ])
  })
  test('ohne Verstoss: leere Liste', () => {
    assert.deepEqual(parseChromeCsp('### PAGE http://a.example/\n[1:1:INFO:CONSOLE(0)] "hallo"').violations, [])
  })
})

describe('Aufrufe im Report-Only (Caddys Zugriffs-Log)', () => {
  const line = (o: { ts: number; host: string; uri: string; status?: number; method?: string; logger?: string }) =>
    JSON.stringify({ level: 'info', ts: o.ts, logger: o.logger ?? 'http.log.access.csp', msg: 'handled request', request: { method: o.method ?? 'GET', host: o.host, uri: o.uri }, status: o.status ?? 200 })
  const t0 = 1_800_000_000
  const log = [
    line({ ts: t0 + 1, host: 'hallo-welt.example.ch', uri: '/' }),
    line({ ts: t0 + 2, host: 'hallo-welt.example.ch', uri: '/ueber.html?x=1' }),
    line({ ts: t0 + 3, host: 'hallo-welt.example.ch', uri: '/app.js' }),
    line({ ts: t0 + 4, host: 'hallo-welt.example.ch', uri: '/.well-known/deployer/csp-report/k', method: 'POST' }),
    line({ ts: t0 + 5, host: 'hallo-welt.example.ch', uri: '/fehlt', status: 404 }),
    line({ ts: t0 + 6, host: 'anderes.example.ch', uri: '/' }),
    line({ ts: t0 - 100, host: 'hallo-welt.example.ch', uri: '/' }),
    line({ ts: t0 + 7, host: 'hallo-welt.example.ch', uri: '/', logger: 'http.log.access.deployer' }),
    'keine JSON-Zeile',
  ].join('\n')
  test('nur Seitenaufrufe (GET, < 400, kein Asset) der eigenen Namen seit Beginn', () => {
    assert.equal(countPageViews(log, { hosts: ['hallo-welt.example.ch'], sinceMs: t0 * 1000 }), 2)
  })

  test('Caddy schreibt das Log nur für Namen mit Report-Only-CSP', () => {
    const r = (mode: 'report-only' | 'enforce'): RouteSpec => ({
      hosts: ['hallo-welt.example.ch'], kind: 'files', root: '/srv', headers: [{ header: 'content-security-policy', value: "default-src 'self'", mode }],
    })
    const logsOf = (spec: RouteSpec) => (buildCaddyConfig([spec], { ipFilter: false, cidrs: [], adminSocket: '/a.sock' }) as { apps: { http: { servers: { srv0: { logs?: { logger_names: Record<string, string[]> } } } } } }).apps.http.servers.srv0.logs
    assert.deepEqual(logsOf(r('report-only'))?.logger_names, { 'hallo-welt.example.ch': ['csp'] })
    assert.equal(logsOf(r('enforce')), undefined)
  })
})

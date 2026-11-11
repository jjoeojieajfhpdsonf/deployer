/**
 * M8, Etappe 1: Security-Header über echtes Caddy (Image aus caddy/Dockerfile)
 * in einem Wegwerf-Container. Kein Airlock, keine Datenbank: geprüft wird
 * die Konfiguration aus buildCaddyConfig.
 *
 *   pnpm --filter @airlock/api exec tsx scripts/caddy-headers-e2e.ts
 *
 * - Besucher-Server mit IP-Filter: Absender ausserhalb der Netze -> 403
 * - Probe-Socket: dieselbe Route ohne Filter -> 200, mit den ergänzten Headern
 * - Setzt die App einen Header selbst, bleibt ihr Wert
 * - Statische Seite (file_server) bekommt die Header ebenso
 * - Der eigene Header-Check (checkHeaders) meldet danach nur noch, was fehlt
 * - Regel entfernt: Header fehlt wieder
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCaddyConfig, type RouteSpec } from '../src/drivers/caddy-config.js'
import { checkHeaders } from '../src/security/headers.js'
import { countPageViews } from '../src/security/csp-analysis.js'
import { HEADER_DEFAULT } from '@airlock/shared'

const NAME = 'airlock-caddy-headers-e2e'
const IMAGE = 'airlock-caddy-test:e2e'
const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`)
  if (!ok) failures++
}

const APP = 'solar.int.example.test'
const SITE = 'seite.int.example.test'
const KEY = 'abcdefghijklmnopqrstuvwx'
const REPORT = `/.well-known/airlock/csp-report/${KEY}`
/** Eigener Name für die CSP-Meldungen, erreichbar aus 127.0.0.0/8 (curl im Container) */
const MELDE = 'melde.int.example.test'

function config(withRules: boolean) {
  const rules = withRules
    ? [
        { header: 'x-content-type-options' as const, value: 'nosniff', mode: 'enforce' as const },
        { header: 'referrer-policy' as const, value: 'strict-origin-when-cross-origin', mode: 'enforce' as const },
        { header: 'frame-ancestors' as const, value: "'self'", mode: 'enforce' as const },
        { header: 'content-security-policy' as const, value: HEADER_DEFAULT['content-security-policy'], mode: 'report-only' as const },
      ]
    : []
  const routes: RouteSpec[] = [
    { hosts: [APP], kind: 'proxy', upstream: '127.0.0.1:8081', cidrs: ['10.254.0.0/16'], headers: rules, cspReportKey: KEY },
    { hosts: [SITE], kind: 'files', root: '/srv/site', cidrs: ['10.254.0.0/16'], headers: rules, cspReportKey: KEY },
    { hosts: [MELDE], kind: 'proxy', upstream: '127.0.0.1:8081', cidrs: ['127.0.0.0/8'], headers: rules, cspReportKey: KEY },
  ]
  const cfg = buildCaddyConfig(routes, {
    ipFilter: true, cidrs: ['10.254.0.0/16'], adminSocket: '/run/caddy/admin.sock', probeSocket: '/run/caddy/probe.sock',
    cspReportUpstream: '127.0.0.1:8082',
  }) as { apps: { http: { servers: Record<string, unknown> } } }
  // «airlock»: zeigt, welchen Pfad und wie viel Body er bekommt
  cfg.apps.http.servers.airlock = {
    listen: [':8082'],
    automatic_https: { disable: true },
    routes: [{ handle: [{ handler: 'static_response', status_code: 204, headers: { 'X-Seen-Uri': ['{http.request.uri}'], 'X-Seen-Cookie': ['{http.request.header.Cookie}'] } }], terminal: true }],
  }
  // Die «App»: setzt Referrer-Policy selbst (muss gewinnen)
  cfg.apps.http.servers.app = {
    listen: [':8081'],
    automatic_https: { disable: true },
    routes: [{ handle: [{ handler: 'static_response', status_code: 200, headers: { 'Referrer-Policy': ['no-referrer'] }, body: 'proto={http.request.header.X-Forwarded-Proto}' }], terminal: true }],
  }
  return cfg
}

/** Antwort per curl im Container; Header in Kleinbuchstaben. */
function fetchIn(args: string[]): { status: number; headers: Record<string, string>; body: string } {
  const out = sh('docker', ['exec', NAME, 'curl', '-s', '-i', ...args])
  const [head, ...rest] = out.split(/\r?\n\r?\n/)
  const lines = (head ?? '').split(/\r?\n/)
  const status = Number(lines[0]?.split(' ')[1] ?? 0)
  const headers: Record<string, string> = {}
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':')
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim()
  }
  return { status, headers, body: rest.join('\n\n') }
}
const viaProbe = (host: string) => fetchIn(['--unix-socket', '/run/caddy/probe.sock', `http://${host}/`])
const viaPort = (host: string) => fetchIn(['-H', `Host: ${host}`, 'http://127.0.0.1/'])

const dir = mkdtempSync(join(tmpdir(), 'caddy-headers-'))
sh('docker', ['build', '-q', '-t', IMAGE, join(repo, 'caddy')])
mkdirSync(join(dir, 'site'))
writeFileSync(join(dir, 'site', 'index.html'), '<!doctype html><title>x</title><p>Seite</p>')
writeFileSync(join(dir, 'with.json'), JSON.stringify(config(true)))
writeFileSync(join(dir, 'without.json'), JSON.stringify(config(false)))
writeFileSync(join(dir, 'big.json'), JSON.stringify({ 'csp-report': { 'script-sample': 'x'.repeat(70 * 1024) } }))
try {
  sh('docker', ['rm', '-f', NAME])
} catch {
  /* Container gab es nicht */
}
try {
  sh('docker', ['run', '-d', '--name', NAME, '--tmpfs', '/run/caddy', '-v', `${dir}:/t:ro`, '-v', `${join(dir, 'site')}:/srv/site:ro`, IMAGE, 'caddy', 'run', '--config', '/t/with.json'])
  sh('docker', ['exec', NAME, 'sh', '-c', 'for i in $(seq 1 20); do [ -S /run/caddy/probe.sock ] && exit 0; sleep 0.3; done; exit 1'])
  sh('docker', ['exec', NAME, 'sh', '-c', 'command -v curl >/dev/null || apk add -q curl >/dev/null'])

  const blocked = viaPort(APP)
  check(blocked.status === 403, `Besucher-Server: Absender ausserhalb der Netze -> ${blocked.status} (erwartet 403)`)

  const app = viaProbe(APP)
  check(app.status === 200, `Probe-Socket: ${app.status} ohne IP-Filter`)
  check(app.headers['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options ergänzt')
  check(app.headers['referrer-policy'] === 'no-referrer', `Referrer-Policy der App bleibt: ${app.headers['referrer-policy']}`)
  check(app.headers['content-security-policy'] === "frame-ancestors 'self'", 'frame-ancestors als eigene CSP')
  check(app.headers['x-frame-options'] === 'SAMEORIGIN', 'X-Frame-Options SAMEORIGIN')
  check((app.headers['content-security-policy-report-only'] ?? '').endsWith(`report-uri ${REPORT}`), 'CSP Report-Only mit report-uri')
  check(app.body.trim() === 'proto=http', `App sieht X-Forwarded-Proto wie ein Besucher über HTTP: ${app.body.trim()}`)

  const found = checkHeaders({ url: `http://${APP}/`, status: app.status, headers: app.headers, body: app.body, isHttps: false }).map((f) => f.title)
  check(found.length === 1 && found[0] === 'Content-Security-Policy fehlt', `Header-Check über Caddy: nur noch ${JSON.stringify(found)}`)

  const site = viaProbe(SITE)
  check(site.status === 200 && site.body.includes('Seite'), 'Statische Seite über den Probe-Socket')
  check(site.headers['x-content-type-options'] === 'nosniff' && site.headers['referrer-policy'] === 'strict-origin-when-cross-origin', 'Statische Seite bekommt die Header')

  // CSP-Meldungen am Host des Projekts
  const post = (path: string, extra: string[] = []) =>
    fetchIn(['-X', 'POST', '-H', `Host: ${MELDE}`, '-H', 'Content-Type: application/csp-report', '-H', 'Cookie: sitzung=geheim', ...extra, `http://127.0.0.1${path}`])
  const ok = post(REPORT, ['--data', '{"csp-report":{"effective-directive":"script-src","blocked-uri":"https://cdn.example"}}'])
  check(ok.status === 204 && ok.headers['x-seen-uri'] === `/api/v1/csp-reports/${KEY}`, `Meldung an Airlock weitergeleitet: ${ok.status} ${ok.headers['x-seen-uri']}`)
  check(!ok.headers['x-seen-cookie'], 'Cookies des Projekts gehen nicht an Airlock')
  const wrong = post('/.well-known/airlock/csp-report/falscherschluessel123456', ['--data', '{}'])
  check(wrong.status === 200 && !wrong.headers['x-seen-uri'], `falscher Schlüssel: nicht weitergeleitet (geht an die App, ${wrong.status})`)
  const get = fetchIn(['-H', `Host: ${MELDE}`, `http://127.0.0.1${REPORT}`])
  check(!get.headers['x-seen-uri'], 'GET wird nicht weitergeleitet')
  const big = post(REPORT, ['--data-binary', `@/t/big.json`])
  check(big.status === 413, `Body über 64 KB: ${big.status} (erwartet 413)`)
  // CSP-Fix: Aufrufe von Namen mit Report-Only-CSP landen im Zugriffs-Log (Logger csp)
  const since = Date.now() - 60_000
  for (let i = 0; i < 3; i++) fetchIn(['-H', `Host: ${MELDE}`, 'http://127.0.0.1/'])
  // Caddy schreibt seine Logs nach stderr
  const logs = spawnSync('docker', ['logs', NAME], { encoding: 'utf8' })
  const caddyLog = `${logs.stdout}\n${logs.stderr}`
  const views = countPageViews(caddyLog, { hosts: [MELDE], sinceMs: since })
  check(views >= 3, `Aufrufe im Report-Only aus Caddys Log gezählt: ${views}`)
  let limited = 0
  for (let i = 0; i < 70; i++) if (post(REPORT, ['--data', '{}']).status === 429) limited++
  check(limited >= 5, `Ratenlimit greift: ${limited} von 70 Meldungen mit 429`)

  sh('docker', ['exec', NAME, 'caddy', 'reload', '--config', '/t/without.json', '--address', 'unix//run/caddy/admin.sock'])
  const plain = viaProbe(APP)
  check(!plain.headers['x-content-type-options'] && !plain.headers['x-frame-options'], 'Regeln entfernt: Header fehlen wieder')
  const again = checkHeaders({ url: `http://${APP}/`, status: plain.status, headers: plain.headers, body: plain.body, isHttps: false }).map((f) => f.title)
  check(again.includes('X-Content-Type-Options: nosniff fehlt'), 'Header-Check meldet den Befund wieder')
} finally {
  try {
    sh('docker', ['rm', '-f', NAME])
  } catch {
    /* schon weg */
  }
  rmSync(dir, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} Prüfung(en) gescheitert` : '\nAlle Prüfungen bestanden')
process.exit(failures ? 1 : 0)

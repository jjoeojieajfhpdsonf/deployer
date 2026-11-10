/**
 * M8, Etappe 1: Security-Header über echtes Caddy (Image aus caddy/Dockerfile)
 * in einem Wegwerf-Container. Kein deployer, keine Datenbank: geprüft wird
 * die Konfiguration aus buildCaddyConfig.
 *
 *   pnpm --filter @deployer/api exec tsx scripts/caddy-headers-e2e.ts
 *
 * - Besucher-Server mit IP-Filter: Absender ausserhalb der Netze -> 403
 * - Probe-Socket: dieselbe Route ohne Filter -> 200, mit den ergänzten Headern
 * - Setzt die App einen Header selbst, bleibt ihr Wert
 * - Statische Seite (file_server) bekommt die Header ebenso
 * - Der eigene Header-Check (checkHeaders) meldet danach nur noch, was fehlt
 * - Regel entfernt: Header fehlt wieder
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCaddyConfig, type RouteSpec } from '../src/drivers/caddy-config.js'
import { checkHeaders } from '../src/security/headers.js'
import { HEADER_DEFAULT } from '@deployer/shared'

const NAME = 'deployer-caddy-headers-e2e'
const IMAGE = 'deployer-caddy-test:e2e'
const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`)
  if (!ok) failures++
}

const APP = 'solar.int.example.test'
const SITE = 'seite.int.example.test'
const REPORT = 'https://deployer.int.example.test/api/v1/csp-reports/abcdefghijklmnopqrstuvwx'

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
    { hosts: [APP], kind: 'proxy', upstream: '127.0.0.1:8081', cidrs: ['10.254.0.0/16'], headers: rules, reportUri: REPORT },
    { hosts: [SITE], kind: 'files', root: '/srv/site', cidrs: ['10.254.0.0/16'], headers: rules, reportUri: REPORT },
  ]
  const cfg = buildCaddyConfig(routes, {
    ipFilter: true, cidrs: ['10.254.0.0/16'], adminSocket: '/run/caddy/admin.sock', probeSocket: '/run/caddy/probe.sock',
  }) as { apps: { http: { servers: Record<string, unknown> } } }
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

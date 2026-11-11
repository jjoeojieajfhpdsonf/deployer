/**
 * CSP-Fix: Funktionsprüfung gegen echtes Chromium (zenika/alpine-chrome, wie
 * im Stack) und echtes Caddy, in einem Wegwerf-Netz. Caddy liefert die
 * Fixture-Seite (Inline-Script, Inline-Style, externe Quellen) und dient dem
 * Browser zugleich als Proxy – im Stack übernimmt das der Proxy in Airlock.
 *
 *   pnpm --filter @airlock/api exec tsx scripts/csp-browser-e2e.ts
 *
 * - scharfe «default-src 'self'» (der Fall hallo-welt): Verstösse gefunden
 * - Regel mit 'unsafe-inline' und den externen Quellen: kein Verstoss
 * - Report-Only: kein Verstoss (Report-Only blockiert nichts)
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { CHROME_SCRIPT, parseChromeCsp } from '../src/security/csp-analysis.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const NET = 'airlock-csp-e2e'
const SITE = 'airlock-csp-e2e-site'
const HOST = 'hallo-welt.e2e.test'
const sh = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`)
  if (!ok) failures++
}

const fixture = readFileSync(resolve(here, '../src/security/fixtures/csp-inline.html'), 'utf8')
const config = (header: string, policy: string) => JSON.stringify({
  apps: { http: { servers: { s: {
    listen: [':80'], automatic_https: { disable: true },
    routes: [{ match: [{ host: [HOST] }], handle: [
      { handler: 'headers', response: { set: { [header]: [policy] } } },
      { handler: 'static_response', status_code: 200, headers: { 'Content-Type': ['text/html; charset=utf-8'] }, body: fixture },
    ] }],
  } } } },
})

function run(header: string, policy: string) {
  writeFileSync(join(dir, 'c.json'), config(header, policy))
  sh(['exec', SITE, 'caddy', 'reload', '--config', '/t/c.json'])
  const out = sh([
    'run', '--rm', '--network', NET, '--entrypoint', 'sh',
    '-e', `CHECK_URLS=http://${HOST}/`, '-e', `CHECK_PROXY=http://${SITE}:80`,
    'zenika/alpine-chrome:124', '-c', `${CHROME_SCRIPT}; cat /tmp/chrome.log`,
  ])
  return parseChromeCsp(out)
}

const dir = mkdtempSync(join(tmpdir(), 'csp-e2e-'))
try {
  try { sh(['rm', '-f', SITE]) } catch { /* nicht da */ }
  try { sh(['network', 'create', NET]) } catch { /* schon da */ }
  writeFileSync(join(dir, 'c.json'), config('X-Test', 'leer'))
  sh(['run', '-d', '--name', SITE, '--network', NET, '-v', `${dir}:/t:ro`, 'caddy:2-alpine', 'caddy', 'run', '--config', '/t/c.json'])
  sh(['exec', SITE, 'sh', '-c', 'for i in $(seq 1 20); do wget -q -O /dev/null --header "Host: hallo-welt.e2e.test" http://127.0.0.1/ && exit 0; sleep 0.3; done; exit 1'])

  const strict = run('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'")
  check(strict.pages.length === 1, `Seite geladen: ${strict.pages.join(', ')}`)
  check(strict.violations.some((v) => v.startsWith('Inline-Skript')), 'scharfe CSP: Inline-Skript blockiert erkannt')
  check(strict.violations.some((v) => v.startsWith('Inline-Style')), 'scharfe CSP: Inline-Style blockiert erkannt')
  check(strict.violations.some((v) => v.includes('cdn.jsdelivr.net')), 'scharfe CSP: externes Skript blockiert erkannt')
  console.log(`  ${strict.violations.join('\n  ')}`)

  const loose = run('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.example.com; img-src 'self' data: https://cdn.example.net")
  check(loose.violations.length === 0, `passende CSP: keine Verstösse (${loose.violations.join('; ') || '–'})`)

  const ro = run('Content-Security-Policy-Report-Only', "default-src 'self'")
  check(ro.violations.length === 0, 'Report-Only: zählt nicht als Verstoss')
} finally {
  try { sh(['rm', '-f', SITE]) } catch { /* weg */ }
  try { sh(['network', 'rm', NET]) } catch { /* weg */ }
  rmSync(dir, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} Prüfung(en) gescheitert` : '\nAlle Prüfungen bestanden')
process.exit(failures ? 1 : 0)

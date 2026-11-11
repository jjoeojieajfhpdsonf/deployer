/**
 * M9, Etappe 3: zwei interne Basen gegen echtes Caddy (Image aus
 * caddy/Dockerfile, caddy-dns/cloudflare).
 *
 *   pnpm --filter @airlock/api exec tsx scripts/m9-caddy-two-bases-e2e.ts
 *
 * Basis A (Umgebung «jherren»): gültiges produktives Wildcard im Speicher,
 * Token-Datei cloudflare_token. Basis B (zweite Umgebung): eigene
 * Token-Datei mit einem FALSCHEN Token, keine Zertifikate. Erwartet laut
 * docs/MILESTONE-9.md: Caddy lädt die Konfiguration, liefert A weiter mit
 * seinem Zertifikat aus, während B scheitert – auch nach erneutem Laden und
 * nach einem Probelauf von B. Danach bekommt B ein Zertifikat; beide laufen.
 *
 * B nutzt die Staging-CA: der fehlschlagende Bezug erzeugt keinen Auftrag
 * bei der Produktions-CA von Let's Encrypt.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildCaddyConfig, type TlsOptions, type RouteSpec } from '../src/drivers/caddy-config.js'
import { certDir, CA_DIR_PRODUCTION, CA_DIR_STAGING } from '../src/lib/caddy-storage.js'
import { probeCert, isStagingIssuer } from '../src/lib/cert.js'
import { caddyAcceptsCloudflareToken } from '../src/lib/cf-token-format.js'

const A = 'int.a.test'
const B = 'int.b.test'
const PORT = 18445
const NAME = 'airlock-caddy-m9-e2e'
const IMAGE = 'airlock-caddy-test:e2e'
const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
let failures = 0
let total = 0
const check = (ok: boolean, what: string) => {
  total++
  console.log(`${ok ? '✓' : '✗'} ${what}`)
  if (!ok) failures++
}

function writeCert(root: string, caDir: string, name: string, org: string, cn: string): void {
  const dir = certDir(root, caDir, name)
  mkdirSync(dir, { recursive: true })
  const file = name.replace(/^\*\./, 'wildcard_.')
  sh('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '89', '-subj', `/O=${org}/CN=${cn}`,
    '-addext', `subjectAltName=DNS:${name}`, '-keyout', join(dir, `${file}.key`), '-out', join(dir, `${file}.crt`)])
  writeFileSync(join(dir, `${file}.json`), JSON.stringify({ sans: [name], issuer_data: {} }))
}

const routes: RouteSpec[] = [
  { hosts: [`foto.${A}`], kind: 'files', root: '/srv' },
  { hosts: [`kasse.${B}`], kind: 'files', root: '/srv' },
]
const build = (tls: TlsOptions[]) => buildCaddyConfig(routes, { ipFilter: false, cidrs: [], adminSocket: '/run/caddy/admin.sock', tls })

const tlsA: TlsOptions = { baseDomain: A, acmeCa: 'production', mode: 'wildcard', email: null, tokenFile: '/t/cloudflare_token', redirect: true }
const tlsB = (o: Partial<TlsOptions> = {}): TlsOptions => ({ baseDomain: B, acmeCa: 'staging', mode: 'wildcard', email: null, tokenFile: '/t/cloudflare_token_b', redirect: false, ...o })

const served = async (sni: string) => {
  await new Promise((r) => setTimeout(r, 1500))
  return probeCert('127.0.0.1', PORT, sni, 3000)
}
const load = (dir: string, cfg: unknown, file: string) => {
  writeFileSync(join(dir, file), JSON.stringify(cfg))
  sh('docker', ['exec', NAME, 'caddy', 'reload', '--config', `/t/${file}`, '--address', 'unix//run/caddy/admin.sock'])
}
const aIsOk = (c: Awaited<ReturnType<typeof probeCert>>) => Boolean(c.validTo) && /YE2/.test(c.issuer ?? '') && !isStagingIssuer(c.issuer)

sh('docker', ['build', '-q', '-t', IMAGE, join(repo, 'caddy')])
const work = mkdtempSync(join(tmpdir(), 'caddy-m9-'))
const t = join(work, 't')
const data = join(work, 'data')
mkdirSync(t)
const TOKEN_A = 'cfut_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb3dEf6hIj9kLm2nOp5q'
// Im Format gültig, aber falsch (kein Konto kennt es): Caddy lädt, Cloudflare lehnt ab
const TOKEN_B_WRONG = 'cfut_FalschFalschFalschFalschFalschFalsch0000'
writeFileSync(join(t, 'cloudflare_token'), TOKEN_A)
writeCert(data, CA_DIR_PRODUCTION, `*.${A}`, "Let's Encrypt", 'YE2')

const start = async (file: string): Promise<boolean> => {
  try { sh('docker', ['rm', '-f', NAME]) } catch { /* lief nicht */ }
  sh('docker', ['run', '-d', '--name', NAME, '-p', `127.0.0.1:${PORT}:443`, '--tmpfs', '/run/caddy',
    '-v', `${t}:/t:ro`, '-v', `${data}:/data`, '--entrypoint', 'caddy', IMAGE, 'run', '--config', `/t/${file}`])
  await new Promise((r) => setTimeout(r, 3000))
  return sh('docker', ['inspect', '-f', '{{.State.Running}}', NAME]).trim() === 'true'
}

try {
  // --- 0: Gegenprobe – ein Token, das Caddy ablehnt, reisst alle Basen mit -----------
  console.log('\n0 – Gegenprobe: Token im falschen Format in B')
  writeFileSync(join(t, 'cloudflare_token_b'), 'falsch')
  writeFileSync(join(t, 'malformed.json'), JSON.stringify(build([tlsA, tlsB()])))
  const loadedMalformed = await start('malformed.json')
  const why = execFileSync('sh', ['-c', `docker logs ${NAME} 2>&1`], { encoding: 'utf8' })
  check(!loadedMalformed && /appears invalid/.test(why), 'ohne Filter: Caddy lädt die ganze Konfiguration nicht (auch A nicht) – «API token … appears invalid»')
  check(!caddyAcceptsCloudflareToken('falsch') && caddyAcceptsCloudflareToken(TOKEN_A) && caddyAcceptsCloudflareToken(TOKEN_B_WRONG), 'Airlock erkennt das Format wie Caddy (caddyAcceptsCloudflareToken)')
  const filtered = [tlsA, tlsB()].filter((x) => caddyAcceptsCloudflareToken(x.baseDomain === B ? 'falsch' : TOKEN_A))
  writeFileSync(join(t, 'filtered.json'), JSON.stringify(build(filtered)))
  const loadedFiltered = await start('filtered.json')
  const a0 = loadedFiltered ? await served(`foto.${A}`) : { validTo: null, issuer: null, error: 'Caddy läuft nicht' }
  check(loadedFiltered && aIsOk(a0 as never), `mit Filter von Airlock (Basis B weggelassen): Caddy lädt, A läuft (${(a0 as { issuer: string | null }).issuer ?? (a0 as { error?: string }).error})`)

  // --- 1: beide Basen, B mit falschem Token (gültiges Format) ------------------------
  console.log('\n1 – A mit gültigem Zertifikat, B mit falschem Token (Format gültig)')
  writeFileSync(join(t, 'cloudflare_token_b'), TOKEN_B_WRONG)
  const both = build([tlsA, tlsB()])
  writeFileSync(join(t, 'both.json'), JSON.stringify(both))
  const running = await start('both.json')
  check(running, 'Caddy startet mit beiden Regeln (eigene Token-Datei je Basis)')
  if (!running) {
    console.log(execFileSync('sh', ['-c', `docker logs ${NAME} 2>&1`], { encoding: 'utf8' }).slice(-3000))
    throw new Error('Caddy läuft nicht')
  }
  const a1 = await served(`foto.${A}`)
  check(aIsOk(a1), `A: Caddy liefert das produktive Zertifikat aus (${a1.issuer ?? a1.error})`)

  // B versucht zu beziehen und scheitert; A bleibt
  await new Promise((r) => setTimeout(r, 15_000))
  // Caddy schreibt sein Log auf stderr
  const logs = execFileSync('sh', ['-c', `docker logs ${NAME} 2>&1`], { encoding: 'utf8' })
  const bLines = logs.split('\n').filter((l) => l.includes(B))
  const bError = bLines.some((l) => /"level":"error"|could not get certificate|obtaining certificate|failed|error/i.test(l))
  check(bError, `B: Bezug scheitert und steht im Caddy-Log (${bLines.length} Zeilen zu ${B})`)
  check(!logs.split('\n').some((l) => l.includes(`*.${A}`) && /"level":"error"/.test(l)), 'A: kein Fehler zu *.' + A + ' im Log')
  const b1 = await served(`kasse.${B}`)
  check(!b1.validTo || isStagingIssuer(b1.issuer) === false && !/YE2/.test(b1.issuer ?? ''), `B: kein Zertifikat ausgeliefert (${b1.error ?? b1.issuer})`)
  const a2 = await served(`foto.${A}`)
  check(aIsOk(a2), `A: nach dem gescheiterten Bezug von B weiter ausgeliefert (${a2.issuer ?? a2.error})`)

  // --- 2: Neu laden (Abgleich von Airlock) und Probelauf von B ------------------------
  console.log('\n2 – Neu laden, B im Probelauf (acme-probe, Staging), weiter mit falschem Token')
  load(t, build([tlsA, tlsB({ mode: 'probe' })]), 'probe.json')
  await new Promise((r) => setTimeout(r, 8000))
  const a3 = await served(`foto.${A}`)
  check(aIsOk(a3), `A: unberührt vom Probelauf in B (${a3.issuer ?? a3.error})`)
  load(t, build([tlsA, tlsB({ mode: 'none' })]), 'none.json')
  const a4 = await served(`foto.${A}`)
  check(aIsOk(a4), `A: unberührt, wenn B gar nichts verwaltet (${a4.issuer ?? a4.error})`)

  // --- 3: B bekommt ein Zertifikat ------------------------------------------------------
  console.log('\n3 – B mit Zertifikat (Staging-CA im Speicher)')
  writeCert(data, CA_DIR_STAGING, `*.${B}`, "(STAGING) Let's Encrypt", '(STAGING) Ersatz Edamame E1')
  load(t, build([tlsA, tlsB()]), 'both2.json')
  const b2 = await served(`kasse.${B}`)
  check(Boolean(b2.validTo) && isStagingIssuer(b2.issuer), `B: Caddy liefert jetzt das Zertifikat von B aus (${b2.issuer ?? b2.error})`)
  const a5 = await served(`foto.${A}`)
  check(aIsOk(a5), `A: weiter das eigene Zertifikat (${a5.issuer ?? a5.error})`)
} finally {
  try { sh('docker', ['rm', '-f', NAME]) } catch { /* schon weg */ }
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${total - failures} von ${total} Prüfungen gegen echtes Caddy bestanden`)
process.exit(failures ? 1 : 0)

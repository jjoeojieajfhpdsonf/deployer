/**
 * Zertifikats-Einrichtung gegen echtes Caddy (Image aus caddy/Dockerfile,
 * caddy-dns/cloudflare v0.2.4). Kein Netz zu Let's Encrypt: alle Zertifikate
 * liegen schon im Speicher (selbst signiert, mit den Ausstellern der echten
 * CAs), Caddy lädt sie und bestellt nichts.
 *
 *   pnpm --filter @deployer/api exec tsx scripts/caddy-tls-e2e.ts
 *
 * A – Zustand vom Server: Phase failed, Konfiguration (autosave) verwaltet
 *     *.<basis> mit Staging-CA, Cache und Speicher halten ein Staging-Wildcard,
 *     im Speicher liegt zusätzlich ein gültiges produktives. Erwartet: deployer
 *     erkennt das produktive im Speicher, baut die Produktions-CA, leert den
 *     Cache per Zwischenschritt – Caddy liefert das produktive aus.
 * B – Ablauf: Probelauf (acme-probe.<basis>, Staging) → Produktion → Caddy
 *     liefert das produktive Wildcard aus, ohne Neustart von Hand.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildCaddyConfig, needsCacheEvict, withoutCertificates, probeName, ACME_STAGING } from '../src/drivers/caddy-config.js'
import { tlsOptionsFor } from '../src/lib/tls-options.js'
import { storedProductionWildcard, removeStagingWildcard, certDir, CA_DIR_PRODUCTION, CA_DIR_STAGING } from '../src/lib/caddy-storage.js'
import { probeCert, checkIssuedCert, isStagingIssuer } from '../src/lib/cert.js'

const BASE = 'int.example.test'
const WILDCARD = `*.${BASE}`
const PORT = 18444
const NAME = 'deployer-caddy-e2e'
const IMAGE = 'deployer-caddy-test:e2e'
const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
let failures = 0
const check = (ok: boolean, what: string) => {
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

const build = (tls: ReturnType<typeof tlsOptionsFor>) =>
  buildCaddyConfig([], { ipFilter: false, cidrs: [], adminSocket: '/run/caddy/admin.sock', tls, trustedProxies: [] })

const opts = (phase: 'staging' | 'production' | 'failed', prodUsable: boolean, tokenFile: string) =>
  tlsOptionsFor({ phase, ca: 'staging' }, { baseDomain: BASE, hasToken: true, tokenFile, email: null, prodUsable })

/** Wie domain/routes.ts: bei CA-Wechsel erst ohne Zertifikate laden, dann die Konfiguration */
function apply(dir: string, current: unknown, next: Record<string, unknown>, label: string): unknown {
  if (needsCacheEvict(current, next, BASE)) {
    writeFileSync(join(dir, 'evict.json'), JSON.stringify(withoutCertificates(next)))
    sh('docker', ['exec', NAME, 'caddy', 'reload', '--config', '/t/evict.json', '--address', 'unix//run/caddy/admin.sock'])
    console.log(`  · ${label}: Cache geleert (Zwischenschritt ohne Zertifikate)`)
  }
  writeFileSync(join(dir, 'next.json'), JSON.stringify(next))
  sh('docker', ['exec', NAME, 'caddy', 'reload', '--config', '/t/next.json', '--address', 'unix//run/caddy/admin.sock'])
  return next
}

const served = async (sni: string) => {
  await new Promise((r) => setTimeout(r, 1500))
  return probeCert('127.0.0.1', PORT, sni, 3000)
}

async function startCaddy(dir: string, data: string, configFile: string): Promise<void> {
  try { sh('docker', ['rm', '-f', NAME]) } catch { /* lief nicht */ }
  sh('docker', ['run', '-d', '--name', NAME, '-p', `127.0.0.1:${PORT}:443`, '--tmpfs', '/run/caddy',
    '-v', `${dir}:/t:ro`, '-v', `${data}:/data`, '--entrypoint', 'caddy', IMAGE, 'run', '--config', `/t/${configFile}`])
  await new Promise((r) => setTimeout(r, 2500))
}

sh('docker', ['build', '-q', '-t', IMAGE, join(repo, 'caddy')])
const work = mkdtempSync(join(tmpdir(), 'caddy-e2e-'))
const t = join(work, 't')
mkdirSync(t)
writeFileSync(join(t, 'token'), 'cfut_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb3dEf6hIj9kLm2nOp5q')
const tokenFile = '/t/token'

try {
  // --- A: Zustand vom Server ------------------------------------------------
  console.log('\nA – failed, Staging-Wildcard in Konfiguration/Cache/Speicher, produktives im Speicher')
  const dataA = join(work, 'data-a')
  writeCert(dataA, CA_DIR_STAGING, WILDCARD, "(STAGING) Let's Encrypt", '(STAGING) Baloney Bulgur YE2')
  writeCert(dataA, CA_DIR_PRODUCTION, WILDCARD, "Let's Encrypt", 'YE2')
  // Alte Konfiguration in «failed»: Wildcard mit Staging-CA (wie autosave.json auf dem Server)
  const legacy = build(opts('production', false, tokenFile)) as { apps: { tls: { automation: { policies: { issuers: { ca: string }[] }[] } } } }
  legacy.apps.tls.automation.policies[0]!.issuers[0]!.ca = ACME_STAGING
  writeFileSync(join(t, 'legacy.json'), JSON.stringify(legacy))
  await startCaddy(t, dataA, 'legacy.json')
  const before = await served(`deployer.${BASE}`)
  check(isStagingIssuer(before.issuer), `vorher: Caddy liefert Staging aus (${before.issuer})`)

  const inStorage = storedProductionWildcard(dataA, BASE)
  check(Boolean(inStorage), `deployer erkennt das produktive Wildcard im Speicher (${inStorage?.issuer}, bis ${inStorage?.validTo.slice(0, 10)})`)
  const next = build(opts('failed', Boolean(inStorage), tokenFile))
  check(JSON.stringify(next).includes('acme-v02.api.letsencrypt.org') && !JSON.stringify(next).includes('acme-staging'), 'Konfiguration in «failed» zeigt die Produktions-CA')
  check(removeStagingWildcard(dataA, BASE), 'Staging-Wildcard aus dem Speicher entfernt')
  // Gegenprobe (die Ursache): ohne Zwischenschritt behält Caddy das gecachte Staging-Wildcard
  writeFileSync(join(t, 'direct.json'), JSON.stringify(next))
  sh('docker', ['exec', NAME, 'caddy', 'reload', '--config', '/t/direct.json', '--address', 'unix//run/caddy/admin.sock'])
  const direct = await served(`deployer.${BASE}`)
  check(isStagingIssuer(direct.issuer), `Gegenprobe: nur neu geladen (Produktions-CA) liefert Caddy weiter das gecachte Staging aus (${direct.issuer})`)
  apply(t, legacy, next, 'A')
  const after = await served(`deployer.${BASE}`)
  check(!isStagingIssuer(after.issuer) && /Let's Encrypt – YE2/.test(after.issuer ?? ''), `nachher: Caddy liefert das produktive aus (${after.issuer}) – ohne Neustart`)

  // --- B: Ablauf Probelauf → Produktion ---------------------------------------
  console.log('\nB – Probelauf (acme-probe) → Produktion')
  const dataB = join(work, 'data-b')
  writeCert(dataB, CA_DIR_STAGING, probeName(BASE), "(STAGING) Let's Encrypt", '(STAGING) Ersatz Edamame E1')
  writeCert(dataB, CA_DIR_PRODUCTION, WILDCARD, "Let's Encrypt", 'YE2')
  // Ein Staging-Wildcard aus einem alten Lauf liegt auch noch dort
  writeCert(dataB, CA_DIR_STAGING, WILDCARD, "(STAGING) Let's Encrypt", '(STAGING) Baloney Bulgur YE2')
  const staging = build(opts('staging', false, tokenFile))
  writeFileSync(join(t, 'staging.json'), JSON.stringify(staging))
  await startCaddy(t, dataB, 'staging.json')
  check(!JSON.stringify(staging).includes(WILDCARD.replace('*', '\\*')) && JSON.stringify((staging as { apps: { tls: unknown } }).apps.tls).includes(probeName(BASE)) && !JSON.stringify((staging as { apps: { tls: unknown } }).apps.tls).includes(`"${WILDCARD}"`), 'Probelauf verwaltet nur acme-probe, keine Wildcard')
  const probe = await served(probeName(BASE))
  check(checkIssuedCert(probe, { base: BASE, phase: 'staging', name: probeName(BASE) }).ready, `Probelauf: Caddy liefert das Staging-Zertifikat für ${probeName(BASE)} aus (${probe.issuer})`)
  const wildDuringProbe = await served(`deployer.${BASE}`)
  check(!wildDuringProbe.validTo || !isStagingIssuer(wildDuringProbe.issuer), `während des Probelaufs kein Staging-Wildcard im Cache (${wildDuringProbe.issuer ?? wildDuringProbe.error})`)

  const production = build(opts('production', false, tokenFile))
  apply(t, staging, production, 'B')
  const prod = await served(`deployer.${BASE}`)
  check(/Let's Encrypt – YE2/.test(prod.issuer ?? '') && !isStagingIssuer(prod.issuer), `Produktion: Caddy liefert das produktive Wildcard aus (${prod.issuer}) – ohne Neustart`)
} finally {
  try { sh('docker', ['rm', '-f', NAME]) } catch { /* schon weg */ }
  rmSync(work, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen gegen echtes Caddy bestanden')
process.exit(failures ? 1 : 0)

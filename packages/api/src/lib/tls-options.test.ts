import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CfTlsPhase } from '@airlock/shared'
import { tlsOptionsFor, planForPhase, type StoredTls } from './tls-options.js'
import { storedProductionWildcard, removeStagingWildcard, certDir, CA_DIR_PRODUCTION, CA_DIR_STAGING } from './caddy-storage.js'
import { buildCaddyConfig, ACME_STAGING, ACME_PRODUCTION, needsCacheEvict, withoutCertificates, caForSubject, probeName } from '../drivers/caddy-config.js'

/**
 * Stellt den Ablauf der Zertifikats-Einrichtung nach (runTls): jede Phase
 * schreibt den Stand, danach baut Airlock die Caddy-Konfiguration neu.
 * Gegen echtes Caddy geprüft: scripts/caddy-tls-e2e.ts.
 */

const BASE = 'int.example.ch'
const WILDCARD = `*.${BASE}`
const PROBE = probeName(BASE)
const TOKEN_FILE = '/run/caddy-secrets/cloudflare_token'

type Policy = { subjects: string[]; issuers: { module: string; ca?: string; challenges: { dns: { provider: { name: string; api_token: string } } } }[] }
type Cfg = {
  apps: {
    http: { servers: Record<string, { listen: string[]; tls_connection_policies?: unknown[]; routes: { handle: { status_code?: number }[] }[] }> }
    tls?: { certificates: { automate: string[] }; automation?: { policies: Policy[] } }
  }
}

function rebuild(tls: StoredTls | undefined, prodUsable = false): Cfg {
  const opts = tlsOptionsFor(tls, { baseDomain: BASE, hasToken: true, tokenFile: TOKEN_FILE, email: null, prodUsable })
  return buildCaddyConfig([], { ipFilter: true, cidrs: ['192.168.1.0/24'], adminSocket: '/run/caddy/admin.sock', tls: opts, trustedProxies: [] }) as unknown as Cfg
}

/** :443 mit TLS-Policy, genau ein verwalteter Name mit genau einem ACME-Issuer und ausdrücklicher CA */
function assertManages(cfg: Cfg, subject: string, ca: 'staging' | 'production', when: string): void {
  const https = Object.values(cfg.apps.http.servers).find((s) => s.listen.includes(':443'))
  assert.ok(https?.tls_connection_policies?.length, `${when}: kein :443 mit TLS-Policy`)
  assert.deepEqual(cfg.apps.tls?.certificates.automate, [subject], `${when}: verwaltet nicht genau ${subject}`)
  const policies = cfg.apps.tls!.automation!.policies
  assert.equal(policies.length, 1, `${when}: mehr als eine Policy`)
  assert.deepEqual(policies[0]!.subjects, [subject])
  assert.equal(policies[0]!.issuers.length, 1, `${when}: mehr als ein Issuer`)
  assert.equal(policies[0]!.issuers[0]!.ca, ca === 'staging' ? ACME_STAGING : ACME_PRODUCTION, `${when}: falsche CA`)
  assert.equal(policies[0]!.issuers[0]!.challenges.dns.provider.api_token, `{file.${TOKEN_FILE}}`)
  assert.ok(!JSON.stringify(cfg).includes('zerossl'), `${when}: ZeroSSL in der Konfiguration`)
}

const hasRedirect = (cfg: Cfg) => cfg.apps.http.servers.srv0!.routes.some((r) => r.handle.some((h) => h.status_code === 308))

describe('Phasen: was Caddy verwaltet', () => {
  test('Probelauf verwaltet nur acme-probe.<basis> bei Staging – nie ein Staging-Wildcard', () => {
    assertManages(rebuild({ phase: 'staging', ca: 'staging' }), PROBE, 'staging', 'staging')
    assert.ok(!JSON.stringify(rebuild({ phase: 'staging', ca: 'staging' }).apps.tls).includes(WILDCARD))
  })

  test('Ablauf staging → production → done: danach nur noch die Wildcard mit Produktions-CA', () => {
    const steps: { phase: CfTlsPhase; subject: string; ca: 'staging' | 'production' }[] = [
      { phase: 'staging', subject: PROBE, ca: 'staging' },
      { phase: 'production', subject: WILDCARD, ca: 'production' },
      { phase: 'production', subject: WILDCARD, ca: 'production' },
      { phase: 'done', subject: WILDCARD, ca: 'production' },
    ]
    for (const [i, s] of steps.entries()) {
      const cfg = rebuild({ phase: s.phase, ca: s.ca })
      assertManages(cfg, s.subject, s.ca, `Neubau ${i + 1} (${s.phase})`)
      assert.equal(hasRedirect(cfg), s.phase === 'done')
    }
  })

  test('failed ohne produktives Zertifikat: nur der Probe-Name bei Staging (bestellt nichts produktiv)', () => {
    assertManages(rebuild({ phase: 'failed', ca: 'production' }), PROBE, 'staging', 'failed')
  })

  test('gültiges produktives Zertifikat bekannt: JEDE Phase verwaltet die Wildcard mit Produktions-CA', () => {
    for (const phase of ['staging', 'production', 'done', 'failed'] as const) {
      assertManages(rebuild({ phase, ca: 'staging' }, true), WILDCARD, 'production', `${phase} mit Zertifikat`)
      assert.deepEqual(planForPhase(phase, true), { mode: 'wildcard', ca: 'production' })
    }
  })

  test('nur «off», fehlende Basisdomain oder fehlendes Token bauen ohne TLS', () => {
    assert.equal(rebuild({ phase: 'off', ca: 'staging' }).apps.tls, undefined)
    assert.equal(tlsOptionsFor({ phase: 'staging', ca: 'staging' }, { baseDomain: null, hasToken: true, tokenFile: TOKEN_FILE, email: null }), null)
    assert.equal(tlsOptionsFor({ phase: 'staging', ca: 'staging' }, { baseDomain: BASE, hasToken: false, tokenFile: TOKEN_FILE, email: null }), null)
  })

  test('ohne gespeicherten Stand: alte Einrichtung über .env', () => {
    const o = tlsOptionsFor(undefined, { baseDomain: BASE, hasToken: false, tokenFile: TOKEN_FILE, email: null, legacy: { enabled: true, acmeCa: 'production', email: 'a@b.ch' } })
    assert.deepEqual(o, { baseDomain: BASE, acmeCa: 'production', email: 'a@b.ch', tokenFile: null, redirect: true })
  })
})

describe('Caddys Cache beim CA-Wechsel leeren', () => {
  const oldStagingWildcard = rebuild({ phase: 'staging', ca: 'staging' }, false)
  // So sah die Konfiguration vor dieser Änderung in «failed» aus: Wildcard mit Staging-CA
  const legacyFailed = structuredClone(rebuild({ phase: 'production', ca: 'production' }))
  legacyFailed.apps.tls!.automation!.policies[0]!.issuers[0]!.ca = ACME_STAGING

  test('Wildcard Staging → Wildcard Produktion: leeren', () => {
    const next = rebuild({ phase: 'failed', ca: 'staging' }, true)
    assert.equal(caForSubject(legacyFailed, WILDCARD), ACME_STAGING)
    assert.equal(caForSubject(next, WILDCARD), ACME_PRODUCTION)
    assert.equal(needsCacheEvict(legacyFailed, next, BASE), true)
  })

  test('Probe → Wildcard: nicht nötig (die Wildcard war nicht verwaltet, also nicht im Cache)', () => {
    assert.equal(needsCacheEvict(oldStagingWildcard, rebuild({ phase: 'production', ca: 'production' }), BASE), false)
  })

  test('gleiche CA, keine Konfiguration, keine Basisdomain: nicht nötig', () => {
    const prod = rebuild({ phase: 'done', ca: 'production' })
    assert.equal(needsCacheEvict(prod, prod, BASE), false)
    assert.equal(needsCacheEvict(null, prod, BASE), false)
    assert.equal(needsCacheEvict(legacyFailed, prod, null), false)
  })

  test('Zwischenschritt behält :443 und Routen, verwaltet aber nichts', () => {
    const next = rebuild({ phase: 'failed', ca: 'staging' }, true)
    const evict = withoutCertificates(next as unknown as Record<string, unknown>) as unknown as Cfg
    assert.deepEqual(evict.apps.tls, { certificates: { automate: [] } })
    assert.deepEqual(evict.apps.http, next.apps.http)
    assert.equal(caForSubject(evict, WILDCARD), null)
    assert.ok(next.apps.tls!.automation, 'Original unverändert')
  })
})

describe('Caddy-Speicher: produktives Wildcard erkennen, Staging aufräumen', () => {
  const hasOpenssl = (() => { try { execFileSync('openssl', ['version']); return true } catch { return false } })()

  function writeCert(root: string, caDir: string, name: string, org: string, days: number, san = name): void {
    const dir = certDir(root, caDir, name)
    mkdirSync(dir, { recursive: true })
    const base = name.replace(/^\*\./, 'wildcard_.')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', String(days), '-subj', `/O=${org}/CN=${org} YE2`,
      '-addext', `subjectAltName=DNS:${san}`, '-keyout', join(dir, `${base}.key`), '-out', join(dir, `${base}.crt`)], { stdio: 'ignore' })
    writeFileSync(join(dir, `${base}.json`), '{}')
  }

  test('Speicher mit produktivem und Staging-Wildcard, Phase failed → Konfiguration zeigt Produktion', (t) => {
    if (!hasOpenssl) return t.skip('openssl fehlt')
    const root = mkdtempSync(join(tmpdir(), 'caddy-data-'))
    try {
      writeCert(root, CA_DIR_PRODUCTION, WILDCARD, "Let's Encrypt", 89)
      writeCert(root, CA_DIR_STAGING, WILDCARD, "(STAGING) Let's Encrypt", 89)
      const found = storedProductionWildcard(root, BASE)
      assert.ok(found, 'produktives Wildcard erkannt')
      assert.match(found.issuer ?? '', /Let's Encrypt/)
      assert.deepEqual(found.sans, [WILDCARD])
      assertManages(rebuild({ phase: 'failed', ca: 'staging' }, Boolean(found)), WILDCARD, 'production', 'failed mit Zertifikat im Speicher')

      assert.equal(removeStagingWildcard(root, BASE), true)
      assert.equal(existsSync(certDir(root, CA_DIR_STAGING, WILDCARD)), false)
      assert.equal(existsSync(certDir(root, CA_DIR_PRODUCTION, WILDCARD)), true, 'produktives bleibt')
      assert.equal(removeStagingWildcard(root, BASE), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('nicht als vorhanden gewertet: Staging-Aussteller, falscher Name, bald abgelaufen, fehlt', (t) => {
    if (!hasOpenssl) return t.skip('openssl fehlt')
    const root = mkdtempSync(join(tmpdir(), 'caddy-data-'))
    try {
      assert.equal(storedProductionWildcard(root, BASE), null, 'leer')
      writeCert(root, CA_DIR_PRODUCTION, WILDCARD, "(STAGING) Let's Encrypt", 89)
      assert.equal(storedProductionWildcard(root, BASE), null, 'Staging unter Produktion')
      writeCert(root, CA_DIR_PRODUCTION, WILDCARD, "Let's Encrypt", 89, '*.anders.ch')
      assert.equal(storedProductionWildcard(root, BASE), null, 'falscher Name')
      writeCert(root, CA_DIR_PRODUCTION, WILDCARD, "Let's Encrypt", 3)
      assert.equal(storedProductionWildcard(root, BASE), null, 'weniger als 7 Tage')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

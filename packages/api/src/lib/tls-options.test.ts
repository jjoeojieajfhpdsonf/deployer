import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { CfTlsPhase } from '@deployer/shared'
import { tlsOptionsFor, caFor, type StoredTls } from './tls-options.js'
import { buildCaddyConfig, ACME_STAGING, ACME_PRODUCTION } from '../drivers/caddy-config.js'

/**
 * Stellt den Ablauf der Zertifikats-Einrichtung nach (runTls): jede Phase
 * schreibt den Stand, danach baut deployer die Caddy-Konfiguration neu.
 * Nach JEDEM Neubau muss :443 mit TLS-Policy und Wildcard-Automation da sein.
 */

const BASE = 'int.example.ch'
const WILDCARD = `*.${BASE}`
const TOKEN_FILE = '/run/caddy-secrets/cloudflare_token'

type Cfg = {
  apps: {
    http: { servers: Record<string, { listen: string[]; tls_connection_policies?: unknown[]; routes: { handle: { status_code?: number }[] }[] }> }
    tls?: { certificates: { automate: string[] }; automation: { policies: { subjects: string[]; issuers: { module: string; ca?: string; challenges: { dns: { provider: { name: string; api_token: string } } } }[] }[] } }
  }
}

function rebuild(tls: StoredTls | undefined, prodUsable = false): Cfg {
  const opts = tlsOptionsFor(tls, { baseDomain: BASE, hasToken: true, tokenFile: TOKEN_FILE, email: null, prodUsable })
  return buildCaddyConfig([], {
    ipFilter: true,
    cidrs: ['192.168.1.0/24', '100.64.0.0/10'],
    adminSocket: '/run/caddy/admin.sock',
    tls: opts,
    trustedProxies: [],
  }) as unknown as Cfg
}

function assertTls(cfg: Cfg, ca: 'staging' | 'production', when: string): void {
  const https = Object.values(cfg.apps.http.servers).find((s) => s.listen.includes(':443'))
  assert.ok(https, `${when}: kein Server auf :443`)
  assert.ok(https.tls_connection_policies?.length, `${when}: :443 ohne TLS-Policy`)
  assert.ok(cfg.apps.tls, `${when}: TLS-App fehlt`)
  assert.deepEqual(cfg.apps.tls.certificates.automate, [WILDCARD], `${when}: Wildcard nicht automatisiert`)
  const policy = cfg.apps.tls.automation.policies[0]!
  assert.deepEqual(policy.subjects, [WILDCARD], `${when}: Policy nicht für die Wildcard`)
  const issuer = policy.issuers[0]!
  assert.equal(issuer.module, 'acme')
  assert.equal(issuer.challenges.dns.provider.name, 'cloudflare')
  assert.equal(issuer.challenges.dns.provider.api_token, `{file.${TOKEN_FILE}}`, `${when}: Token nicht als Datei-Platzhalter`)
  // Jede Phase setzt die CA ausdrücklich; genau ein Issuer, kein ZeroSSL-Rückfall
  assert.equal(policy.issuers.length, 1, `${when}: mehr als ein Issuer`)
  assert.ok(!JSON.stringify(cfg).includes('zerossl'), `${when}: ZeroSSL in der Konfiguration`)
  assert.equal(issuer.ca, ca === 'staging' ? ACME_STAGING : ACME_PRODUCTION, `${when}: falsche CA`)
  assert.equal(cfg.apps.tls.automation.policies.length, 1, `${when}: mehr als eine Policy`)
}

const hasRedirect = (cfg: Cfg) =>
  cfg.apps.http.servers.srv0!.routes.some((r) => r.handle.some((h) => h.status_code === 308))

describe('Zertifikats-Einrichtung: jeder Neubau behält :443 und die Wildcard-Policy', () => {
  test('Ablauf off → staging → production → done', () => {
    // Vor dem Start: kein TLS
    assert.equal(rebuild({ phase: 'off', ca: 'staging' }).apps.tls, undefined)

    const steps: { phase: CfTlsPhase; ca: 'staging' | 'production' }[] = [
      { phase: 'staging', ca: 'staging' }, // startTls / setPhase('staging') → reloadCaddy(true)
      { phase: 'staging', ca: 'staging' }, // Neubau durch anderen Abgleich (Deploy, Netz, Polling)
      { phase: 'production', ca: 'production' }, // Phasenwechsel → reloadCaddy(true)
      { phase: 'production', ca: 'production' }, // weiterer Abgleich während des Wartens
      { phase: 'done', ca: 'production' }, // fertig → reloadCaddy()
    ]
    for (const [i, s] of steps.entries()) {
      const cfg = rebuild(s)
      assertTls(cfg, s.ca, `Neubau ${i + 1} (${s.phase})`)
      assert.equal(hasRedirect(cfg), s.phase === 'done', `Neubau ${i + 1}: Weiterleitung auf https nur in «done»`)
    }
  })

  test('Fehlschlag: :443 bleibt; Produktions-CA nur mit gültigem produktivem Zertifikat (sonst bestellt Caddy im Hintergrund nach)', () => {
    assertTls(rebuild({ phase: 'failed', ca: 'staging' }), 'staging', 'failed nach staging')
    // Früher: ca aus dem gespeicherten Feld → Caddy bestellte nach dem Fehlschlag weiter produktiv
    assertTls(rebuild({ phase: 'failed', ca: 'production' }), 'staging', 'failed nach production, kein Zertifikat')
    assertTls(rebuild({ phase: 'failed', ca: 'production' }, true), 'production', 'failed, gültiges Zertifikat vorhanden')
    assert.equal(hasRedirect(rebuild({ phase: 'failed', ca: 'production' }, true)), false)
  })

  test('die CA hängt nur an der Phase, nicht am gespeicherten Feld', () => {
    // Ein «staging» mit ca=production (alter Stand) bestellt trotzdem bei Staging
    assertTls(rebuild({ phase: 'staging', ca: 'production' }), 'staging', 'staging mit altem ca-Feld')
    assertTls(rebuild({ phase: 'done', ca: 'staging' }), 'production', 'done mit altem ca-Feld')
    assert.equal(caFor('production', false), 'production')
    assert.equal(caFor('staging', true), 'staging')
  })

  test('nur «off», fehlende Basisdomain oder fehlendes Token bauen ohne TLS', () => {
    assert.equal(tlsOptionsFor({ phase: 'off', ca: 'production' }, { baseDomain: BASE, hasToken: true, tokenFile: TOKEN_FILE, email: null }), null)
    assert.equal(tlsOptionsFor({ phase: 'staging', ca: 'staging' }, { baseDomain: null, hasToken: true, tokenFile: TOKEN_FILE, email: null }), null)
    assert.equal(tlsOptionsFor({ phase: 'staging', ca: 'staging' }, { baseDomain: BASE, hasToken: false, tokenFile: TOKEN_FILE, email: null }), null)
  })

  test('ohne gespeicherten Stand: alte Einrichtung über .env', () => {
    const o = tlsOptionsFor(undefined, { baseDomain: BASE, hasToken: false, tokenFile: TOKEN_FILE, email: null, legacy: { enabled: true, acmeCa: 'production', email: 'a@b.ch' } })
    assert.deepEqual(o, { baseDomain: BASE, acmeCa: 'production', email: 'a@b.ch', tokenFile: null, redirect: true })
    assert.equal(tlsOptionsFor(undefined, { baseDomain: BASE, hasToken: false, tokenFile: TOKEN_FILE, email: null }), null)
  })
})

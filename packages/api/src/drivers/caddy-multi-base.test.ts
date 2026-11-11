import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildCaddyConfig, needsCacheEvict, ACME_STAGING, ACME_PRODUCTION, probeName, type RouteSpec, type CaddyBuildOptions, type TlsOptions } from './caddy-config.js'

/** M9: eine interne Basis je Umgebung, jede mit eigener Regel, eigener CA und eigener Token-Datei. */

const A: TlsOptions = { baseDomain: 'int.jherren.com', acmeCa: 'production', mode: 'wildcard', email: 'a@example.ch', tokenFile: '/run/caddy-secrets/cloudflare_token', redirect: true }
const B: TlsOptions = { baseDomain: 'int.verein-beispiel.ch', acmeCa: 'staging', mode: 'probe', email: null, tokenFile: '/run/caddy-secrets/cloudflare_token_b', redirect: false }

const opts: CaddyBuildOptions = { ipFilter: true, cidrs: ['192.168.1.0/24', '100.64.0.0/10'], adminSocket: '/run/caddy/admin.sock', probeSocket: '/run/caddy/probe.sock' }
const hsts = { header: 'strict-transport-security' as const, value: 'max-age=300', mode: 'enforce' as const }
const routes: RouteSpec[] = [
  { hosts: ['foto.int.jherren.com', 'foto.100-88-41-12.nip.io'], kind: 'proxy', upstream: 'air_foto_1:80', headers: [hsts] },
  { hosts: ['kasse.int.verein-beispiel.ch', 'kasse.100-88-41-12.nip.io'], kind: 'proxy', upstream: 'air_kasse_1:80', headers: [hsts] },
  { hosts: ['alt.int.jherren.com'], kind: 'redirect', redirectTo: 'https://neu.int.verein-beispiel.ch', cidrs: ['192.168.1.0/24', '100.64.0.0/10'] },
]

type Cfg = any
const build = (tls: TlsOptions[] | TlsOptions | null): Cfg => buildCaddyConfig(routes, { ...opts, tls })
const hostsOf = (rs: { match?: { host: string[] }[] }[]) => rs.flatMap((r) => r.match?.[0]?.host ?? [])
const has = (handlers: { handler: string; response?: { set?: Record<string, unknown> } }[], name: string) =>
  JSON.stringify(handlers).includes(name)

describe('Caddy mit zwei internen Basen', () => {
  const c = build([A, B])
  const policies = c.apps.tls.automation.policies as { subjects: string[]; issuers: { ca: string; challenges: { dns: { provider: { api_token: string } } } }[] }[]

  test('eine Automatisierungsregel je Basis, mit eigener CA und eigener Token-Datei', () => {
    assert.deepEqual(c.apps.tls.certificates.automate, ['*.int.jherren.com', probeName('int.verein-beispiel.ch')])
    assert.equal(policies.length, 2)
    const a = policies.find((p) => p.subjects[0] === '*.int.jherren.com')!
    const b = policies.find((p) => p.subjects[0] === probeName('int.verein-beispiel.ch'))!
    assert.equal(a.issuers[0]!.ca, ACME_PRODUCTION)
    assert.equal(b.issuers[0]!.ca, ACME_STAGING)
    assert.equal(a.issuers[0]!.challenges.dns.provider.api_token, '{file./run/caddy-secrets/cloudflare_token}')
    assert.equal(b.issuers[0]!.challenges.dns.provider.api_token, '{file./run/caddy-secrets/cloudflare_token_b}')
  })

  test('Namen beider Basen auf :443, nip.io auf :80', () => {
    const tls = hostsOf(c.apps.http.servers.srv1.routes)
    const plain = hostsOf(c.apps.http.servers.srv0.routes)
    assert.ok(tls.includes('foto.int.jherren.com'))
    assert.ok(tls.includes('kasse.int.verein-beispiel.ch'))
    assert.ok(plain.includes('foto.100-88-41-12.nip.io') && plain.includes('kasse.100-88-41-12.nip.io'))
    assert.ok(!tls.some((h) => h.endsWith('nip.io')))
  })

  test('http → https nur für die Basis mit echtem Zertifikat', () => {
    const redirects = (c.apps.http.servers.srv0.routes as { match?: { host: string[] }[]; handle: { status_code?: number }[] }[])
      .filter((r) => r.handle[0]?.status_code === 308 && r.match?.[0]?.host[0]?.startsWith('*.'))
    assert.deepEqual(redirects.map((r) => r.match![0]!.host[0]), ['*.int.jherren.com'])
  })

  test('HSTS je Basis: nur unter der Basis mit Produktions-Wildcard', () => {
    const tlsRoutes = c.apps.http.servers.srv1.routes as { match?: { host: string[] }[]; handle: never[] }[]
    const foto = tlsRoutes.find((r) => r.match?.[0]?.host.includes('foto.int.jherren.com'))!
    const kasse = tlsRoutes.find((r) => r.match?.[0]?.host.includes('kasse.int.verein-beispiel.ch'))!
    assert.equal(has(foto.handle, 'Strict-Transport-Security'), true)
    assert.equal(has(kasse.handle, 'Strict-Transport-Security'), false)
  })

  test('Weiterleitung nach dem Verschieben: 308 auf die neue Adresse, Pfad bleibt, nur aus den internen Netzen', () => {
    const r = (c.apps.http.servers.srv1.routes as { match?: { host: string[]; remote_ip?: { ranges: string[] } }[]; handle: { handler: string; status_code?: number; headers?: { Location: string[] } }[] }[])
      .find((x) => x.match?.[0]?.host.includes('alt.int.jherren.com'))!
    assert.equal(r.handle[0]!.status_code, 308)
    assert.deepEqual(r.handle[0]!.headers!.Location, ['https://neu.int.verein-beispiel.ch{http.request.uri}'])
    assert.deepEqual(r.match![0]!.remote_ip!.ranges, ['192.168.1.0/24', '100.64.0.0/10'])
  })

  test('eine Basis im Modus «none» verwaltet nichts – die andere bleibt', () => {
    const n = build([A, { ...B, mode: 'none' }])
    assert.deepEqual(n.apps.tls.certificates.automate, ['*.int.jherren.com'])
    assert.equal(n.apps.tls.automation.policies.length, 1)
  })

  test('Cache leeren nur für die Basis, deren CA wechselt', () => {
    const before = build([A, B])
    const after = build([A, { ...B, mode: 'wildcard', acmeCa: 'production' }])
    // B verwaltete vorher nur den Probe-Namen, nicht *.<basis>: nichts zu leeren
    assert.equal(needsCacheEvict(before, after, 'int.verein-beispiel.ch'), false)
    assert.equal(needsCacheEvict(before, after, 'int.jherren.com'), false)
    const staged = build([{ ...A, acmeCa: 'staging' }, B])
    assert.equal(needsCacheEvict(staged, before, 'int.jherren.com'), true)
    assert.equal(needsCacheEvict(staged, before, 'int.verein-beispiel.ch'), false)
  })

  test('eine einzelne Basis (Objekt statt Liste) baut wie vor M9', () => {
    assert.deepEqual(build(A).apps.tls, build([A]).apps.tls)
  })
})

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildCaddyConfig, coveredByWildcard, CF_TOKEN_PLACEHOLDER, ACME_STAGING, ACME_PRODUCTION, type RouteSpec, type CaddyBuildOptions } from './caddy-config.js'

/** M4: Konfigurationsbau mit HTTPS (Wildcard per DNS-01 bei Cloudflare). */

const base: CaddyBuildOptions = {
  ipFilter: true,
  cidrs: ['192.168.1.0/24', '100.64.0.0/10'],
  adminSocket: '/run/caddy/admin.sock',
  tls: { baseDomain: 'int.example.ch', acmeCa: 'production', email: null },
}

const routes: RouteSpec[] = [
  { hosts: ['deployer.int.example.ch', 'deployer.192-168-1-10.nip.io'], kind: 'proxy', upstream: 'deployer-app:3000', noKeepAlive: true },
  { hosts: ['solar.int.example.ch', 'solar.192-168-1-10.nip.io'], kind: 'proxy', upstream: 'dep_solar_abc:8080' },
  { hosts: ['seite.int.example.ch', 'seite.192-168-1-10.nip.io'], kind: 'files', root: '/srv/sites/seite/current' },
]

type R = { match?: { host: string[]; remote_ip?: { ranges: string[] } }[]; handle: Record<string, any>[] }
const cfg = (o: Partial<CaddyBuildOptions> = {}) => buildCaddyConfig(routes, { ...base, ...o }) as any
const hostsOf = (rs: R[]) => rs.flatMap((r) => r.match?.[0]?.host ?? [])

describe('coveredByWildcard', () => {
  test('genau eine Ebene unter der Basisdomain', () => {
    assert.equal(coveredByWildcard('solar.int.example.ch', 'int.example.ch'), true)
    assert.equal(coveredByWildcard('SOLAR.int.example.ch', 'int.example.ch'), true)
    assert.equal(coveredByWildcard('a.b.int.example.ch', 'int.example.ch'), false)
    assert.equal(coveredByWildcard('int.example.ch', 'int.example.ch'), false)
    assert.equal(coveredByWildcard('solar.192-168-1-10.nip.io', 'int.example.ch'), false)
    assert.equal(coveredByWildcard('evilint.example.ch', 'int.example.ch'), false)
  })
})

describe('Caddy mit TLS', () => {
  test('ohne tls bleibt alles wie bisher: nur srv0, keine TLS-App', () => {
    const c = cfg({ tls: null })
    assert.deepEqual(Object.keys(c.apps.http.servers), ['srv0'])
    assert.equal(c.apps.tls, undefined)
    assert.ok(hostsOf(c.apps.http.servers.srv0.routes).includes('solar.int.example.ch'))
  })

  test(':443 bedient die Namen unter der Basisdomain, :80 nur nip.io und die Weiterleitung', () => {
    const c = cfg()
    const srv0 = c.apps.http.servers.srv0
    const srv1 = c.apps.http.servers.srv1
    assert.deepEqual(srv1.listen, [':443'])
    assert.deepEqual(hostsOf(srv1.routes).sort(), ['deployer.int.example.ch', 'seite.int.example.ch', 'solar.int.example.ch'])
    const plain = hostsOf(srv0.routes)
    assert.ok(plain.includes('solar.192-168-1-10.nip.io'))
    assert.ok(!plain.includes('solar.int.example.ch'))
    const redirect = srv0.routes.find((r: R) => r.match?.[0]?.host.includes('*.int.example.ch'))
    assert.equal(redirect.handle[0].status_code, 308)
    assert.equal(redirect.handle[0].headers.Location[0], 'https://{http.request.host}{http.request.uri}')
  })

  test('IP-Filter gilt auf beiden Servern, auch für die Weiterleitung', () => {
    const c = cfg()
    for (const srv of ['srv0', 'srv1']) {
      for (const r of c.apps.http.servers[srv].routes as R[]) {
        if (!r.match) continue // Auffangroute
        assert.deepEqual(r.match[0]!.remote_ip?.ranges, base.cidrs, `${srv} ${r.match[0]!.host}`)
      }
    }
  })

  test('beide Server enden mit der Auffangroute ohne Matcher', () => {
    const c = cfg()
    for (const srv of ['srv0', 'srv1']) {
      const rs = c.apps.http.servers[srv].routes as R[]
      assert.equal(rs.at(-1)!.match, undefined)
      assert.equal(rs.at(-1)!.handle[0]!.status_code, 404)
    }
  })

  test('Wildcard-Policy mit DNS-Challenge bei Cloudflare; Token nur als Platzhalter', () => {
    const c = cfg()
    assert.deepEqual(c.apps.tls.certificates.automate, ['*.int.example.ch'])
    const p = c.apps.tls.automation.policies[0]
    assert.deepEqual(p.subjects, ['*.int.example.ch'])
    const issuer = p.issuers[0]
    assert.equal(issuer.module, 'acme')
    // Produktion ausdrücklich, nie Caddys Standard-Issuer (Let's Encrypt + ZeroSSL)
    assert.equal(issuer.ca, ACME_PRODUCTION)
    assert.equal(p.issuers.length, 1)
    assert.equal(issuer.challenges.dns.provider.name, 'cloudflare')
    assert.equal(issuer.challenges.dns.provider.api_token, CF_TOKEN_PLACEHOLDER)
    assert.deepEqual(issuer.challenges.dns.resolvers, ['1.1.1.1', '1.0.0.1'])
    assert.ok(!JSON.stringify(c).includes('cf-'), 'kein echtes Token in der Konfiguration')
  })

  test('Staging-CA und E-Mail', () => {
    const c = cfg({ tls: { baseDomain: 'int.example.ch', acmeCa: 'staging', email: 'joel@example.ch' } })
    const issuer = c.apps.tls.automation.policies[0].issuers[0]
    assert.equal(issuer.ca, ACME_STAGING)
    assert.equal(issuer.email, 'joel@example.ch')
  })

  test('TLS an auf :443, kein automatisches HTTPS, kein HTTP/3', () => {
    const srv1 = cfg().apps.http.servers.srv1
    assert.deepEqual(srv1.tls_connection_policies, [{}])
    assert.deepEqual(srv1.automatic_https, { disable: true })
    assert.deepEqual(srv1.protocols, ['h1', 'h2'])
  })

  test('der admin-Block bleibt der Unix-Socket', () => {
    assert.equal(cfg().admin.listen, 'unix//run/caddy/admin.sock')
  })

  test('Connection: close bleibt auf der deployer-Route (auch auf :443)', () => {
    const srv1 = cfg().apps.http.servers.srv1
    const r = srv1.routes.find((x: R) => x.match?.[0]?.host.includes('deployer.int.example.ch'))
    assert.equal(r.handle[0].handler, 'headers')
  })
})

describe('Quell-Bereiche pro Route (Review M4)', () => {
  test('route.cidrs ersetzt die allgemeinen Bereiche, auf :80 und :443', () => {
    const only = buildCaddyConfig(
      [{ hosts: ['lan.int.example.ch', 'lan.192-168-1-10.nip.io'], kind: 'proxy', upstream: 'x:80', cidrs: ['192.168.1.0/24'] }],
      base,
    ) as any
    for (const srv of ['srv0', 'srv1']) {
      const r = only.apps.http.servers[srv].routes.find((x: R) => x.match?.[0]?.host.some((h) => h.startsWith('lan.')))
      assert.deepEqual(r.match[0].remote_ip.ranges, ['192.168.1.0/24'], srv)
    }
  })
  test('ohne IP-Filter kein remote_ip, auch mit route.cidrs', () => {
    const c = buildCaddyConfig([{ hosts: ['a.int.example.ch'], kind: 'proxy', upstream: 'x:80', cidrs: ['10.0.0.0/8'] }], { ...base, ipFilter: false }) as any
    assert.equal(c.apps.http.servers.srv1.routes[0].match[0].remote_ip, undefined)
  })
})

describe('M5: öffentliche Routen hinter cloudflared', () => {
  const edge = ['172.30.0.0/16']
  test('CF-Connecting-IP nur vom edge-Netz; öffentliche Route nur von dort, über :80', () => {
    const c = buildCaddyConfig(
      [{ hosts: ['solar.example.ch'], kind: 'proxy', upstream: 'dep_solar_1:80', cidrs: edge }],
      { ...base, trustedProxies: edge },
    ) as any
    const srv0 = c.apps.http.servers.srv0
    assert.deepEqual(srv0.trusted_proxies, { source: 'static', ranges: edge })
    assert.deepEqual(srv0.client_ip_headers, ['CF-Connecting-IP'])
    const r = srv0.routes.find((x: R) => x.match?.[0]?.host.includes('solar.example.ch'))
    assert.deepEqual(r.match[0].remote_ip.ranges, edge)
    // nicht unter der internen Basisdomain -> kein :443-Eintrag bei Caddy (TLS macht Cloudflare)
    assert.ok(!hostsOf(c.apps.http.servers.srv1.routes).includes('solar.example.ch'))
  })
  test('ohne trustedProxies kein client_ip_headers (Header vom Client würde sonst geglaubt)', () => {
    const c = buildCaddyConfig([], base) as any
    assert.equal(c.apps.http.servers.srv0.client_ip_headers, undefined)
    assert.equal(c.apps.http.servers.srv0.trusted_proxies, undefined)
  })
})

describe('Token aus der Oberfläche', () => {
  test('Token als Datei: Konfiguration enthält nur den Pfad-Platzhalter, nie das Token', () => {
    const c = cfg({ tls: { baseDomain: 'int.example.ch', acmeCa: 'staging', tokenFile: '/run/caddy-secrets/cloudflare_token' } })
    const issuer = c.apps.tls.automation.policies[0].issuers[0]
    assert.equal(issuer.challenges.dns.provider.api_token, '{file./run/caddy-secrets/cloudflare_token}')
    assert.equal(issuer.ca, ACME_STAGING)
    assert.doesNotMatch(JSON.stringify(c), /cf-test-token|eyJ/)
  })
  test('ohne Datei: alter Platzhalter aus der Umgebung', () => {
    const c = cfg()
    assert.equal(c.apps.tls.automation.policies[0].issuers[0].challenges.dns.provider.api_token, CF_TOKEN_PLACEHOLDER)
  })
  test('während der Einrichtung keine Weiterleitung auf https', () => {
    const c = cfg({ tls: { baseDomain: 'int.example.ch', acmeCa: 'staging', redirect: false } })
    const redirects = c.apps.http.servers.srv0.routes.filter((r: R) => r.handle[0]?.status_code === 308)
    assert.equal(redirects.length, 0)
    assert.ok(c.apps.http.servers.srv1)
  })
})

/**
 * Reiner Konfigurationsbau fuer Caddy. Bewusst OHNE Import von config.ts,
 * damit die Funktion ohne gesetzte Umgebung testbar bleibt.
 */

import { coveredByWildcard } from '../lib/hostnames.js'

export const adminAddress = (socketPath: string) => `unix/${socketPath}`

export interface RouteSpec {
  /** Kanonischer Hostname zuerst, danach Aliase (nip.io). */
  hosts: string[]
  kind: 'proxy' | 'files'
  /** Bei kind=proxy: "container:port" */
  upstream?: string
  /** Bei kind=files: Verzeichnis im sites-Volume */
  root?: string
  /**
   * Keine Keep-Alive-Verbindungen (Connection: close). Für die Route des
   * deployers selbst: MCP antwortet per SSE, die Header gehen also vor einem
   * Deploy hinaus. Lädt der Deploy Caddy neu, schliesst Caddy die
   * Verbindung danach – ohne dass der Client es aus den Headern wüsste. Seine
   * nächste Anfrage über diese Verbindung scheitert dann. Mit
   * Connection: close benutzt er sie gar nicht erst wieder.
   */
  noKeepAlive?: boolean
  /**
   * Erlaubte Quell-Bereiche dieser Route (M4: nach Ziel – nur LAN, nur
   * Tailnet oder beides). Fehlt es, gelten die allgemeinen opts.cidrs.
   */
  cidrs?: string[]
}

export interface CaddyBuildOptions {
  ipFilter: boolean
  /** Erlaubte Quell-Bereiche, wenn ipFilter aktiv ist. */
  cidrs: string[]
  adminSocket: string
  /**
   * M4: HTTPS mit Wildcard-Zertifikat für *.<baseDomain> per DNS-01 bei
   * Cloudflare. null/fehlend = nur HTTP wie in M1-M3, M6.
   */
  tls?: TlsOptions | null
  /**
   * M5: Netz, aus dem cloudflared kommt (deployer_edge). Nur von dort wird
   * die Besucher-IP aus CF-Connecting-IP übernommen (SPEC, wichtig für M7).
   */
  trustedProxies?: string[]
}

export interface TlsOptions {
  baseDomain: string
  acmeCa: 'production' | 'staging'
  email?: string | null
}

/** Platzhalter, den Caddy zur Laufzeit aus seiner Umgebung füllt (Entrypoint liest das Secret). */
export const CF_TOKEN_PLACEHOLDER = '{env.CF_API_TOKEN}'
export const ACME_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory'

export { coveredByWildcard }

type Handler = Record<string, unknown> & { handler: string }
type HttpRoute = {
  /** Fehlt bei der Auffangroute: eine Route ohne Matcher trifft auf alles. */
  match?: HostMatch[]
  handle: Handler[]
  terminal: boolean
}

export type HostMatch = { host: string[]; remote_ip?: { ranges: string[] } }

/**
 * Routen -> vollstaendige Caddy-JSON-Konfiguration.
 *
 * Der admin-Block ist IMMER enthalten. Fehlte er, fiele Caddy beim naechsten
 * /load auf den Standard TCP :2019 zurueck - und waere damit aus jedem
 * Projekt-Netz erreichbar, in das Caddy gehaengt wird. Genau das Loch, das
 * der Unix-Socket schliesst.
 */
export function buildCaddyConfig(
  routes: RouteSpec[],
  opts: CaddyBuildOptions,
): Record<string, unknown> {
  const tls = opts.tls ?? null
  const remote = opts.ipFilter ? { remote_ip: { ranges: opts.cidrs } } : {}
  const remoteFor = (r: RouteSpec) => (opts.ipFilter ? { remote_ip: { ranges: r.cidrs ?? opts.cidrs } } : {})

  const toRoute = (r: RouteSpec, hosts: string[]): HttpRoute => {
    const handle: Handler[] =
      r.kind === 'proxy'
        ? [{ handler: 'reverse_proxy', upstreams: [{ dial: r.upstream }] }]
        : [
            { handler: 'vars', root: r.root },
            { handler: 'file_server', index_names: ['index.html'] },
          ]
    if (r.noKeepAlive) {
      handle.unshift({ handler: 'headers', response: { set: { Connection: ['close'] } } })
    }
    return { match: [{ host: hosts, ...remoteFor(r) }], handle, terminal: true }
  }

  // Ohne TLS: alle Namen auf :80. Mit TLS: Namen unter der Basisdomain auf
  // :443, der Rest (nip.io) bleibt auf :80 - dafür gibt es kein Zertifikat.
  const plainRoutes: HttpRoute[] = []
  const tlsRoutes: HttpRoute[] = []
  for (const r of routes) {
    const secure = tls ? r.hosts.filter((h) => coveredByWildcard(h, tls.baseDomain)) : []
    const plain = r.hosts.filter((h) => !secure.includes(h))
    if (plain.length) plainRoutes.push(toRoute(r, plain))
    if (secure.length) tlsRoutes.push(toRoute(r, secure))
  }

  if (tls) {
    // Wer einen internen Namen über HTTP anfragt, landet auf HTTPS. Eigene
    // Weiterleitung statt Caddys automatischer: die erfasste auch nip.io.
    plainRoutes.push({
      match: [{ host: [`*.${tls.baseDomain}`], ...remote }],
      handle: [{
        handler: 'static_response',
        status_code: 308,
        headers: { Location: ['https://{http.request.host}{http.request.uri}'] },
      }],
      terminal: true,
    })
  }

  // Auffangroute: Wer den IP-Filter nicht passiert oder einen unbekannten
  // Hostnamen anfragt, bekommt eine klare Antwort statt irgendeiner anderen.
  // Bewusst OHNE Matcher – ein host-Matcher "*" trifft in Caddy nicht auf
  // alles, die Anfrage fiele dann auf eine leere 200 durch.
  const catchAll: HttpRoute = {
    handle: [
      {
        handler: 'static_response',
        status_code: 404,
        body: 'Kein Projekt unter diesem Namen, oder Zugriff nicht aus LAN/Tailnet.',
      },
    ],
    terminal: true,
  }

  const servers: Record<string, unknown> = {
    srv0: {
      listen: [':80'],
      routes: [...plainRoutes, catchAll],
      // Kein automatisches HTTPS auf :80; Zertifikate kommen (ab M4) nur
      // über die ausdrückliche Wildcard-Policy unten.
      automatic_https: { disable: true },
      ...(opts.trustedProxies?.length
        ? { trusted_proxies: { source: 'static', ranges: opts.trustedProxies }, client_ip_headers: ['CF-Connecting-IP'] }
        : {}),
    },
  }
  const apps: Record<string, unknown> = { http: { servers } }

  if (tls) {
    const wildcard = `*.${tls.baseDomain}`
    servers.srv1 = {
      listen: [':443'],
      routes: [...tlsRoutes, catchAll],
      // Leere Policy = TLS an, Zertifikat nach SNI aus Caddys Cache.
      tls_connection_policies: [{}],
      automatic_https: { disable: true },
      // HTTP/3 bräuchte zusätzlich UDP :443; der IP-Filter ist dafür nicht geprüft.
      protocols: ['h1', 'h2'],
    }
    apps.tls = {
      certificates: { automate: [wildcard] },
      automation: {
        policies: [{
          subjects: [wildcard],
          issuers: [{
            module: 'acme',
            ...(tls.acmeCa === 'staging' ? { ca: ACME_STAGING } : {}),
            ...(tls.email ? { email: tls.email } : {}),
            challenges: {
              dns: {
                provider: { name: 'cloudflare', api_token: CF_TOKEN_PLACEHOLDER },
                // Nicht der lokale DNS: ein Split-Horizon (AdGuard mit *.int)
                // beantwortete die _acme-challenge-Abfrage falsch.
                resolvers: ['1.1.1.1', '1.0.0.1'],
              },
            },
          }],
        }],
      },
    }
  }

  return {
    admin: { listen: adminAddress(opts.adminSocket) },
    logging: { logs: { default: { level: 'INFO' } } },
    apps,
  }
}

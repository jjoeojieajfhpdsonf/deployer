/**
 * Reiner Konfigurationsbau fuer Caddy. Bewusst OHNE Import von config.ts,
 * damit die Funktion ohne gesetzte Umgebung testbar bleibt.
 */

import { coveredByWildcard } from '../lib/hostnames.js'
import { headerHandlers, type HeaderRuleSpec } from '../security/header-rules.js'
import { DEFAULT_PAUSE_PAGE, PAUSE_STATE_HEADER, PAUSE_STATE_VALUE, pauseHeaders, renderPausePage, type PausePage } from '@deployer/shared'

export const adminAddress = (socketPath: string) => `unix/${socketPath}`

export interface RouteSpec {
  /** Kanonischer Hostname zuerst, danach Aliase (nip.io). */
  hosts: string[]
  /** maintenance: öffentlich pausiert – Pause-Seite mit 503 */
  kind: 'proxy' | 'files' | 'maintenance'
  /** Bei kind=maintenance: Seite (Vorlage oder Projekt), «Voraussichtlich zurück», Zeitzone der Anzeige */
  pause?: {
    page: PausePage; backAt: string | null; timeZone?: string
    /** Code-Modus: Ordner mit index.html im sites-Volume (für Caddy lesbar) */
    root?: string
  }
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
  /** M8: Security-Header, die Caddy ergänzt (nur wenn die App sie nicht setzt). */
  headers?: HeaderRuleSpec[]
  /**
   * M8: Schlüssel der CSP-Regel. Browser melden Verstösse an
   * /.well-known/deployer/csp-report/<schlüssel> am Host des Projekts; Caddy
   * leitet nur diesen Pfad (POST, höchstens 64 KB, Ratenlimit) an deployer.
   */
  cspReportKey?: string | null
}

/** Pfad am Host des Projekts, an den Browser CSP-Verstösse melden. */
export const CSP_REPORT_PREFIX = '/.well-known/deployer/csp-report/'
export const cspReportPath = (key: string) => `${CSP_REPORT_PREFIX}${key}`
/** Grenzen der Weiterleitung an deployer */
export const CSP_REPORT_MAX_BYTES = 64 * 1024
export const CSP_REPORT_RATE = { window: '1m', maxEvents: 60 }

export interface CaddyBuildOptions {
  /** Für Tests: «jetzt» (Retry-After nur mit «Voraussichtlich zurück» in der Zukunft) */
  now?: number
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
  /**
   * Namen, für die Caddy ein Zugriffs-Log schreibt (deployer selbst). Daraus
   * liest die Systemseite die Absenderadressen (lib/client-ips.ts).
   */
  accessLogHosts?: string[]
  /**
   * M8: Unix-Socket für den Probe-Server. Er kennt dieselben Namen und
   * Handler wie die Besucher-Server (inklusive ergänzter Header), aber ohne
   * IP-Filter: der Header-Check des deployers prüft darüber, wie Besucher die
   * Seite sehen. Über das Netz ist ein Unix-Socket nicht erreichbar – der
   * Filter für fremde Absender bleibt, wie er ist.
   */
  probeSocket?: string | null
  /**
   * M8: Wohin Caddy CSP-Meldungen weiterleitet (deployer, «host:port»).
   * Fehlt es, setzt Caddy keine report-uri.
   */
  cspReportUpstream?: string | null
}

/** Name des Probe-Servers in Caddys Konfiguration */
export const PROBE_SERVER = 'probe'

/** Logger-Name des Zugriffs-Logs für deployer (im Log: http.log.access.deployer) */
export const ACCESS_LOGGER = 'deployer'

export interface TlsOptions {
  baseDomain: string
  acmeCa: 'production' | 'staging'
  email?: string | null
  /**
   * Token als Datei im gemeinsamen Volume (eingerichtet über die
   * Oberfläche). Caddy liest sie mit dem Platzhalter {file.<pfad>} beim
   * Laden; in der Konfiguration und in autosave.json steht nur der Pfad.
   * Fehlt er: alter Weg über die Umgebung (compose.tls.yaml).
   */
  tokenFile?: string | null
  /** http -> https für interne Namen. Während der Einrichtung aus, bis das echte Zertifikat da ist. */
  redirect?: boolean
  /**
   * wildcard: *.<basis> verwalten (Standard). probe: nur acme-probe.<basis>
   * (Staging-Probelauf). none: :443 an, nichts verwaltet – leert Caddys Cache
   * für *.<basis>, der ein Neuladen sonst überlebt.
   */
  mode?: 'wildcard' | 'probe' | 'none'
}

/** Eigener Name für den Staging-Probelauf: so liegt nie ein Staging-Wildcard in Caddys Cache. */
export const PROBE_LABEL = 'acme-probe'
export const probeName = (base: string) => `${PROBE_LABEL}.${base}`

type TlsApp = { certificates?: { automate?: string[] }; automation?: { policies?: { subjects?: string[]; issuers?: { ca?: string }[] }[] } }
type BuiltConfig = { apps?: { tls?: TlsApp } }

/** CA, mit der eine geladene Konfiguration den Namen verwaltet (null: verwaltet ihn nicht). */
export function caForSubject(cfg: unknown, subject: string): string | null {
  const tls = (cfg as BuiltConfig | null)?.apps?.tls
  if (!tls?.certificates?.automate?.includes(subject)) return null
  const p = tls.automation?.policies?.find((x) => x.subjects?.includes(subject))
  return p?.issuers?.[0]?.ca ?? 'default'
}

/**
 * Muss Caddys Zertifikats-Cache vor dem Laden von `next` geleert werden?
 * Ja, wenn beide Konfigurationen *.<basis> verwalten, aber mit anderer CA:
 * Caddy behält dann das gecachte Zertifikat der alten CA (der Cache überlebt
 * das Neuladen; geprüft gegen Caddy 2.10, docs/design-cal) und lädt weder aus
 * dem Speicher noch bestellt es neu.
 */
export function needsCacheEvict(current: unknown, next: unknown, baseDomain: string | null): boolean {
  if (!baseDomain) return false
  const w = `*.${baseDomain}`
  const a = caForSubject(current, w)
  const b = caForSubject(next, w)
  return a !== null && b !== null && a !== b
}

/** Dieselbe Konfiguration, aber ohne verwaltete Zertifikate (Zwischenschritt zum Leeren des Caches). */
export function withoutCertificates<T extends Record<string, unknown>>(cfg: T): T {
  const c = structuredClone(cfg) as T & BuiltConfig
  if (c.apps?.tls) c.apps.tls = { certificates: { automate: [] } }
  return c
}

/** Platzhalter, den Caddy zur Laufzeit aus seiner Umgebung füllt (Entrypoint liest das Secret). */
export const CF_TOKEN_PLACEHOLDER = '{env.CF_API_TOKEN}'

/** Platzhalter für das Token aus einer Datei – nie das Token selbst. */
export const tokenPlaceholder = (tls: TlsOptions) => (tls.tokenFile ? `{file.${tls.tokenFile}}` : CF_TOKEN_PLACEHOLDER)
export const ACME_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory'
export const ACME_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory'

export { coveredByWildcard }

type Handler = Record<string, unknown> & { handler: string }

/** Kennung der Wartungsseite; die Prüfung von aussen erkennt daran «pausiert». */
export const MAINTENANCE_HEADER = PAUSE_STATE_HEADER
export const MAINTENANCE_VALUE = PAUSE_STATE_VALUE

/**
 * Pause-Seite für pausierte öffentliche Namen (Renderer in @deployer/shared,
 * derselbe wie die Vorschau): Vorlage oder Text des Projekts, hell und dunkel
 * nach Systemeinstellung. 503, Retry-After nur mit «Voraussichtlich zurück»
 * (als HTTP-Datum), noindex, no-store (Cloudflare liefert sie nach dem
 * Fortsetzen nicht weiter aus), CSP ohne jede Quelle ausser Inline-Styles.
 */
export const MAINTENANCE_HTML = renderPausePage(DEFAULT_PAUSE_PAGE)

/**
 * Formular-Modus: static_response mit dem Renderer (alles escaped, auch
 * geschweifte Klammern). Code-Modus: eigenes HTML als Datei über file_server –
 * static_response ersetzt im Body Platzhalter wie {file.…} oder {env.…};
 * eigenes HTML könnte so Secrets aus Caddy öffentlich machen. file_server
 * liefert die Datei unverändert, mit Status 503.
 */
function maintenanceHandlers(pause: RouteSpec['pause'], now: number): Handler[] {
  const page = pause?.page ?? DEFAULT_PAUSE_PAGE
  if (page.mode === 'code' && pause?.root) {
    return [
      { handler: 'headers', response: { set: pauseHeaders(pause.backAt, now, { contentType: false }) } },
      { handler: 'rewrite', uri: `/${PAUSE_FILE}` },
      { handler: 'file_server', root: pause.root, status_code: 503 },
    ]
  }
  return [{
    handler: 'static_response',
    status_code: 503,
    headers: pauseHeaders(pause?.backAt, now),
    body: renderPausePage({ ...page, mode: 'form' }, { backAt: pause?.backAt, timeZone: pause?.timeZone }),
  }]
}

/** Dateiname der Pause-Seite im Code-Modus (unter <sites>/_pause/<slug>/). */
export const PAUSE_FILE = 'index.html'
type HttpRoute = {
  /** Fehlt bei der Auffangroute: eine Route ohne Matcher trifft auf alles. */
  match?: HostMatch[]
  handle: Handler[]
  terminal: boolean
}

export type HostMatch = { host: string[]; remote_ip?: { ranges: string[] }; path?: string[]; method?: string[] }

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

  // M8: HSTS nur, solange Caddy das Wildcard-Zertifikat der Produktions-CA
  // verwaltet. Fällt TLS zurück (Staging, Probelauf, aus), fällt HSTS mit.
  const hstsAllowed = Boolean(tls && tls.acmeCa === 'production' && (tls.mode ?? 'wildcard') === 'wildcard')

  /**
   * Handler einer Route. secure: Route auf :443 bzw. deren Abbild im
   * Probe-Server. probe: Abbild im Probe-Server – die App bekommt dort
   * X-Forwarded-Proto wie ein Besucher (sonst sähe sie «http» vom Socket).
   */
  const handlersFor = (r: RouteSpec, secure: boolean, probe: boolean): Handler[] => {
    const proxy: Handler = { handler: 'reverse_proxy', upstreams: [{ dial: r.upstream }] }
    if (probe) proxy.headers = { request: { set: { 'X-Forwarded-Proto': [secure ? 'https' : 'http'] } } }
    const handle: Handler[] =
      r.kind === 'maintenance'
        ? maintenanceHandlers(r.pause, opts.now ?? Date.now())
        : r.kind === 'proxy'
        ? [proxy]
        : [
            { handler: 'vars', root: r.root },
            { handler: 'file_server', index_names: ['index.html'] },
          ]
    // report-uri relativ: der Browser meldet an den Host, den er gerade besucht
    const reportUri = r.cspReportKey && opts.cspReportUpstream ? cspReportPath(r.cspReportKey) : null
    if (r.headers?.length) handle.unshift(...headerHandlers(r.headers, { secure, hstsAllowed, reportUri }))
    if (r.noKeepAlive) {
      handle.unshift({ handler: 'headers', response: { set: { Connection: ['close'] } } })
    }
    return handle
  }

  const toRoute = (r: RouteSpec, hosts: string[], secure: boolean): HttpRoute => {
    return { match: [{ host: hosts, ...remoteFor(r) }], handle: handlersFor(r, secure, false), terminal: true }
  }

  /**
   * M8: CSP-Meldungen am Host des Projekts. Nur POST auf genau den Pfad mit
   * dem Schlüssel dieses Projekts; Body höchstens 64 KB, Ratenlimit je
   * Absender, dann an deployer (fester Zielpfad – der Pfad der Anfrage geht
   * nicht durch). Dieselben Absender-Netze wie die Route des Projekts.
   */
  const cspRoute = (r: RouteSpec, hosts: string[]): HttpRoute[] => {
    if (!r.cspReportKey || !opts.cspReportUpstream || r.kind === 'maintenance') return []
    if (!r.headers?.some((h) => h.header === 'content-security-policy')) return []
    return [{
      match: [{ host: hosts, path: [cspReportPath(r.cspReportKey)], method: ['POST'], ...remoteFor(r) }],
      handle: [
        { handler: 'request_body', max_size: CSP_REPORT_MAX_BYTES },
        {
          handler: 'rate_limit',
          rate_limits: { csp: { key: '{http.request.client_ip}', window: CSP_REPORT_RATE.window, max_events: CSP_REPORT_RATE.maxEvents } },
        },
        { handler: 'rewrite', uri: `/api/v1/csp-reports/${r.cspReportKey}` },
        {
          handler: 'reverse_proxy',
          upstreams: [{ dial: opts.cspReportUpstream }],
          // Nur was deployer braucht; keine Cookies des Projekts an deployer
          headers: { request: { delete: ['Cookie', 'Authorization'] } },
        },
      ],
      terminal: true,
    }]
  }

  // Ohne TLS: alle Namen auf :80. Mit TLS: Namen unter der Basisdomain auf
  // :443, der Rest (nip.io) bleibt auf :80 - dafür gibt es kein Zertifikat.
  const plainRoutes: HttpRoute[] = []
  const tlsRoutes: HttpRoute[] = []
  const probeRoutes: HttpRoute[] = []
  for (const r of routes) {
    const secure = tls ? r.hosts.filter((h) => coveredByWildcard(h, tls.baseDomain)) : []
    const plain = r.hosts.filter((h) => !secure.includes(h))
    if (plain.length) plainRoutes.push(...cspRoute(r, plain), toRoute(r, plain, false))
    if (secure.length) tlsRoutes.push(...cspRoute(r, secure), toRoute(r, secure, true))
    // Probe: je Name so, wie Besucher ihn sehen (HTTPS oder HTTP), ohne IP-Filter.
    if (secure.length) probeRoutes.push({ match: [{ host: secure }], handle: handlersFor(r, true, true), terminal: true })
    if (plain.length) probeRoutes.push({ match: [{ host: plain }], handle: handlersFor(r, false, true), terminal: true })
  }

  if (tls && tls.redirect !== false) {
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

  // Sperrseite in zwei Meldungen: Ein bekannter Name von einer Adresse
  // ausserhalb der freigegebenen Netze bekommt 403 und sieht, welche Adresse
  // Caddy gesehen hat (verrät z. B. eine Maskierung auf ein Docker-Gateway);
  // ein unbekannter Name bekommt 404.
  const forbidden = (hosts: string[]): HttpRoute[] =>
    opts.ipFilter && hosts.length
      ? [{
          match: [{ host: hosts }],
          handle: [{
            handler: 'static_response',
            status_code: 403,
            body: 'Kein Zugriff von {http.request.remote.host} auf {http.request.host}: dieser Name ist nur aus den freigegebenen Netzen erreichbar (LAN, Tailnet oder Cloudflare).',
          }],
          terminal: true,
        }]
      : []
  const plainHosts = [...new Set(plainRoutes.flatMap((r) => r.match?.flatMap((m) => m.host) ?? []))]
  const tlsHosts = [...new Set(tlsRoutes.flatMap((r) => r.match?.flatMap((m) => m.host) ?? []))]

  // Auffangroute: unbekannter Name. Bewusst OHNE Matcher – ein host-Matcher
  // "*" trifft in Caddy nicht auf alles, die Anfrage fiele dann auf eine
  // leere 200 durch.
  const catchAll: HttpRoute = {
    handle: [
      {
        handler: 'static_response',
        status_code: 404,
        body: 'Kein Projekt unter diesem Namen.',
      },
    ],
    terminal: true,
  }

  // Zugriffs-Log nur für deployer selbst: daraus liest die Systemseite, welche
  // Absenderadressen Caddy sieht (Warnung bei Docker-Gateway statt Gerät).
  const accessLog = opts.accessLogHosts?.length
    ? { logs: { logger_names: Object.fromEntries(opts.accessLogHosts.map((h) => [h, [ACCESS_LOGGER]])), skip_unmapped_hosts: true } }
    : {}

  const servers: Record<string, unknown> = {
    srv0: {
      listen: [':80'],
      routes: [...plainRoutes, ...forbidden(plainHosts), catchAll],
      ...accessLog,
      // Kein automatisches HTTPS auf :80; Zertifikate kommen (ab M4) nur
      // über die ausdrückliche Wildcard-Policy unten.
      automatic_https: { disable: true },
      ...(opts.trustedProxies?.length
        ? { trusted_proxies: { source: 'static', ranges: opts.trustedProxies }, client_ip_headers: ['CF-Connecting-IP'] }
        : {}),
    },
  }
  if (opts.probeSocket) {
    servers[PROBE_SERVER] = {
      listen: [`unix/${opts.probeSocket}`],
      routes: [...probeRoutes, catchAll],
      automatic_https: { disable: true },
    }
  }
  const apps: Record<string, unknown> = { http: { servers } }

  if (tls) {
    // Was Caddy verwaltet: das Wildcard-Zertifikat (Produktion), nur den
    // Probe-Namen (Staging-Probelauf; nie ein Staging-Wildcard im Cache) oder
    // nichts (Zwischenschritt, der Caddys Zertifikats-Cache für *.<basis> leert).
    const mode = tls.mode ?? 'wildcard'
    const subject = mode === 'probe' ? probeName(tls.baseDomain) : `*.${tls.baseDomain}`
    servers.srv1 = {
      listen: [':443'],
      routes: [...tlsRoutes, ...forbidden(tlsHosts), catchAll],
      ...accessLog,
      // Leere Policy = TLS an, Zertifikat nach SNI aus Caddys Cache.
      tls_connection_policies: [{}],
      automatic_https: { disable: true },
      // HTTP/3 bräuchte zusätzlich UDP :443; der IP-Filter ist dafür nicht geprüft.
      protocols: ['h1', 'h2'],
    }
    apps.tls = mode === 'none' ? { certificates: { automate: [] } } : {
      certificates: { automate: [subject] },
      automation: {
        policies: [{
          subjects: [subject],
          issuers: [{
            module: 'acme',
            // CA immer ausdrücklich, auch für Produktion: genau ein Issuer
            // (acme) mit fester URL – kein Rückfall auf Caddys Standard-Issuer
            // (Let's Encrypt + ZeroSSL), wenn die Liste leer wäre.
            ca: tls.acmeCa === 'staging' ? ACME_STAGING : ACME_PRODUCTION,
            ...(tls.email ? { email: tls.email } : {}),
            challenges: {
              dns: {
                provider: { name: 'cloudflare', api_token: tokenPlaceholder(tls) },
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

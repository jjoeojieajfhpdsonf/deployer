/**
 * Reiner Konfigurationsbau fuer Caddy. Bewusst OHNE Import von config.ts,
 * damit die Funktion ohne gesetzte Umgebung testbar bleibt.
 */

import { coveredByWildcard } from '../lib/hostnames.js'
import { headerHandlers, type HeaderRuleSpec } from '../security/header-rules.js'
import { createHash } from 'node:crypto'
import { GATE_CALLBACK_PATH, GATE_COOKIE, DEFAULT_PAUSE_PAGE, NOT_FOUND_TEXT, PAUSE_STATE_HEADER, PAUSE_STATE_VALUE, pauseHeaders, renderPausePage, renderSnakePage, snakeCsp, type PausePage } from '@airlock/shared'

export const adminAddress = (socketPath: string) => `unix/${socketPath}`

export interface RouteSpec {
  /** Kanonischer Hostname zuerst, danach Aliase (nip.io). */
  hosts: string[]
  /** maintenance: öffentlich pausiert – Pause-Seite mit 503. redirect (M9): 308 auf redirectTo (alte Adresse nach dem Verschieben) */
  kind: 'proxy' | 'files' | 'maintenance' | 'redirect' | 'status'
  /**
   * Etappe 5, kind=status: Ordner der Umgebung im Container airlock-status
   * (upstream). Caddy schreibt den Pfad auf /<ordner>/… um und gibt die
   * Anfrage an den Container – der nur Dateien ausliefert.
   */
  statusDir?: string
  /** Bei kind=redirect: Ziel ohne Pfad, z. B. «https://foto.int.example.ch»; der Pfad der Anfrage wird angehängt */
  redirectTo?: string
  /** Bei kind=maintenance: Seite (Vorlage oder Projekt), «Voraussichtlich zurück», Zeitzone der Anzeige */
  pause?: {
    page: PausePage; backAt: string | null; timeZone?: string
    /** Code-Modus: Ordner mit index.html im sites-Volume (für Caddy lesbar) */
    root?: string
  }
  /** Bei kind=proxy: "container:port" */
  upstream?: string
  /**
   * Bestehender Dienst, Adresse mit https://: Caddy spricht TLS zum Ziel.
   * insecure: eigenes (selbstsigniertes) Zertifikat wird angenommen – nur auf
   * ausdrücklichen Wunsch, nur für Adressen im Heimnetz.
   */
  upstreamTls?: { insecure: boolean }
  /**
   * Zugang «Airlock-Login»: vor jeder Anfrage fragt Caddy Airlock (forward_auth
   * auf gate.upstream, GET /api/v1/gate/check). 2xx: weiter zur App; sonst
   * gibt Caddy Airlocks Antwort weiter (302 zur Anmeldung). Den Cookie setzt
   * Airlock über GATE_CALLBACK_PATH auf diesem Host. Nicht im Probe-Server –
   * Header-Check und Scan sehen die App wie bisher.
   */
  gate?: { upstream: string }
  /** Bei kind=files: Verzeichnis im sites-Volume */
  root?: string
  /**
   * Keine Keep-Alive-Verbindungen (Connection: close). Für die Route des
   * Oberfläche von Airlock: MCP antwortet per SSE, die Header gehen also vor einem
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
   * /.well-known/airlock/csp-report/<schlüssel> am Host des Projekts; Caddy
   * leitet nur diesen Pfad (POST, höchstens 64 KB, Ratenlimit) an Airlock.
   */
  cspReportKey?: string | null
  /**
   * Etappe 3: Aufrufe dieser Route ins Besucher-Log (Logger «visits», Datei
   * im Volume caddy_access). Nur Projekt-Routen – nie die Oberfläche von
   * Airlock oder Weiterleitungen.
   */
  visits?: boolean
}

/** Pfad am Host des Projekts, an den Browser CSP-Verstösse melden. */
export const CSP_REPORT_PREFIX = '/.well-known/airlock/csp-report/'
export const cspReportPath = (key: string) => `${CSP_REPORT_PREFIX}${key}`
/** Grenzen der Weiterleitung an Airlock */
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
   * M9: eine Liste – eine interne Basis pro Umgebung, jede mit eigener
   * Automatisierungsregel (CA, Token-Datei, Modus). Ein Fehler bei einer
   * Basis berührt die anderen nicht.
   */
  tls?: TlsOptions | TlsOptions[] | null
  /**
   * M5: Netz, aus dem cloudflared kommt (airlock_tunnel). Nur von dort wird
   * die Besucher-IP aus CF-Connecting-IP übernommen (SPEC, wichtig für M7).
   */
  trustedProxies?: string[]
  /**
   * Namen, für die Caddy ein Zugriffs-Log schreibt (Airlock selbst). Daraus
   * liest die Systemseite die Absenderadressen (lib/client-ips.ts).
   */
  accessLogHosts?: string[]
  /**
   * M8: Unix-Socket für den Probe-Server. Er kennt dieselben Namen und
   * Handler wie die Besucher-Server (inklusive ergänzter Header), aber ohne
   * IP-Filter: der Header-Check von Airlock prüft darüber, wie Besucher die
   * Seite sehen. Über das Netz ist ein Unix-Socket nicht erreichbar – der
   * Filter für fremde Absender bleibt, wie er ist.
   */
  probeSocket?: string | null
  /**
   * M8: Wohin Caddy CSP-Meldungen weiterleitet (Airlock, «host:port»).
   * Fehlt es, setzt Caddy keine report-uri.
   */
  cspReportUpstream?: string | null
  /**
   * Etappe 3: Ordner im Caddy-Container für das Besucher-Log (JSON, eine
   * Datei mit Rotation). Fehlt er, schreibt Caddy kein Besucher-Log.
   */
  visitsLogDir?: string | null
  /**
   * Etappe 7: Snake auf der Seite «Kein Projekt unter diesem Namen» – nur für
   * unbekannte interne Namen (hosts: Muster wie *.int.<basis> oder
   * *.<lan-ip>.nip.io) von Absendern aus LAN/Tailnet (cidrs, unabhängig vom
   * IP-Filter). Nie über den Tunnel: Absender aus trustedProxies (cloudflared)
   * und Anfragen mit Cloudflare-Kopfzeilen bekommen die schlichte Seite, ebenso
   * der Probe-Server. null/fehlend = aus (Spass-Funktionen aus).
   */
  notFoundGame?: { hosts: string[]; cidrs: string[] } | null
}

/**
 * Etappe 7: Muster der internen Namen aus Beispiel-Adressen einer Umgebung
 * («x.int.example.ch» → «*.int.example.ch»). Platzhalter-Adressen
 * (*.int.invalid) und Doppelte fallen weg.
 */
export function gameHostPatterns(sampleHosts: readonly string[]): string[] {
  const out = sampleHosts
    .map((h) => h.toLowerCase().split('.').slice(1).join('.'))
    .filter((rest) => rest.includes('.') && !rest.endsWith('.invalid'))
    .map((rest) => `*.${rest}`)
  return [...new Set(out)].sort()
}

/** Base64 des SHA-256 (CSP-Hash von Skript und Stil der Snake-Seite) */
const sha256b64 = (text: string) => createHash('sha256').update(text, 'utf8').digest('base64')

/** Kopfzeilen der Snake-Seite: 404, nie im Cache, nie im Index, CSP nur mit Hashes */
export function notFoundGameHeaders(): Record<string, string[]> {
  return {
    'Content-Type': ['text/html; charset=utf-8'],
    'Cache-Control': ['no-store'],
    'X-Robots-Tag': ['noindex'],
    'Content-Security-Policy': [snakeCsp(sha256b64)],
    'X-Content-Type-Options': ['nosniff'],
    'Referrer-Policy': ['no-referrer'],
  }
}

/** Kopfzeilen, an denen eine Anfrage über den Cloudflare-Tunnel zu erkennen ist */
export const TUNNEL_HEADERS = ['Cf-Connecting-Ip', 'Cf-Ray']

/** Name des Probe-Servers in Caddys Konfiguration */
export const PROBE_SERVER = 'probe'

/** Logger-Name des Zugriffs-Logs für Airlock (im Log: http.log.access.airlock) */
export const ACCESS_LOGGER = 'airlock'
/** Logger für Aufrufe von Projekten mit Report-Only-CSP (http.log.access.csp) */
export const CSP_VIEW_LOGGER = 'csp'
/** Logger für Aufrufe statischer Seiten (http.log.access.site), Reiter «Zugriffe» */
export const SITE_LOGGER = 'site'
/**
 * Etappe 3: Logger für die Besucher-Auswertung (http.log.access.visits).
 * Schreibt nicht ins Container-Log, sondern in eine eigene Datei mit kurzer
 * Rotation: sie enthält IP-Adressen, die Airlock nur liest, um Zugang, Stadt
 * und den Besucher-Hash zu berechnen – gespeichert werden nur Zähler.
 */
export const VISITS_LOGGER = 'visits'
export const VISITS_LOG_FILE = 'visits.log'
/** Rotation: 20 MB je Datei, höchstens 2 alte Dateien, höchstens 2 Tage alt */
export const VISITS_LOG_ROLL = { roll_size_mb: 20, roll_keep: 2, roll_keep_days: 2 }
/** Antwort-Header der Sperrseite des IP-Filters: das Besucher-Log erkennt daran «geblockt» */
export const BLOCK_HEADER = 'X-Airlock-Block'

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

/**
 * Entfernt den Login-Cookie aus dem Cookie-Header (vor der App), samt einem
 * folgenden «;». Ersetzt durch GATE_COOKIE_STRIP_REPLACE (das Trennzeichen
 * davor bleibt): «a=1; airlock_gate=x; b=2» → «a=1; b=2». Go-RE2, ohne Lookbehind.
 */
export const GATE_COOKIE_STRIP_RE = `(^|;)\\s*${GATE_COOKIE}=[^;]*;?`
export const GATE_COOKIE_STRIP_REPLACE = '${1}'

/**
 * Zugang «Airlock-Login» wie Caddys `forward_auth`: GET an Airlock mit
 * Methode und Pfad der Anfrage in X-Forwarded-Method/-Uri (X-Forwarded-Host
 * setzt reverse_proxy selbst). 2xx: der Antwort-Zweig schreibt nichts, die
 * Anfrage geht weiter zur App. Sonst gibt Caddy Airlocks Antwort weiter.
 */
export function forwardAuth(upstream: string): Handler {
  return {
    handler: 'reverse_proxy',
    upstreams: [{ dial: upstream }],
    rewrite: { method: 'GET', uri: '/api/v1/gate/check' },
    headers: {
      request: {
        set: { 'X-Forwarded-Method': ['{http.request.method}'], 'X-Forwarded-Uri': ['{http.request.uri}'] },
        // Nur der Login-Cookie zählt; Authorization der App geht Airlock nichts an
        delete: ['Authorization'],
      },
    },
    handle_response: [{
      match: { status_code: [2] },
      routes: [{ handle: [{ handler: 'headers', request: { delete: ['X-Airlock-Gate'] } }] }],
    }],
  }
}

/** Kennung der Wartungsseite; die Prüfung von aussen erkennt daran «pausiert». */
export const MAINTENANCE_HEADER = PAUSE_STATE_HEADER
export const MAINTENANCE_VALUE = PAUSE_STATE_VALUE

/**
 * Pause-Seite für pausierte öffentliche Namen (Renderer in @airlock/shared,
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

/**
 * Etappe 5: Statusseite. Nur GET/HEAD-taugliche Dateien aus dem Ordner der
 * Umgebung; kurze Cache-Zeit (die Seite ändert sich jede Minute), kein
 * Besucher-Log. Die Security-Header setzt handlersFor davor wie bei Projekten.
 */
function statusHandlers(r: RouteSpec, proxy: Handler): Handler[] {
  const dir = (r.statusDir ?? '').replace(/[^a-z0-9-]/g, '')
  return [
    { handler: 'headers', response: { set: { 'Cache-Control': ['public, max-age=30'] } } },
    { handler: 'rewrite', uri: `/${dir}{http.request.uri.path}` },
    proxy,
  ]
}

/** Dateiname der Pause-Seite im Code-Modus (unter <sites>/_pause/<slug>/). */
export const PAUSE_FILE = 'index.html'
type HttpRoute = {
  /** Fehlt bei der Auffangroute: eine Route ohne Matcher trifft auf alles. */
  match?: HostMatch[]
  handle: Handler[]
  terminal: boolean
}

export type HostMatch = {
  host: string[]; remote_ip?: { ranges: string[] }; path?: string[]; method?: string[]
  /** Etappe 7: Ausnahmen (eine trifft → die Route nicht), z. B. Absender aus dem Tunnel */
  not?: Record<string, unknown>[]
}

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
  const tlsList: TlsOptions[] = opts.tls ? [opts.tls].flat() : []
  const remote = opts.ipFilter ? { remote_ip: { ranges: opts.cidrs } } : {}
  const remoteFor = (r: RouteSpec) => (opts.ipFilter ? { remote_ip: { ranges: r.cidrs ?? opts.cidrs } } : {})

  /** Die Basis, deren Wildcard einen Namen abdeckt (null: keine). */
  const tlsFor = (host: string): TlsOptions | null => tlsList.find((t) => coveredByWildcard(host, t.baseDomain)) ?? null

  // M8: HSTS nur, solange Caddy das Wildcard-Zertifikat der Produktions-CA
  // verwaltet. Fällt TLS zurück (Staging, Probelauf, aus), fällt HSTS mit.
  // M9: je Basis – eine Umgebung im Probelauf nimmt den anderen HSTS nicht weg.
  const hstsFor = (t: TlsOptions | null) => Boolean(t && t.acmeCa === 'production' && (t.mode ?? 'wildcard') === 'wildcard')

  /**
   * Handler einer Route. secure: Route auf :443 bzw. deren Abbild im
   * Probe-Server. probe: Abbild im Probe-Server – die App bekommt dort
   * X-Forwarded-Proto wie ein Besucher (sonst sähe sie «http» vom Socket).
   */
  const handlersFor = (r: RouteSpec, secure: boolean, probe: boolean, hstsAllowed = false): Handler[] => {
    const proxy: Handler = { handler: 'reverse_proxy', upstreams: [{ dial: r.upstream }] }
    if (probe) proxy.headers = { request: { set: { 'X-Forwarded-Proto': [secure ? 'https' : 'http'] } } }
    // Bestehender Dienst: HTTPS zum Ziel (eigenes Zertifikat nur ausdrücklich)
    if (r.upstreamTls) proxy.transport = { protocol: 'http', tls: r.upstreamTls.insecure ? { insecure_skip_verify: true } : {} }
    // Der Login-Cookie ist nur für Airlock: nie an die App weitergeben (auch Projekte ohne Login,
    // falls ein Browser ihn von früher noch schickt)
    if (r.kind === 'proxy' && r.visits) proxy.headers = { ...(proxy.headers as object | undefined), request: { ...((proxy.headers as { request?: object } | undefined)?.request ?? {}), replace: { Cookie: [{ search_regexp: GATE_COOKIE_STRIP_RE, replace: GATE_COOKIE_STRIP_REPLACE }] } } }
    if (r.kind === 'redirect') {
      return [{ handler: 'static_response', status_code: 308, headers: { Location: [`${r.redirectTo}{http.request.uri}`] } }]
    }
    const handle: Handler[] =
      r.kind === 'status'
        ? statusHandlers(r, proxy)
        : r.kind === 'maintenance'
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
    // Zugang «Airlock-Login» zuerst: vor Headern und App. Nicht im Probe-Server, nicht auf der Pause-Seite.
    if (r.gate && !probe && (r.kind === 'proxy' || r.kind === 'files')) handle.unshift(forwardAuth(r.gate.upstream))
    return handle
  }

  const toRoute = (r: RouteSpec, hosts: string[], secure: boolean, hsts = false): HttpRoute => {
    return { match: [{ host: hosts, ...remoteFor(r) }], handle: handlersFor(r, secure, false, hsts), terminal: true }
  }

  /**
   * M8: CSP-Meldungen am Host des Projekts. Nur POST auf genau den Pfad mit
   * dem Schlüssel dieses Projekts; Body höchstens 64 KB, Ratenlimit je
   * Absender, dann an Airlock (fester Zielpfad – der Pfad der Anfrage geht
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
          // Nur was Airlock braucht; keine Cookies des Projekts an Airlock
          headers: { request: { delete: ['Cookie', 'Authorization'] } },
        },
      ],
      terminal: true,
    }]
  }

  /**
   * Zugang «Airlock-Login»: Rückruf nach der Anmeldung. Nur GET auf genau
   * GATE_CALLBACK_PATH am Host des Projekts; Caddy schreibt auf
   * /api/v1/gate/callback um (Query bleibt: einmaliger Code und Ziel) und gibt
   * an Airlock – der setzt den Cookie für diesen Host. Ohne Cookies des
   * Projekts an Airlock.
   */
  const gateRoute = (r: RouteSpec, hosts: string[]): HttpRoute[] => {
    if (!r.gate || (r.kind !== 'proxy' && r.kind !== 'files')) return []
    return [{
      match: [{ host: hosts, path: [GATE_CALLBACK_PATH], method: ['GET'], ...remoteFor(r) }],
      handle: [
        { handler: 'rewrite', uri: '/api/v1/gate/callback?{http.request.uri.query}' },
        { handler: 'reverse_proxy', upstreams: [{ dial: r.gate.upstream }], headers: { request: { delete: ['Cookie', 'Authorization'] } } },
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
    const plain = r.hosts.filter((h) => !tlsFor(h))
    if (plain.length) plainRoutes.push(...cspRoute(r, plain), ...gateRoute(r, plain), toRoute(r, plain, false))
    // M9: Namen unter verschiedenen Basen getrennt (HSTS je Basis)
    for (const t of tlsList) {
      const secure = r.hosts.filter((h) => tlsFor(h) === t)
      if (!secure.length) continue
      tlsRoutes.push(...cspRoute(r, secure), ...gateRoute(r, secure), toRoute(r, secure, true, hstsFor(t)))
      // Probe: je Name so, wie Besucher ihn sehen (HTTPS oder HTTP), ohne IP-Filter.
      probeRoutes.push({ match: [{ host: secure }], handle: handlersFor(r, true, true, hstsFor(t)), terminal: true })
    }
    if (plain.length) probeRoutes.push({ match: [{ host: plain }], handle: handlersFor(r, false, true), terminal: true })
  }

  for (const t of tlsList) {
    if (t.redirect === false) continue
    // Wer einen internen Namen über HTTP anfragt, landet auf HTTPS. Eigene
    // Weiterleitung statt Caddys automatischer: die erfasste auch nip.io.
    plainRoutes.push({
      match: [{ host: [`*.${t.baseDomain}`], ...remote }],
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
            // Etappe 3: Kennung «am Eingang gesperrt» für Besucher-Log und Live-Strom
            headers: { [BLOCK_HEADER]: ['ip-filter'] },
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
        body: NOT_FOUND_TEXT,
      },
    ],
    terminal: true,
  }

  // Etappe 7: Snake für unbekannte interne Namen aus LAN/Tailnet – vor der Auffangroute.
  // Der Probe-Server bekommt sie nie (er prüft, wie Besucher von aussen die Seite sehen).
  const game = opts.notFoundGame
  const gameRoutes: HttpRoute[] = game && game.hosts.length && game.cidrs.length
    ? [{
        match: [{
          host: game.hosts,
          remote_ip: { ranges: game.cidrs },
          not: [
            ...(opts.trustedProxies?.length ? [{ remote_ip: { ranges: opts.trustedProxies } }] : []),
            ...TUNNEL_HEADERS.map((h) => ({ header: { [h]: ['*'] } })),
          ],
        }],
        handle: [{ handler: 'static_response', status_code: 404, headers: notFoundGameHeaders(), body: renderSnakePage() }],
        terminal: true,
      }]
    : []

  // Zugriffs-Log nur für Airlock selbst: daraus liest die Systemseite, welche
  // Absenderadressen Caddy sieht (Warnung bei Docker-Gateway statt Gerät).
  // CSP-Fix: dazu die Namen von Projekten, deren CSP im Report-Only läuft.
  // Daraus zählt Airlock die Aufrufe ohne Verstoss, bevor die CSP scharf
  // werden darf. Nur solange Report-Only läuft – danach kein Log mehr.
  const loggerNames: Record<string, string[]> = Object.fromEntries((opts.accessLogHosts ?? []).map((h) => [h, [ACCESS_LOGGER]]))
  for (const r of routes) {
    // Projektseite: statische Seiten zeigen ihr Zugriffs-Log im Reiter «Zugriffe»
    if (r.kind === 'files') for (const h of r.hosts) loggerNames[h] = [...(loggerNames[h] ?? []), SITE_LOGGER]
    // Etappe 3: Besucher-Log für alle Projekt-Routen (eigene Datei, siehe logging unten)
    if (r.visits && opts.visitsLogDir) for (const h of r.hosts) loggerNames[h] = [...(loggerNames[h] ?? []), VISITS_LOGGER]
    if (!r.headers?.some((h) => h.header === 'content-security-policy' && h.mode === 'report-only')) continue
    for (const h of r.hosts) loggerNames[h] = [...(loggerNames[h] ?? []), CSP_VIEW_LOGGER]
  }
  const visitsInUse = Object.values(loggerNames).some((l) => l.includes(VISITS_LOGGER))
  const accessLog = Object.keys(loggerNames).length
    ? { logs: { logger_names: loggerNames, skip_unmapped_hosts: true } }
    : {}

  const servers: Record<string, unknown> = {
    srv0: {
      listen: [':80'],
      routes: [...plainRoutes, ...forbidden(plainHosts), ...gameRoutes, catchAll],
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

  if (tlsList.length) {
    servers.srv1 = {
      listen: [':443'],
      routes: [...tlsRoutes, ...forbidden(tlsHosts), ...gameRoutes, catchAll],
      ...accessLog,
      // Leere Policy = TLS an, Zertifikat nach SNI aus Caddys Cache.
      tls_connection_policies: [{}],
      automatic_https: { disable: true },
      // HTTP/3 bräuchte zusätzlich UDP :443; der IP-Filter ist dafür nicht geprüft.
      protocols: ['h1', 'h2'],
    }
    // Was Caddy je Basis verwaltet: das Wildcard-Zertifikat (Produktion), nur
    // den Probe-Namen (Staging-Probelauf; nie ein Staging-Wildcard im Cache)
    // oder nichts (Zwischenschritt, der Caddys Zertifikats-Cache für
    // *.<basis> leert). M9: eine Regel pro Basis mit eigener CA und eigener
    // Token-Datei – schlägt eine fehl, bleiben die anderen unberührt.
    const managed = tlsList
      .filter((t) => (t.mode ?? 'wildcard') !== 'none')
      .map((t) => ({ t, subject: (t.mode ?? 'wildcard') === 'probe' ? probeName(t.baseDomain) : `*.${t.baseDomain}` }))
    apps.tls = managed.length === 0 ? { certificates: { automate: [] } } : {
      certificates: { automate: managed.map((m) => m.subject) },
      automation: {
        policies: managed.map(({ t, subject }) => ({
          subjects: [subject],
          issuers: [{
            module: 'acme',
            // CA immer ausdrücklich, auch für Produktion: genau ein Issuer
            // (acme) mit fester URL – kein Rückfall auf Caddys Standard-Issuer
            // (Let's Encrypt + ZeroSSL), wenn die Liste leer wäre.
            ca: t.acmeCa === 'staging' ? ACME_STAGING : ACME_PRODUCTION,
            ...(t.email ? { email: t.email } : {}),
            challenges: {
              dns: {
                provider: { name: 'cloudflare', api_token: tokenPlaceholder(t) },
                // Nicht der lokale DNS: ein Split-Horizon (AdGuard mit *.int)
                // beantwortete die _acme-challenge-Abfrage falsch.
                resolvers: ['1.1.1.1', '1.0.0.1'],
              },
            },
          }],
        })),
      },
    }
  }

  return {
    admin: { listen: adminAddress(opts.adminSocket) },
    logging: {
      logs: visitsInUse && opts.visitsLogDir
        ? {
            // Besucher-Zeilen nur in ihre Datei, nicht zusätzlich ins Container-Log
            default: { level: 'INFO', exclude: [`http.log.access.${VISITS_LOGGER}`] },
            [VISITS_LOGGER]: {
              writer: { output: 'file', filename: `${opts.visitsLogDir.replace(/\/+$/, '')}/${VISITS_LOG_FILE}`, mode: '0640', ...VISITS_LOG_ROLL },
              encoder: { format: 'json' },
              include: [`http.log.access.${VISITS_LOGGER}`],
            },
          }
        : { default: { level: 'INFO' } },
    },
    apps,
  }
}

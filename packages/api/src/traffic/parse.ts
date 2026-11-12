/**
 * Eine Zeile aus Caddys Zugriffs-Log (JSON-Encoder, Logger
 * http.log.access.visits, drivers/caddy-config.ts) → die Felder, die die
 * Besucher-Auswertung braucht. Rein: liest nichts selbst. Die IP bleibt nur
 * im Speicher, bis Zugang, Stadt und Besucher-Hash daraus berechnet sind.
 *
 * Caddy schreibt Header in kanonischer Schreibweise («Cf-Ipcountry»,
 * «User-Agent»); Cookie und Authorization stehen dort nur als «REDACTED».
 */

export const VISITS_LOGGER = 'http.log.access.visits'

export interface AccessLine {
  /** Millisekunden */
  at: number
  /** Absender, wie ihn Caddy nach trusted_proxies sieht (hinter dem Tunnel: CF-Connecting-IP) */
  ip: string
  /** Verbindung, wie Caddy sie sieht (hinter dem Tunnel: cloudflared) */
  remoteIp: string
  host: string
  method: string
  /** Pfad ohne Query */
  path: string
  /** Query (nur für utm_source/ref ausgewertet, nie gespeichert) */
  query: string
  status: number
  userAgent: string
  referer: string
  /** CF-IPCountry (nur über den Tunnel aussagekräftig) */
  country: string
  /** Content-Type der Antwort ('' = keiner, z. B. 304) */
  contentType: string
  /** Vom IP-Filter abgewiesen (Antwort trägt X-Airlock-Block, caddy-config.ts) */
  blocked: boolean
  /** Accept-Language (nur die erste Sprache wird ausgewertet) */
  acceptLanguage: string
  /** Client Hints: Sec-CH-UA, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version (nur Familie und Hauptversion) */
  chUa: string
  chPlatform: string
  chPlatformVersion: string
  /** DNT: 1 oder Sec-GPC: 1 – zählt, aber ohne Einstieg/Ausstieg */
  optOut: boolean
  /**
   * Cloudflare «Add visitor location headers» (Managed Transform): Stadt und
   * Region. Koordinaten (cf-iplatitude/-longitude) und PLZ (cf-postal-code)
   * liest Airlock bewusst nicht.
   */
  cfCity: string
  cfRegion: string
  /** Zugriffe neu: «HTTP/2.0» wie von Caddy */
  proto: string
  /** TLS-Version als Zahl (772 = TLS 1.3), 0 ohne TLS */
  tlsVersion: number
  /** Dauer in Millisekunden (Caddy schreibt Sekunden), null ohne Angabe */
  durationMs: number | null
  /** Grösse der Antwort in Byte */
  bytes: number | null
  /** Wert von X-Airlock-Block ('' = keiner) */
  blockValue: string
  /** Pause-Seite (X-Airlock-State: paused, früher X-Deployer-State) */
  paused: boolean
  /** Alle Kopfzeilen der Anfrage, wie Caddy sie loggt (Cookie und Authorization geschwärzt) */
  headers: Headers
}

export type Headers = Record<string, string[] | string | undefined>

export function header(h: Headers | undefined, name: string): string {
  if (!h) return ''
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() !== want) continue
    const s = Array.isArray(v) ? v[0] : v
    return typeof s === 'string' ? s : ''
  }
  return ''
}

/** Wert einer Cloudflare-Kopfzeile: getrimmt, ohne Steuerzeichen, %-Kodierung aufgelöst, höchstens 80 Zeichen */
export function decodeCf(v: string): string {
  let s = v.trim()
  if (/%[0-9a-f]{2}/i.test(s)) {
    try {
      s = decodeURIComponent(s)
    } catch {
      // bleibt wie geliefert
    }
  }
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80)
}

/** null: keine Zeile des Besucher-Loggers oder unlesbar */
export function parseAccessLine(line: string, logger = VISITS_LOGGER): AccessLine | null {
  const l = line.trim()
  if (!l.startsWith('{') || !l.includes(logger)) return null
  let j: {
    ts?: number; logger?: string; status?: number; duration?: number; size?: number
    request?: {
      remote_ip?: string; client_ip?: string; host?: string; method?: string; uri?: string; headers?: Headers
      proto?: string; tls?: { version?: number }
    }
    resp_headers?: Headers
  }
  try {
    j = JSON.parse(l)
  } catch {
    return null
  }
  if (j.logger !== logger || !j.request) return null
  const r = j.request
  const ip = r.client_ip || r.remote_ip
  if (!ip || typeof j.ts !== 'number') return null
  const uri = r.uri ?? '/'
  const q = uri.indexOf('?')
  return {
    at: j.ts > 1e12 ? j.ts : Math.round(j.ts * 1000),
    ip,
    remoteIp: r.remote_ip ?? ip,
    host: (r.host ?? '').toLowerCase().replace(/:\d+$/, ''),
    method: (r.method ?? 'GET').toUpperCase(),
    path: (q >= 0 ? uri.slice(0, q) : uri) || '/',
    query: q >= 0 ? uri.slice(q + 1, q + 1 + 500) : '',
    status: typeof j.status === 'number' ? j.status : 0,
    userAgent: header(r.headers, 'User-Agent').slice(0, 400),
    referer: header(r.headers, 'Referer').slice(0, 500),
    country: header(r.headers, 'Cf-Ipcountry').toUpperCase().slice(0, 2),
    contentType: header(j.resp_headers, 'Content-Type').toLowerCase(),
    blocked: header(j.resp_headers, 'X-Airlock-Block') !== '',
    acceptLanguage: header(r.headers, 'Accept-Language').slice(0, 200),
    chUa: header(r.headers, 'Sec-Ch-Ua').slice(0, 300),
    chPlatform: header(r.headers, 'Sec-Ch-Ua-Platform').slice(0, 60),
    chPlatformVersion: header(r.headers, 'Sec-Ch-Ua-Platform-Version').slice(0, 30),
    optOut: header(r.headers, 'Dnt').trim() === '1' || header(r.headers, 'Sec-Gpc').trim() === '1',
    cfCity: decodeCf(header(r.headers, 'Cf-Ipcity')),
    cfRegion: decodeCf(header(r.headers, 'Cf-Region')),
    proto: (r.proto ?? '').slice(0, 20),
    tlsVersion: typeof r.tls?.version === 'number' ? r.tls.version : 0,
    durationMs: typeof j.duration === 'number' ? Math.round(j.duration * 1000 * 10) / 10 : null,
    bytes: typeof j.size === 'number' ? j.size : null,
    blockValue: header(j.resp_headers, 'X-Airlock-Block').trim().toLowerCase().slice(0, 40),
    paused: /^paused$/i.test(header(j.resp_headers, 'X-Airlock-State').trim() || header(j.resp_headers, 'X-Deployer-State').trim()),
    headers: r.headers ?? {},
  }
}

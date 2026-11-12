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
}

type Headers = Record<string, string[] | string | undefined>

function header(h: Headers | undefined, name: string): string {
  if (!h) return ''
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() !== want) continue
    const s = Array.isArray(v) ? v[0] : v
    return typeof s === 'string' ? s : ''
  }
  return ''
}

/** null: keine Zeile des Besucher-Loggers oder unlesbar */
export function parseAccessLine(line: string, logger = VISITS_LOGGER): AccessLine | null {
  const l = line.trim()
  if (!l.startsWith('{') || !l.includes(logger)) return null
  let j: {
    ts?: number; logger?: string; status?: number
    request?: { remote_ip?: string; client_ip?: string; host?: string; method?: string; uri?: string; headers?: Headers }
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
  }
}

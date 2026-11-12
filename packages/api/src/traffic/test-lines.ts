/**
 * Nur für Tests: Zeilen im Format, das Caddy 2.10/2.11 für den Logger
 * http.log.access.visits schreibt (JSON-Encoder; Aufbau einer echten Zeile
 * aus `caddy run` nachgebaut, Header in kanonischer Schreibweise).
 */

export interface LineInput {
  /** Sekunden (Caddy schreibt ts als Sekunden mit Bruchteil) */
  ts?: number
  ip?: string
  remoteIp?: string
  host?: string
  method?: string
  uri?: string
  status?: number
  ua?: string | null
  referer?: string
  country?: string
  contentType?: string | null
  blocked?: boolean
  logger?: string
  /** Weitere Kopfzeilen der Anfrage (kanonische Schreibweise, wie Caddy sie loggt) */
  headers?: Record<string, string>
}

export function caddyLine(o: LineInput = {}): string {
  const headers: Record<string, string[]> = { Accept: ['*/*'] }
  if (o.ua !== null) headers['User-Agent'] = [o.ua ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15']
  if (o.referer) headers.Referer = [o.referer]
  if (o.country) headers['Cf-Ipcountry'] = [o.country]
  for (const [k, v] of Object.entries(o.headers ?? {})) headers[k] = [v]
  headers.Cookie = ['REDACTED']
  const resp: Record<string, string[]> = { Server: ['Caddy'] }
  if (o.contentType !== null) resp['Content-Type'] = [o.contentType ?? 'text/html; charset=utf-8']
  if (o.blocked) resp['X-Airlock-Block'] = ['ip-filter']
  const ip = o.ip ?? '192.168.1.20'
  return JSON.stringify({
    level: 'info',
    ts: o.ts ?? 1794407400.123,
    logger: o.logger ?? 'http.log.access.visits',
    msg: 'handled request',
    request: {
      remote_ip: o.remoteIp ?? ip,
      remote_port: '64577',
      client_ip: ip,
      proto: 'HTTP/2.0',
      method: o.method ?? 'GET',
      host: o.host ?? 'foto.int.example.ch',
      uri: o.uri ?? '/',
      headers,
    },
    bytes_read: 0,
    user_id: '',
    duration: 0.0005,
    size: 1234,
    status: o.status ?? 200,
    resp_headers: resp,
  })
}

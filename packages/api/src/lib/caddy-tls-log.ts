/**
 * Caddys JSON-Log nach dem Stand des Wildcard-Zertifikats auswerten. Ergänzt
 * die TLS-Prüfung: Caddy meldet «certificate obtained successfully», sobald
 * die CA ausgestellt hat – unabhängig davon, ob deployer es schon sieht.
 *
 * Rein: bekommt den Log-Text, liest nichts selbst.
 */

export interface CaddyTlsLog {
  /** Letztes «certificate obtained successfully» für den Wildcard-Namen seit `since` */
  obtained: { at: number; issuer: string; staging: boolean } | null
  /** Letzter Fehler zum Zertifikat seit `since` (msg: error) */
  lastError: string | null
  /** Letzte Zeile zum Zertifikat seit `since`, beliebige Stufe */
  lastLine: string | null
}

interface Line {
  ts?: number | string
  level?: string
  logger?: string
  msg?: string
  error?: string
  identifier?: string
  issuer?: string
  identifiers?: string[]
}

/**
 * Nur Zertifikats-Zeilen: Logger «tls», «tls.obtain», «tls.issuance…»
 * (nicht «http» mit «HTTP/3 skipped because it requires TLS») und ohne das
 * Aufräumen des Speichers.
 */
const isCertLine = (j: Line) =>
  (j.logger === 'tls' || /^tls\.(obtain|issuance)/.test(j.logger ?? '')) && !/storage/i.test(j.msg ?? '')

function tsMs(ts: Line['ts']): number | null {
  if (typeof ts === 'number') return ts > 1e12 ? ts : ts * 1000
  if (typeof ts === 'string') {
    const n = Date.parse(ts)
    return Number.isNaN(n) ? null : n
  }
  return null
}

function summary(j: Line): string {
  const who = [j.identifier, j.identifiers?.join(', ')].filter(Boolean).join(' ')
  return [`${j.level ?? 'info'}: ${j.msg ?? ''}`, who && `(${who})`, j.error && `– ${j.error}`].filter(Boolean).join(' ').slice(0, 500)
}

export function parseCaddyTlsLog(text: string, wildcard: string, sinceMs: number): CaddyTlsLog {
  const out: CaddyTlsLog = { obtained: null, lastError: null, lastLine: null }
  // 5 s Spielraum: Uhr von Caddy und deployer laufen gleich, der Start aber vor dem Reload
  const since = sinceMs - 5_000
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    if (!l.startsWith('{')) continue
    let j: Line
    try {
      j = JSON.parse(l) as Line
    } catch {
      continue
    }
    const at = tsMs(j.ts)
    if (at !== null && at < since) continue
    if (!isCertLine(j)) continue
    out.lastLine = summary(j)
    if (j.level === 'error') out.lastError = [j.msg, j.error].filter(Boolean).join(': ').slice(0, 500)
    const forWildcard = (j.identifier ?? '').toLowerCase() === wildcard.toLowerCase()
    if (j.msg === 'certificate obtained successfully' && forWildcard) {
      const issuer = j.issuer ?? ''
      out.obtained = { at: at ?? Date.now(), issuer, staging: /staging/i.test(issuer) }
    }
  }
  return out
}

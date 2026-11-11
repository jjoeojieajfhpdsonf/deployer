/**
 * UI-Qualität 4: Logzeilen für den Reiter «Logs» – mit Zeit (UTC vom Server,
 * die Oberfläche zeigt Ortszeit), Dienst (Compose) und erkannter Stufe.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

export interface LogLineDto {
  /** ISO-Zeitpunkt (UTC) laut Docker, sonst null */
  at: string | null
  /** Compose-Dienst, sonst null */
  service: string | null
  text: string
  level: LogLevel | null
}

export interface LogLinesDto {
  lines: LogLineDto[]
  /** Compose: alle Dienste des Projekts (leer bei einem Container) */
  services: string[]
  /** Warum es keine Zeilen gibt (kein Container o. ä.), sonst null */
  hint: string | null
}

/** Zeitraum im Reiter «Logs» und «Zugriffe» */
export const LOG_RANGES = [
  { key: '15m', label: '15 Min.', minutes: 15 },
  { key: '1h', label: '1 Std.', minutes: 60 },
  { key: '24h', label: '24 Std.', minutes: 24 * 60 },
] as const
export type LogRange = (typeof LOG_RANGES)[number]['key']
export const rangeMinutes = (r: string | undefined): number => LOG_RANGES.find((x) => x.key === r)?.minutes ?? 15

/** Höchstens so viele Zeilen je Abruf (alle Dienste zusammen) */
export const LOG_LINES_MAX = 2000

/**
 * Stufe einer Zeile, soweit erkennbar: Wörter (ERROR, WARN …), logfmt
 * (level=error), JSON (pino: "level":50; sonst "level":"warn"). Sonst null –
 * nicht jede Zeile hat eine Stufe.
 */
export function logLevel(text: string): LogLevel | null {
  const pino = /"level"\s*:\s*(\d{2})\b/.exec(text)?.[1]
  if (pino) {
    const n = Number(pino)
    return n >= 50 ? 'error' : n >= 40 ? 'warn' : n >= 30 ? 'info' : 'debug'
  }
  const named = /(?:"level"\s*:\s*"|\blevel=|\blvl=)(\w+)/i.exec(text)?.[1]
  const word = named ?? /\b(FATAL|CRITICAL|CRIT|PANIC|ERROR|ERR|WARNING|WARN|INFO|DEBUG|TRACE)\b/.exec(text)?.[1]
    ?? /^\s*\[?(error|warn(?:ing)?|info|debug)\]?[\s:]/i.exec(text)?.[1]
  if (!word) return /^\s*(?:Traceback \(most recent call last\)|Error:|\w+Error:|panic:)/.test(text) ? 'error' : null
  const w = word.toLowerCase()
  if (/^(fatal|critical|crit|panic|error|err)$/.test(w)) return 'error'
  if (/^warn(ing)?$/.test(w)) return 'warn'
  if (w === 'info') return 'info'
  if (/^(debug|trace)$/.test(w)) return 'debug'
  return null
}

/**
 * Docker-Ausgabe mit `timestamps: true` in Zeilen zerlegen
 * («2026-11-10T12:46:01.123456789Z text»). Zeilen ohne Zeitstempel behalten at = null.
 */
export function parseDockerLines(raw: string, service: string | null = null): LogLineDto[] {
  const out: LogLineDto[] = []
  for (const line of raw.split('\n')) {
    if (line === '') continue
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z (.*)$/.exec(line)
    const text = (m ? m[3]! : line).replace(/\r$/, '')
    // Docker liefert Nanosekunden; ISO mit Millisekunden reicht und lässt sich überall lesen
    const at = m ? `${m[1]}${(m[2] ?? '.000').slice(0, 4).padEnd(4, '0')}Z` : null
    out.push({ at, service, text, level: logLevel(text) })
  }
  return out
}

/** Zeilen mehrerer Dienste nach Zeit mischen (stabil; ohne Zeit ans Ende ihres Dienstes) und kürzen */
export function mergeLogLines(groups: LogLineDto[][], max = LOG_LINES_MAX): LogLineDto[] {
  const all = groups.flatMap((g, gi) => g.map((l, i) => ({ l, gi, i })))
  all.sort((a, b) => {
    if (a.l.at && b.l.at && a.l.at !== b.l.at) return a.l.at < b.l.at ? -1 : 1
    return a.gi - b.gi || a.i - b.i
  })
  return all.slice(-max).map((x) => x.l)
}

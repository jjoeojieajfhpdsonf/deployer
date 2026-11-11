/**
 * Antwort 8: «Grenze erhöhen» schlägt den nächsten sinnvollen Wert vor.
 *
 * RAM: doppelt so viel wie bisher, auf 64 MB gerundet; höchstens so viel,
 * wie der Container auf dem Server bekommen kann (frei plus das, was er selbst
 * gerade belegt) und höchstens 32 768 MB (Grenze der API). Nie unter dem
 * aktuellen Wert: ist nichts mehr frei, bleibt es beim aktuellen.
 *
 * CPU: doppelt so viel wie bisher, höchstens so viele Kerne, wie der Server
 * hat (falls bekannt), sonst höchstens 16 (Grenze der API).
 */

export const MEM_STEP_MB = 64
export const MEM_MIN_MB = 64
export const MEM_MAX_MB = 32_768
export const CPU_MIN = 0.1
export const CPU_MAX = 16

const MIB = 1024 * 1024

export interface LimitSuggestion {
  /** Vorgeschlagener Wert (MB bzw. Kerne) */
  value: number
  /** Was den Vorschlag begrenzt hat: freier RAM bzw. Kerne des Servers, die Grenze der API, oder nichts */
  capped: 'server' | 'max' | null
  /** false: keine Erhöhung möglich (Vorschlag = aktueller Wert) */
  raised: boolean
}

const down = (mb: number) => Math.floor(mb / MEM_STEP_MB) * MEM_STEP_MB
const up = (mb: number) => Math.ceil(mb / MEM_STEP_MB) * MEM_STEP_MB

export function suggestMemoryLimit(o: {
  currentMb: number
  /** Freier RAM des Servers in MB; null = unbekannt (dann nur die Grenze der API) */
  serverFreeMb?: number | null
  /** Was der Container selbst gerade belegt (gehört ihm schon, zählt beim Server als belegt) */
  containerUsedMb?: number | null
}): LimitSuggestion {
  const current = Math.max(MEM_MIN_MB, Math.round(o.currentMb))
  const want = Math.max(MEM_MIN_MB, up(current * 2))
  const server = o.serverFreeMb === null || o.serverFreeMb === undefined || !Number.isFinite(o.serverFreeMb)
    ? Infinity
    : down(Math.max(0, o.serverFreeMb) + Math.max(0, o.containerUsedMb ?? 0))
  const cap = Math.min(server, MEM_MAX_MB)
  const value = Math.max(current, Math.min(want, cap))
  const capped = value >= want ? null : server <= MEM_MAX_MB ? 'server' : 'max'
  return { value, capped, raised: value > current }
}

/** CPU-Grenze in Kernen, auf Hundertstel gerundet */
const cpuRound = (v: number) => Math.round(v * 100) / 100

export function suggestCpuLimit(o: {
  current: number
  /** Kerne des Servers; null = unbekannt */
  serverCores?: number | null
}): LimitSuggestion {
  const current = Math.max(CPU_MIN, cpuRound(o.current))
  const want = cpuRound(current * 2)
  const server = o.serverCores && o.serverCores > 0 ? o.serverCores : Infinity
  const cap = Math.min(server, CPU_MAX)
  const value = Math.max(current, Math.min(want, cap))
  const capped = value >= want ? null : server <= CPU_MAX ? 'server' : 'max'
  return { value, capped, raised: value > current }
}

/** Freier RAM des Servers in MB aus dem Systemstatus; null, wenn nicht bekannt */
export function serverFreeMb(server: { memUsedBytes: number | null; memTotalBytes: number | null } | null | undefined): number | null {
  if (!server || server.memUsedBytes === null || server.memTotalBytes === null) return null
  return Math.max(0, (server.memTotalBytes - server.memUsedBytes) / MIB)
}

/** Verbrauch aus den Messpunkten der letzten Stunde: letzter Wert und Spitze; null ohne Messung */
export function usageOf<T>(samples: T[], pick: (s: T) => number): { now: number; peak: number } | null {
  if (samples.length === 0) return null
  const values = samples.map(pick)
  return { now: values.at(-1)!, peak: Math.max(...values) }
}

/**
 * Eingabe einer Zahl wie getippt: Komma oder Punkt als Dezimalzeichen,
 * Tausendertrenner (’ ' Leerzeichen) erlaubt. Leer bzw. kaputt: NaN (die
 * Prüfung meldet es dann mit ihrem Satz).
 */
export function parseNumber(s: string): number {
  const t = s.trim().replace(/[’'\s  ]/g, '').replace(',', '.')
  if (t === '' || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(t)) return Number.NaN
  return Number(t)
}

import { request } from 'undici'
import { probeUa } from '../lib/probe-ua.js'

export interface HealthcheckResult {
  ok: boolean
  attempts: number
  lastStatus: number | null
  lastError: string | null
}

/**
 * Pollt HTTP GET auf dem Container, bis 2xx/3xx kommt oder die Zeit ablaeuft.
 *
 * Laeuft, waehrend Airlock voruebergehend im Projekt-Netz haengt - der
 * Aufrufer verbindet vorher und trennt danach im finally.
 */
export async function waitForHealthy(opts: {
  url: string
  timeoutMs?: number
  intervalMs?: number
  onAttempt?: (attempt: number, detail: string) => void
  isAborted?: () => boolean
}): Promise<HealthcheckResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const intervalMs = opts.intervalMs ?? 1_000
  const deadline = Date.now() + timeoutMs

  let attempts = 0
  let lastStatus: number | null = null
  let lastError: string | null = null

  while (Date.now() < deadline) {
    if (opts.isAborted?.()) break
    attempts++
    try {
      // Keine Weiterleitungen folgen: ein 3xx gilt laut SPEC selbst als
      // gesund, es muss nicht verfolgt werden.
      const res = await request(opts.url, {
        method: 'GET',
        headers: { 'user-agent': probeUa('healthcheck') },
        headersTimeout: 5_000,
        bodyTimeout: 5_000,
      })
      lastStatus = res.statusCode
      // Body abfliessen lassen, sonst bleibt die Verbindung haengen.
      await res.body.dump()
      if (res.statusCode >= 200 && res.statusCode < 400) {
        opts.onAttempt?.(attempts, `HTTP ${res.statusCode} – bereit`)
        return { ok: true, attempts, lastStatus, lastError: null }
      }
      lastError = `HTTP ${res.statusCode}`
      opts.onAttempt?.(attempts, `HTTP ${res.statusCode}, warte weiter`)
    } catch (err) {
      lastError = (err as Error).message
      opts.onAttempt?.(attempts, `noch nicht erreichbar (${lastError})`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }

  return { ok: false, attempts, lastStatus, lastError }
}

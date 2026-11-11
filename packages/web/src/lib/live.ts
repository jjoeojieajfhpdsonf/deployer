import { useEffect, useSyncExternalStore } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'

/**
 * UI-Qualität 3: Live-Aktualisierung über einen Ereignisstrom
 * (GET /api/v1/events, an die Anmeldung gebunden) statt Polling.
 *
 * Der Server meldet nur, *was* sich geändert hat; hier wird daraufhin gezielt
 * nachgeladen (react-query invalidieren – nur sichtbare Abfragen laden neu).
 * Polling gibt es nur noch als Rückfall: ohne Strom alle 60 s, und wie bei
 * react-query üblich nicht, solange der Tab versteckt ist.
 */

export const FALLBACK_MS = 60_000

let connected = false
const listeners = new Set<() => void>()
function setConnected(v: boolean, qc: QueryClient) {
  if (connected === v) return
  connected = v
  listeners.forEach((f) => f())
  // Wechsel in beide Richtungen: alles Sichtbare einmal neu laden. Verbunden – verpasste Ereignisse
  // nachholen; getrennt – die Abfragen planen ihr Rückfall-Intervall (60 s) neu ein.
  void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'me' })
}

/** Ist der Ereignisstrom offen? (für Anzeige und Tests) */
export function useLiveConnected(): boolean {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb) }, () => connected)
}

/**
 * refetchInterval für Abfragen, die sich ändern können: mit Strom nichts (die
 * Ereignisse laden nach), ohne Strom alle 60 s.
 */
export const poll = (): number | false => (connected ? false : FALLBACK_MS)

type ServerEvent =
  | { type: 'hello' }
  | { type: 'project'; projectId: string | null }
  | { type: 'deploy'; deploymentId: string; status: string; projectId?: string | null }
  | { type: 'scan'; projectId: string | null; targetId?: string | null }
  | { type: 'audit'; action: string; targetType: string | null; targetId: string | null }
  | { type: 'cert' }
  | { type: 'session_ended' }

const keys = (...ks: unknown[][]) => ks

/** Welche Abfragen ein Ereignis betrifft (Präfixe der queryKeys) */
export function affected(e: ServerEvent): unknown[][] | 'all' {
  switch (e.type) {
    case 'project':
      return keys(['projects'], e.projectId ? ['project', e.projectId] : ['project'], e.projectId ? ['health', e.projectId] : ['health'])
    case 'deploy':
      // Projekt-ID kennt das Ereignis nicht immer: alle Projekt- und Deploy-Abfragen (nur sichtbare laden)
      return keys(['projects'], ['project'], ['deployments'], ['deployment', e.deploymentId], ['health'], ['audit'], ['audit-project'], ['fix-requests'], ['system'])
    case 'scan':
      return keys(['projects'], ['project'], ['scan'], ['scan-done'], ['external-scan'], ['external-targets'], ['fix-requests'], ['system'])
    case 'cert':
      return keys(['cloudflare'], ['system'], ['domains'])
    case 'audit':
      // Fast jede Änderung (auch von Claude oder einem anderen Tab): selten, also alles Sichtbare
      return 'all'
    default:
      return []
  }
}

/** Ereignisstrom öffnen, solange die Oberfläche angemeldet ist (in der Shell eingebunden). */
export function useServerEvents(): void {
  const qc = useQueryClient()
  useEffect(() => {
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    let failures = 0

    const open = () => {
      if (stopped || typeof EventSource === 'undefined') return
      es = new EventSource('/api/v1/events')
      es.onopen = () => { failures = 0; setConnected(true, qc) }
      es.onmessage = (m) => {
        let e: ServerEvent
        try { e = JSON.parse(m.data as string) as ServerEvent } catch { return }
        if (e.type === 'hello') { failures = 0; setConnected(true, qc); return }
        if (e.type === 'session_ended') {
          // Abgemeldet oder Sitzung abgelaufen: Anmeldung prüfen; gilt sie noch (anderer Tab), neu verbinden
          es?.close()
          setConnected(false, qc)
          void qc.invalidateQueries({ queryKey: ['me'] })
          retry = setTimeout(open, 2_000)
          return
        }
        const which = affected(e)
        if (which === 'all') void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'me' })
        else for (const k of which) void qc.invalidateQueries({ queryKey: k })
      }
      es.onerror = () => {
        setConnected(false, qc)
        // Der Browser verbindet selbst neu (retry: 5 s); ist der Strom zu (z. B. 401/404), mit wachsender Pause selbst
        if (es?.readyState === EventSource.CLOSED) {
          failures++
          retry = setTimeout(open, Math.min(60_000, 5_000 * 2 ** Math.min(failures, 4)))
        }
      }
    }
    open()
    return () => {
      stopped = true
      if (retry) clearTimeout(retry)
      es?.close()
      setConnected(false, qc)
    }
  }, [qc])
}

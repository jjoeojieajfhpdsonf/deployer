import { useEffect, useSyncExternalStore } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'

/**
 * UI-Qualität 3: Live-Aktualisierung über einen Ereignisstrom
 * (GET /api/v1/events, an die Anmeldung gebunden) statt Polling.
 *
 * Der Server meldet nur, *was* sich geändert hat; hier wird daraufhin gezielt
 * nachgeladen (react-query invalidieren, gebündelt). Polling gibt es nur noch
 * als Rückfall: ohne Strom alle 60 s, und nicht, solange der Tab versteckt ist.
 * Ein versteckter Tab schliesst den Strom nach 10 s (HTTP/1.1 erlaubt nur
 * wenige Verbindungen je Server) und öffnet ihn beim Zurückkommen wieder.
 */

export const FALLBACK_MS = 60_000
const HIDDEN_CLOSE_MS = 10_000
const BATCH_MS = 300

let connected = false
const listeners = new Set<() => void>()
function setConnected(v: boolean) {
  if (connected === v) return
  connected = v
  listeners.forEach((f) => f())
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

export type ServerEvent =
  | { type: 'hello' }
  | { type: 'project'; projectId: string | null }
  | { type: 'deploy'; deploymentId: string; status: string; projectId: string | null }
  | { type: 'scan'; phase: 'start' | 'stage' | 'end'; projectId: string | null; targetId?: string | null }
  | { type: 'audit'; action: string; targetType: string | null; targetId: string | null }
  | { type: 'cert' }
  | { type: 'public'; projectId: string }
  | { type: 'traffic'; projectIds: string[] }
  | { type: 'incident'; projectId: string | null }
  | { type: 'session_ended' }

type Key = unknown[]
const forProject = (id: string | null, ...names: string[]): Key[] => names.map((n) => (id ? [n, id] : [n]))

/** Welche Abfragen ein Ereignis betrifft (Präfixe der queryKeys) */
export function affected(e: ServerEvent): Key[] {
  switch (e.type) {
    case 'project':
      return [['projects'], ...forProject(e.projectId, 'project', 'health', 'topology')]
    case 'deploy':
      return [['projects'], ['deployment', e.deploymentId], ...forProject(e.projectId, 'project', 'deployments', 'health', 'audit-project', 'fix-requests', 'topology'),
        // Ende: Aktivität der Übersicht
        ...(e.status === 'active' || e.status === 'failed' ? [['audit']] : [])]
    case 'scan': {
      // Stufen nur die Scan-Ansicht; Start und Ende auch Liste, Befunde, Warteschlange
      const scan: Key[] = e.targetId ? [['external-scan', e.targetId]] : forProject(e.projectId, 'scan')
      if (e.phase === 'stage') return scan
      return [...scan, ['projects'], ['scan-done'], ['external-targets'], ['system'], ...forProject(e.projectId, 'project', 'fix-requests')]
    }
    case 'cert':
      return [['cloudflare'], ['domains']]
    // Etappe 3: neue Besucher-Zähler gespeichert (höchstens einmal pro Minute)
    case 'traffic':
      return [['traffic-today'], ...e.projectIds.map((id) => ['traffic', id])]
    case 'public':
      return [['projects'], ...forProject(e.projectId, 'project', 'public', 'public-progress', 'topology')]
    // Nacht 3, Etappe 5: Vorfall erkannt oder geändert
    case 'incident':
      return [['intrusion-incidents'], ['intrusion-incident'], ...(e.projectId ? [['intrusion', e.projectId]] : [])]
    case 'audit': {
      const base: Key[] = [['audit']]
      const id = e.targetId
      switch (e.targetType) {
        case 'project':
          return [...base, ['projects'], ...forProject(id, 'project', 'audit-project', 'deployments', 'public', 'header-rules', 'fix-requests', 'scan', 'files', 'auto-deploy', 'topology')]
        case 'external_target':
          return [...base, ['external-targets'], ['external-scan']]
        case 'token':
          return [...base, ['tokens']]
        default:
          // System, Cloudflare, Domains, Benachrichtigungen, GitHub, Einstellungen
          return [...base, ['system'], ['cloudflare'], ['domains'], ['notifications'], ['github'], ['expiry'], ['pause-page-template'], ['backup']]
      }
    }
    default:
      return []
  }
}

/** Nachladen bündeln: viele Ereignisse kurz hintereinander (Scan-Stufen) → ein Durchgang */
function batcher(qc: QueryClient) {
  const pending = new Map<string, Key>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    // Versteckter Tab: nur als veraltet markieren; beim Zurückkommen lädt react-query nach
    const refetchType = typeof document !== 'undefined' && document.hidden ? 'none' : 'active'
    for (const k of pending.values()) void qc.invalidateQueries({ queryKey: k, refetchType })
    pending.clear()
  }
  return {
    add(keys: Key[]) {
      for (const k of keys) pending.set(JSON.stringify(k), k)
      if (!timer) timer = setTimeout(flush, BATCH_MS)
    },
    cancel() { if (timer) clearTimeout(timer); pending.clear() },
  }
}

/** Alles Sichtbare neu laden (verpasste Ereignisse), ohne die Anmeldung */
const refreshAll = (qc: QueryClient) =>
  void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'me', refetchType: typeof document !== 'undefined' && document.hidden ? 'none' : 'active' })

/** Ereignisstrom öffnen, solange die Oberfläche angemeldet ist (in der Shell eingebunden). */
export function useServerEvents(): void {
  const qc = useQueryClient()
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null
    let downTimer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    let failures = 0
    let everOpen = false
    const batch = batcher(qc)

    const down = () => {
      const was = connected
      setConnected(false)
      // Nur beim Wechsel verbunden → getrennt: Abfragen planen ihr 60-s-Intervall neu ein (sie standen still).
      // Erst nach 5 s, damit kurze Aussetzer und Neustarts nicht alle Tabs zugleich laden lassen.
      if (was && !downTimer) downTimer = setTimeout(() => { downTimer = null; if (!connected) refreshAll(qc) }, 5_000)
    }
    const open = () => {
      // Versteckt: nicht (wieder) verbinden – das übernimmt die Rückkehr zum Tab
      if (stopped || es || document.hidden) return
      es = new EventSource('/api/v1/events')
      es.onopen = () => {
        failures = 0
        if (downTimer) { clearTimeout(downTimer); downTimer = null }
        setConnected(true)
        // Wiederverbunden: verpasste Ereignisse nachholen (beim ersten Öffnen ist alles frisch)
        if (everOpen) refreshAll(qc)
        everOpen = true
      }
      es.onmessage = (m) => {
        let e: ServerEvent
        try { e = JSON.parse(m.data as string) as ServerEvent } catch { return }
        if (e.type === 'session_ended') {
          // Abgemeldet oder Sitzung abgelaufen: Anmeldung prüfen; gilt sie noch (neues Cookie), neu verbinden
          close()
          void qc.invalidateQueries({ queryKey: ['me'] })
          retry = setTimeout(open, 2_000)
          return
        }
        batch.add(affected(e))
      }
      es.onerror = () => {
        down()
        // Der Browser verbindet selbst neu (retry: 5 s); ist der Strom zu (z. B. 401/404), mit wachsender Pause selbst
        if (es?.readyState === EventSource.CLOSED) {
          es = null
          failures++
          retry = setTimeout(open, Math.min(60_000, 5_000 * 2 ** Math.min(failures, 4)))
        }
      }
    }
    const close = () => {
      es?.close()
      es = null
      setConnected(false)
    }
    const onVisibility = () => {
      if (document.hidden) {
        if (!hiddenTimer) hiddenTimer = setTimeout(() => { hiddenTimer = null; if (document.hidden) close() }, HIDDEN_CLOSE_MS)
      } else {
        if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null }
        open()
      }
    }

    open()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', onVisibility)
      for (const t of [retry, hiddenTimer, downTimer]) if (t) clearTimeout(t)
      batch.cancel()
      close()
    }
  }, [qc])
}

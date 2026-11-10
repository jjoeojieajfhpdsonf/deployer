import { useSyncExternalStore } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { ApiError } from '../api.js'

/**
 * Verbindung zum Server, abgeleitet aus den Abfragen: Scheitert eine Abfrage,
 * weil der Server nicht antwortet (Netz weg, 502/503/504), gilt die Anzeige
 * als «veraltet» – die letzten Daten bleiben stehen, die Shell zeigt eine
 * Leiste mit «Stand vor n Min.». Die nächste erfolgreiche Antwort hebt das auf.
 */

export interface ConnectionState {
  /** Server antwortet nicht (seit `offlineSince`) */
  offline: boolean
  offlineSince: number | null
  /** Letzte erfolgreiche Antwort irgendeiner Abfrage */
  lastOkAt: number | null
}

let state: ConnectionState = { offline: false, offlineSince: null, lastOkAt: null }
const listeners = new Set<() => void>()

function set(next: Partial<ConnectionState>) {
  const merged = { ...state, ...next }
  if (merged.offline === state.offline && merged.offlineSince === state.offlineSince && merged.lastOkAt === state.lastOkAt) return
  state = merged
  for (const l of listeners) l()
}

/** Server nicht erreichbar (Netz weg, Gateway-Fehler) statt eines inhaltlichen Fehlers? Gemeinsam für Leiste und Fehlerkasten. */
export const isUnreachable = (e: unknown): boolean =>
  (e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504)) || e instanceof TypeError
const unreachable = isUnreachable

/** Einmal beim Start: hört auf alle Abfragen des QueryClient. */
export function watchConnection(qc: QueryClient): () => void {
  return qc.getQueryCache().subscribe((ev) => {
    if (ev.type !== 'updated') return
    const a = ev.action
    if (a.type === 'success') {
      // Erfolg: Server da. lastOkAt nur grob nachführen (sonst rendert die Leiste bei jeder Antwort)
      const now = Date.now()
      if (state.offline || !state.lastOkAt || now - state.lastOkAt > 15_000) set({ offline: false, offlineSince: null, lastOkAt: now })
    } else if (a.type === 'error' && unreachable(a.error)) {
      if (!state.offline) set({ offline: true, offlineSince: Date.now() })
    }
  })
}

export const getConnection = (): ConnectionState => state

export function useConnection(): ConnectionState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, getConnection, getConnection)
}

/** Nur für Tests und Screenshots: Zustand direkt setzen. */
export function setConnectionForTest(next: Partial<ConnectionState>): void {
  set(next)
}

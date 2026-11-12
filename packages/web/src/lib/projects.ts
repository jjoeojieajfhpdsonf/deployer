import { useQuery } from '@tanstack/react-query'
import { attentionOf, deployFailedOf, type ProjectAttention, type ProjectDto } from '@airlock/shared'
import { api } from '../api.js'
import { poll } from './live.js'

/**
 * Alle Projekte, gemeinsam für Seitenleiste, Übersicht und Security.
 * (Extremfälle zeigen jetzt die Screenshot-Fixtures in design-shots/,
 * nicht mehr eine Testdaten-Weiche in der App.)
 */
export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: api.listProjects,
    // Änderungen kommen über den Ereignisstrom (UI-Qualität 3); ohne ihn alle 60 s
    refetchInterval: poll,
  })
}

/** kind: wofür, unabhängig vom Text (Sortierung); tone nach der Farbregel – hoch ist rot wie kritisch (UI-Qualität 7) */
export type Attention = ProjectAttention

/** Braucht das Projekt Aufmerksamkeit? Und warum – für Filter und Hinweise (dieselbe Regel wie GET /summary). */
export const attention = (p: ProjectDto): Attention | null => attentionOf(p)

/** Gerade öffentlich erreichbar (live, nicht pausiert). */
export const isPublic = (p: ProjectDto) => p.routes.some((r) => r.target === 'public' && !r.pausedAt)
/** Hat einen öffentlichen Namen, live oder pausiert. */
export const hasPublicName = (p: ProjectDto) => p.routes.some((r) => r.target === 'public')

/**
 * Zustand kommt fertig vom Server (p.state, UI-Qualität 1). Hilfen darauf:
 * läuft etwas (auch wenn der neueste Deploy scheiterte oder öffentlich pausiert)?
 */
export const isLive = (p: ProjectDto) => p.state.key === 'running' || p.state.key === 'failed_old_running' || p.state.key === 'paused'
/** Zählt als «läuft» in Kennzahl und Filter: läuft oder pausiert – gescheiterte stehen unter «Aufmerksamkeit» */
export const isRunningOk = (p: ProjectDto) => p.state.key === 'running' || p.state.key === 'paused'
/** Gescheiterter Deploy, der Aufmerksamkeit braucht (alte Fassung läuft weiter oder gar nichts) */
// Gilt für Liste, Filter, Hinweise UND Fehlerbox der Projektseite (eine Definition)
export const deployFailedState = (p: ProjectDto) => deployFailedOf(p)

/** Reihenfolge nach Dringlichkeit: Fehler, kritisch, hoch, bald ablaufend, Rest nach Name. */
export function urgency(p: ProjectDto): number {
  const a = attention(p)
  if (!a) return 0
  // Nach Art, nicht nach Text (vorher traf «hoch» nie, weil der Text «hohe Befunde» lautet)
  return { deploy: 4, down: 3, critical: 3, high: 2, expiry: 1 }[a.kind]
}

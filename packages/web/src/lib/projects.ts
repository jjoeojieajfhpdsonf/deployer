import { useQuery } from '@tanstack/react-query'
import type { ProjectDto } from '@airlock/shared'
import { api } from '../api.js'
import { ageMs } from './dates.js'

/**
 * Alle Projekte, gemeinsam für Seitenleiste, Übersicht und Security.
 * (Extremfälle zeigen jetzt die Screenshot-Fixtures in design-shots/,
 * nicht mehr eine Testdaten-Weiche in der App.)
 */
export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: api.listProjects,
    refetchInterval: 5_000,
  })
}

export type Attention = { reason: string; tone: 'bad' | 'warn' }

/** Braucht das Projekt Aufmerksamkeit? Und warum – für Filter und Hinweise. */
export function attention(p: ProjectDto): Attention | null {
  if (deployFailedState(p)) return { reason: 'Deploy fehlgeschlagen', tone: 'bad' }
  if (p.state.key === 'down') return { reason: 'nichts läuft', tone: 'bad' }
  if (p.security && p.security.open.critical > 0) return { reason: `${p.security.open.critical} kritische Befunde`, tone: 'bad' }
  if (p.security && p.security.open.high > 0) return { reason: `${p.security.open.high} hohe Befunde`, tone: 'warn' }
  const left = ageMs(p.expiresAt)
  if (left !== null && !p.keep && -left < 7 * 86_400_000) return { reason: 'läuft bald ab', tone: 'warn' }
  return null
}

/** Gerade öffentlich erreichbar (live, nicht pausiert). */
export const isPublic = (p: ProjectDto) => p.routes.some((r) => r.target === 'public' && !r.pausedAt)
/** Hat einen öffentlichen Namen, live oder pausiert. */
export const hasPublicName = (p: ProjectDto) => p.routes.some((r) => r.target === 'public')

/**
 * Zustand kommt fertig vom Server (p.state, UI-Qualität 1). Hilfen darauf:
 * läuft etwas (auch wenn der neueste Deploy scheiterte oder öffentlich pausiert)?
 */
export const isLive = (p: ProjectDto) => p.state.key === 'running' || p.state.key === 'failed_old_running' || p.state.key === 'paused'
/** Gescheiterter Deploy, der Aufmerksamkeit braucht (alte Fassung läuft weiter oder gar nichts) */
export const deployFailedState = (p: ProjectDto) => p.state.key === 'failed_old_running' || (p.state.key === 'down' && p.lastDeployment?.status === 'failed')

/** Reihenfolge nach Dringlichkeit: Fehler, kritisch, hoch, bald ablaufend, Rest nach Name. */
export function urgency(p: ProjectDto): number {
  const a = attention(p)
  if (!a) return 0
  if (a.reason.startsWith('Deploy')) return 4
  if (a.tone === 'bad') return 3
  if (a.reason.includes('hoch')) return 2
  return 1
}

import { useQuery } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import type { ProjectDto } from '@deployer/shared'
import { api } from '../api.js'
import { demoProjects } from './demo.js'

/**
 * Alle Projekte, gemeinsam für Seitenleiste, Übersicht und Security. Mit
 * ?demo=leer|viele|lang in der Adresse kommen Testdaten statt der echten
 * (break-ui: Extremfälle ansehen, ohne Projekte anzulegen).
 */
export function useProjects() {
  // Nur in der Entwicklung: im gebauten Bundle gibt es keine Testdaten-Weiche.
  const { search } = useLocation()
  const demo = import.meta.env.DEV ? new URLSearchParams(search).get('demo') : null
  return useQuery({
    queryKey: ['projects', demo],
    queryFn: async () => (demo ? { projects: demoProjects(demo) } : api.listProjects()),
    refetchInterval: demo ? false : 5_000,
  })
}

export type Attention = { reason: string; tone: 'bad' | 'warn' }

/** Braucht das Projekt Aufmerksamkeit? Und warum – für Filter und Hinweise. */
export function attention(p: ProjectDto): Attention | null {
  if (p.status === 'failed' || p.lastDeployment?.status === 'failed') return { reason: 'Deploy fehlgeschlagen', tone: 'bad' }
  if (p.security && p.security.open.critical > 0) return { reason: `${p.security.open.critical} kritische Befunde`, tone: 'bad' }
  if (p.security && p.security.open.high > 0) return { reason: `${p.security.open.high} hohe Befunde`, tone: 'warn' }
  if (p.expiresAt && !p.keep && new Date(p.expiresAt).getTime() - Date.now() < 7 * 86_400_000) return { reason: 'läuft bald ab', tone: 'warn' }
  return null
}

export const isPublic = (p: ProjectDto) => p.routes.some((r) => r.target === 'public')

/**
 * Laufzustand getrennt vom Ergebnis des letzten Deploys (Critique P1): Ist
 * ein Deploy gescheitert, läuft die vorherige Fassung meist weiter. Dann
 * heisst der Zustand «läuft», und der Fehlschlag steht als eigene Zeile.
 */
export function runtimeStatus(p: ProjectDto): { status: ProjectDto['status']; deployFailed: boolean } {
  const deployFailed = p.lastDeployment?.status === 'failed'
  if (p.status === 'failed' && p.activeDeployment && p.desiredState === 'running') return { status: 'running', deployFailed: true }
  return { status: p.status, deployFailed }
}

/** Reihenfolge nach Dringlichkeit: Fehler, kritisch, hoch, bald ablaufend, Rest nach Name. */
export function urgency(p: ProjectDto): number {
  const a = attention(p)
  if (!a) return 0
  if (a.reason.startsWith('Deploy')) return 4
  if (a.tone === 'bad') return 3
  if (a.reason.includes('hoch')) return 2
  return 1
}

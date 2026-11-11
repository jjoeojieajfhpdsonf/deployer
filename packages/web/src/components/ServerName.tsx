import { useQuery } from '@tanstack/react-query'
import { api } from '../api.js'
import { FALLBACK_MS } from '../lib/live.js'

/** Servername für Brotkrumen und Seitenleiste; derselbe Abruf wie die Systemseite. */
export function useSystem() {
  // Messwerte (CPU, RAM, Platz): einmal pro Minute; Warteschlange des Scanners kommt über den Ereignisstrom
  return useQuery({ queryKey: ['system'], queryFn: api.system, refetchInterval: FALLBACK_MS, staleTime: 10_000 })
}

export function useServerName(): string {
  return useSystem().data?.server.name ?? 'Airlock'
}

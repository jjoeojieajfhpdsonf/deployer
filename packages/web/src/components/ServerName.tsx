import { useQuery } from '@tanstack/react-query'
import { api } from '../api.js'

/** Servername für Brotkrumen und Seitenleiste; derselbe Abruf wie die Systemseite. */
export function useSystem() {
  return useQuery({ queryKey: ['system'], queryFn: api.system, refetchInterval: 15_000, staleTime: 10_000 })
}

export function useServerName(): string {
  return useSystem().data?.server.name ?? 'Airlock'
}

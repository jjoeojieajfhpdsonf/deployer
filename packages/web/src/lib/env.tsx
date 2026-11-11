import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { matchPath, useLocation } from 'react-router-dom'
import { api, setApiEnvironment, type EnvironmentDto } from '../api.js'
import { FALLBACK_MS } from './live.js'

/**
 * M9: Umgebungen in der Oberfläche (SPEC «Umgebungen», Bedienung).
 *
 * Welche Umgebung gilt: die aus der Adresse /u/<slug>/…; auf Seiten ohne
 * Umgebung (Server, Konto, Umgebungen verwalten) die zuletzt gewählte, sonst
 * die Standard-Umgebung. Vor dem Rendern der Seiten stellt der Provider die
 * API darauf ein und wirft Daten der vorigen Umgebung aus dem
 * Zwischenspeicher – nie zeigt eine Seite kurz die Projekte der anderen.
 */

interface EnvState {
  /** Slug der gültigen Umgebung (leer, solange die Liste lädt) */
  slug: string
  env: EnvironmentDto | null
  envs: EnvironmentDto[]
  /** Steht die Umgebung in der Adresse? */
  fromUrl: boolean
  /** Adresse nennt eine Umgebung, die es nicht gibt */
  unknown: boolean
  loading: boolean
}

const EnvContext = createContext<EnvState>({ slug: '', env: null, envs: [], fromUrl: false, unknown: false, loading: true })

export function useEnvironments() {
  // Höchstens einmal pro Minute (UI-Qualität 3); der Ereignisstrom meldet Umgebungen nicht, darum auch mit Strom
  return useQuery({ queryKey: ['environments'], queryFn: api.environments, refetchInterval: FALLBACK_MS, staleTime: 10_000 })
}

/** Abfragen, die nicht an einer Umgebung hängen und beim Wechsel bleiben dürfen */
const SHARED_KEYS = new Set(['me', 'environments', 'system', 'github', 'notifications'])

export function EnvProvider({ lastEnvironment, children }: { lastEnvironment: string | null | undefined; children: ReactNode }) {
  const location = useLocation()
  const qc = useQueryClient()
  const list = useEnvironments()
  const envs = list.data?.environments ?? []
  const urlSlug = matchPath('/u/:env/*', location.pathname)?.params.env ?? null
  const fallback = envs.find((e) => e.slug === lastEnvironment) ?? envs.find((e) => e.isDefault) ?? envs[0] ?? null
  const env = urlSlug ? envs.find((e) => e.slug === urlSlug) ?? null : fallback
  const slug = urlSlug ?? fallback?.slug ?? ''

  // Synchron beim Rendern: die API zeigt auf die neue Umgebung, bevor eine Seite fragt
  const prev = useRef<string | null>(null)
  if (slug && prev.current !== slug) {
    if (prev.current !== null) qc.removeQueries({ predicate: (q) => !SHARED_KEYS.has(String(q.queryKey[0])) })
    setApiEnvironment(slug)
    prev.current = slug
  }

  // Letzte Wahl merken (für Adressen ohne /u/…), nur bei einer echten Umgebung aus der Adresse
  useEffect(() => {
    if (!urlSlug || !env || urlSlug === lastEnvironment) return
    void api.setPreferences({ lastEnvironment: urlSlug }).then(() => qc.setQueryData(['me'], (m: object | undefined) => (m ? { ...m, lastEnvironment: urlSlug } : m))).catch(() => {})
  }, [urlSlug, env, lastEnvironment, qc])

  const value: EnvState = { slug, env, envs, fromUrl: Boolean(urlSlug), unknown: Boolean(urlSlug && list.data && !env), loading: list.isLoading }
  return <EnvContext.Provider value={value}>{children}</EnvContext.Provider>
}

export const useEnv = (): EnvState => useContext(EnvContext)

/**
 * Shell erst zeigen, wenn die Umgebung feststeht: Seitenleiste, Glocke und
 * Vorgänge fragen sofort nach Listen der Umgebung – ohne Umgebung gingen
 * diese Anfragen ins Leere (und ohne Sekunden-Polling bliebe das Ergebnis
 * stehen). Bis dahin das Skelett der Shell.
 */
export function EnvReady({ fallback, children }: { fallback: ReactNode; children: ReactNode }) {
  const { slug, loading } = useEnv()
  return <>{!slug && loading ? fallback : children}</>
}

/** Pfad in der gültigen Umgebung: ep('/projekte') → /u/jherren/projekte */
export function useEnvPath(): (p: string) => string {
  const { slug } = useEnv()
  return (p: string) => `/u/${slug}${p}`
}

/** Dieselbe Seite in einer anderen Umgebung (Projektseiten führen zur Liste). */
export function samePageIn(pathname: string, slug: string): string {
  const m = matchPath('/u/:env/*', pathname)
  const rest = m?.params['*'] ?? 'projekte'
  const safe = /^projekte\/(?!neu$)/.test(rest) ? 'projekte' : rest.replace(/^einrichtung.*/, 'einstellungen')
  return `/u/${slug}/${safe || 'projekte'}`
}

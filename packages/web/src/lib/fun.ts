import { useCallback, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ThemePref, UiPrefsPatch } from '@airlock/shared'
import { api, type MeDto } from '../api.js'
import { applyTheme, currentTheme, subscribeTheme, type ResolvedTheme } from './theme.js'

/**
 * Etappe 7 – Spass-Paket: gemeinsame Schalter (Profilmenü › Darstellung).
 *
 * - fun: alle Spass-Funktionen (Matrix-Regen, Disketti, Konfetti, Achievements,
 *   Snake auf der 404-Seite der internen Adressen); Standard an
 * - matrix: Matrix-Regen während eines Deploys auch ausserhalb des
 *   Terminal-Themes; Standard aus
 * - disketti: Helferfigur im Windows-95-Theme; «Nie wieder» schaltet sie aus
 *
 * Die Werte liegen auf dem Server (Präferenzen), wie die Darstellung.
 */
export interface FunPrefs { fun: boolean; matrix: boolean; disketti: boolean }

export const funPrefsOf = (me: MeDto | undefined | null): FunPrefs => ({
  fun: me?.fun !== false,
  matrix: me?.matrix === true,
  disketti: me?.disketti !== false,
})

export function useFunPrefs(): FunPrefs & { set: (patch: Partial<FunPrefs>) => Promise<void> } {
  const qc = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const set = useCallback(async (patch: Partial<FunPrefs>) => {
    const before = qc.getQueryData<MeDto>(['me'])
    // Sofort wirksam; der Server bestätigt (bei einem Fehler zurück)
    qc.setQueryData<MeDto>(['me'], (old) => (old ? { ...old, ...patch } : old))
    try {
      await api.setPreferences(patch as UiPrefsPatch)
    } catch {
      qc.setQueryData<MeDto>(['me'], before)
    }
  }, [qc])
  return { ...funPrefsOf(me.data), set }
}

/**
 * Darstellung wählen (Profilmenü, Befehlspalette): sofort anwenden, dann auf
 * dem Server speichern (gilt auf jedem Gerät). Scheitert das Speichern, gilt
 * die Wahl lokal trotzdem; beim nächsten Laden gewinnt der Server.
 */
export function useChooseTheme(): (t: ThemePref) => Promise<void> {
  const qc = useQueryClient()
  return useCallback(async (t: ThemePref) => {
    applyTheme(t)
    qc.setQueryData<MeDto>(['me'], (old) => (old ? { ...old, theme: t } : old))
    try {
      await api.setPreferences({ theme: t })
    } catch {
      /* lokal gilt die Wahl trotzdem */
    }
  }, [qc])
}

/** prefers-reduced-motion, live (Systemeinstellung kann sich ändern) */
const reduceQuery = () => (typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null)
const subscribeReduce = (fn: () => void) => {
  const m = reduceQuery()
  m?.addEventListener('change', fn)
  return () => m?.removeEventListener('change', fn)
}
export const useReducedMotion = () => useSyncExternalStore(subscribeReduce, () => Boolean(reduceQuery()?.matches), () => true)

/** Aufgelöstes Theme (light/dark/win95/terminal), live */
export const useResolvedTheme = (): ResolvedTheme => useSyncExternalStore(subscribeTheme, currentTheme, () => 'light')

/** Sichtbarkeit des Tabs, live (Matrix-Regen hält an, solange er versteckt ist) */
const subscribeVisibility = (fn: () => void) => { document.addEventListener('visibilitychange', fn); return () => document.removeEventListener('visibilitychange', fn) }
export const usePageVisible = () => useSyncExternalStore(subscribeVisibility, () => !document.hidden, () => true)

/**
 * Rein: läuft der Matrix-Regen? Nur während ein Deploy läuft, nur mit
 * Spass-Funktionen, nie bei reduzierter Bewegung oder verstecktem Tab; im
 * Terminal-Theme immer, sonst nur mit dem Schalter.
 */
export function matrixActive(o: { prefs: FunPrefs; theme: ResolvedTheme; deploying: boolean; reducedMotion: boolean; visible: boolean }): boolean {
  if (!o.prefs.fun || !o.deploying || o.reducedMotion || !o.visible) return false
  return o.theme === 'terminal' || o.prefs.matrix
}

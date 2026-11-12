import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { UnlockId } from '@airlock/shared'
import { api, type MeDto } from '../api.js'
import { notifyOk } from '../lib/feedback.js'
import { currentTheme, subscribeTheme } from '../lib/theme.js'
import { konamiDone, konamiStep, versionClick, VERSION_CLICKS } from '../lib/easter-egg.js'

/**
 * Verstecktes Theme «Windows 95».
 *
 * Freischalten: 7× auf die Versionsnummer unten links oder irgendwo den
 * Konami-Code tippen. Die Freischaltung liegt auf dem Server (Präferenzen,
 * Liste `unlocks`, gilt auf jedem Gerät); danach steht «Windows 95» im Profilmenü unter
 * «Darstellung». Kein Ton, nur die Meldung.
 *
 * Aussehen: fast alles über Tokens und einen Zusatz-Block in styles.css.
 * Fenster, Taskleiste und Startmenü: Win95Desktop.tsx.
 */

/**
 * Freischalten (einmal): Kennung auf dem Server zur Liste `unlocks` hinzufügen,
 * Profil im Cache nachführen, Meldung zeigen. Allgemein für jede Freischaltung.
 */
export function useUnlock(id: UnlockId, notice: { title: string; description: string }): () => void {
  const qc = useQueryClient()
  const busy = useRef(false)
  const { title, description } = notice
  return useCallback(() => {
    const me = qc.getQueryData<MeDto>(['me'])
    if (!me?.loggedIn || me.unlocks?.includes(id) || busy.current) return
    busy.current = true
    const patch = (fn: (list: UnlockId[]) => UnlockId[]) =>
      qc.setQueryData<MeDto>(['me'], (old) => (old ? { ...old, unlocks: fn(old.unlocks ?? []) } : old))
    // Sofort im Menü zeigen; der Server bestätigt
    patch((list) => (list.includes(id) ? list : [...list, id]))
    notifyOk(title, { id, description })
    api.unlock(id)
      // Etappe 7: «Geheimnisse gefunden» könnte jetzt erreicht sein
      .then(() => qc.invalidateQueries({ queryKey: ['achievements'] }))
      .catch(() => patch((list) => list.filter((x) => x !== id)))
      .finally(() => { busy.current = false })
  }, [qc, id, title, description])
}

export const useWin95Unlock = () =>
  useUnlock('win95', { title: 'Windows 95 freigeschaltet', description: 'Neu im Profilmenü unter «Darstellung».' })

/** Tippt man gerade Text? Dann zählt keine Taste zum Code. */
const TEXT_INPUTS = new Set(['text', 'search', 'email', 'password', 'url', 'tel', 'number', 'date', 'datetime-local', 'time', 'month', 'week'])
const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  if (!el?.tagName) return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  return el.tagName === 'INPUT' && TEXT_INPUTS.has((el as HTMLInputElement).type)
}

/** Lauscht überall auf den Konami-Code (↑↑↓↓←→←→ B A). Zeichnet nichts. */
export function KonamiUnlock() {
  const unlock = useWin95Unlock()
  useEffect(() => {
    let progress = 0
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) { progress = 0; return }
      progress = konamiStep(progress, e.key)
      if (konamiDone(progress)) { progress = 0; unlock() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [unlock])
  return null
}

/** Klick-Zähler für die Versionsnummer: nach 7 schnellen Klicks freischalten. */
export function useVersionClicks(): () => void {
  const unlock = useWin95Unlock()
  const state = useRef({ count: 0, last: -Infinity })
  return useCallback(() => {
    state.current = versionClick(state.current, Date.now())
    if (state.current.count >= VERSION_CLICKS) { state.current = { count: 0, last: -Infinity }; unlock() }
  }, [unlock])
}

export const useIsWin95 = () => useSyncExternalStore(subscribeTheme, () => currentTheme() === 'win95', () => false)

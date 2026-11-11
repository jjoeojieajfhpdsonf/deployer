import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, type MeDto } from '../api.js'
import { notifyOk } from '../lib/feedback.js'
import { currentTheme, subscribeTheme } from '../lib/theme.js'
import { fmtTime } from '../lib/dates.js'
import { konamiDone, konamiStep, versionClick, VERSION_CLICKS } from '../lib/easter-egg.js'

/**
 * Verstecktes Theme «Windows 95».
 *
 * Freischalten: 7× auf die Versionsnummer unten links oder irgendwo den
 * Konami-Code tippen. Die Freischaltung liegt auf dem Server (Präferenzen,
 * gilt auf jedem Gerät); danach steht «Windows 95» im Profilmenü unter
 * «Darstellung». Kein Ton, nur die Meldung.
 *
 * Aussehen: fast alles über Tokens und einen Zusatz-Block in styles.css.
 * Einzige Theme-Verzweigung im JSX ist die Taskleiste (aria-hidden, reine Deko).
 */

/** Freischalten (einmal): Server speichern, Profil im Cache nachführen, Meldung zeigen. */
export function useWin95Unlock(): () => void {
  const qc = useQueryClient()
  const busy = useRef(false)
  return useCallback(() => {
    const me = qc.getQueryData<MeDto>(['me'])
    if (!me?.loggedIn || me.win95Unlocked || busy.current) return
    busy.current = true
    // Sofort im Menü zeigen; der Server bestätigt
    qc.setQueryData<MeDto>(['me'], (old) => (old ? { ...old, win95Unlocked: true } : old))
    notifyOk('Windows 95 freigeschaltet', { id: 'win95', description: 'Neu im Profilmenü unter «Darstellung».' })
    api.setPreferences({ win95Unlocked: true })
      .catch(() => qc.setQueryData<MeDto>(['me'], (old) => (old ? { ...old, win95Unlocked: false } : old)))
      .finally(() => { busy.current = false })
  }, [qc])
}

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

const clock = () => fmtTime(Date.now())

/** Taskleiste unten: «Start» und Uhrzeit. Nur bei «Windows 95», reine Deko (aria-hidden). */
export function Taskbar() {
  const on = useIsWin95()
  const [now, setNow] = useState(clock)
  useEffect(() => {
    if (!on) return
    setNow(clock())
    const t = setInterval(() => setNow(clock()), 15_000)
    return () => clearInterval(t)
  }, [on])
  if (!on) return null
  return (
    <div className="w95-taskbar" aria-hidden="true">
      <span className="w95-start"><span className="w95-logo" />Start</span>
      <span className="w95-task">Airlock</span>
      <span className="w95-tray num">{now}</span>
    </div>
  )
}

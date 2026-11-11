import { useCallback, useEffect, useId, useSyncExternalStore } from 'react'
import { useNavigate, type NavigateOptions, type To } from 'react-router-dom'

/**
 * UI-Qualität 8: Warnung beim Verlassen mit ungespeicherten Änderungen.
 *
 * Formulare melden sich mit useUnsaved(dirty, was) an. Solange eines
 * ungespeichert ist:
 * - Neu laden / Tab schliessen: die Rückfrage des Browsers (beforeunload)
 * - Klick auf einen Link in der Oberfläche, Reiterwechsel, Tastenkürzel,
 *   Befehlspalette: eigene Rückfrage (LeaveGuard in der Shell; confirmLeave()
 *   bzw. useGuardedNavigate() für eigene Wechsel)
 *
 * Art «once»: nichts Eingegebenes, sondern etwas, das nur einmal zu sehen ist
 * (neues Token). Die Rückfrage sagt das dann so.
 */
export type UnsavedKind = 'edit' | 'once'
type Entry = { what: string; kind: UnsavedKind }
const dirty = new Map<string, Entry>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((f) => f())

export function useUnsaved(isDirty: boolean, what: string, kind: UnsavedKind = 'edit'): void {
  const id = useId()
  useEffect(() => {
    if (isDirty) dirty.set(id, { what, kind })
    else dirty.delete(id)
    emit()
    return () => { if (dirty.delete(id)) emit() }
  }, [id, isDirty, what, kind])
}

export const hasUnsaved = () => dirty.size > 0
export const forgetUnsaved = () => { dirty.clear(); emit() }

export function useHasUnsaved(): boolean {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb) }, hasUnsaved)
}

/* --- Rückfrage: Promise, beantwortet vom LeaveGuard -------------------------------- */

export type Ask = {
  resolve: (ok: boolean) => void
  /** Ungespeicherte Eingaben («Umgebungsvariablen», «Pause-Seite» …) */
  edits: string[]
  /** Nur einmal Sichtbares («neues Token») */
  once: string[]
}
let pending: Ask | null = null
const askListeners = new Set<() => void>()

/** Vor einem eigenen Wechsel (z.B. Reiter): true = weiter (nichts offen oder bestätigt) */
export function confirmLeave(): Promise<boolean> {
  if (!hasUnsaved()) return Promise.resolve(true)
  if (pending) return Promise.resolve(false)
  const entries = [...dirty.values()]
  const pick = (k: UnsavedKind) => [...new Set(entries.filter((e) => e.kind === k).map((e) => e.what))]
  return new Promise((resolve) => {
    pending = {
      edits: pick('edit'),
      once: pick('once'),
      resolve: (ok) => {
        if (!pending) return
        pending = null
        askListeners.forEach((f) => f())
        if (ok) forgetUnsaved()
        resolve(ok)
      },
    }
    askListeners.forEach((f) => f())
  })
}

export function usePendingLeave(): Ask | null {
  return useSyncExternalStore((cb) => { askListeners.add(cb); return () => askListeners.delete(cb) }, () => pending)
}

/**
 * navigate() mit Rückfrage – für Wechsel, die nicht über einen Link laufen
 * (Tastenkürzel, Befehlspalette, Aktionen in Toasts). Wechsel, die die
 * Oberfläche selbst auslöst (nach einem Deploy zur Übersicht), fragen nicht.
 */
export function useGuardedNavigate(): (to: To, opts?: NavigateOptions) => Promise<boolean> {
  const navigate = useNavigate()
  return useCallback(async (to: To, opts?: NavigateOptions) => {
    const ok = await confirmLeave()
    if (ok) navigate(to, opts)
    return ok
  }, [navigate])
}

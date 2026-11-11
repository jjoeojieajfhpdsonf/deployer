import { useEffect, useId, useSyncExternalStore } from 'react'

/**
 * UI-Qualität 8: Warnung beim Verlassen mit ungespeicherten Änderungen.
 *
 * Formulare melden sich mit useUnsaved(dirty, was) an. Solange eines
 * ungespeichert ist:
 * - Neu laden / Tab schliessen: die Rückfrage des Browsers (beforeunload)
 * - Klick auf einen Link in der Oberfläche, Reiterwechsel: eigene Rückfrage
 *   (LeaveGuard in der Shell, confirmLeave() für eigene Wechsel)
 */
const dirty = new Map<string, string>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((f) => f())

export function useUnsaved(isDirty: boolean, what: string): void {
  const id = useId()
  useEffect(() => {
    if (isDirty) dirty.set(id, what)
    else dirty.delete(id)
    emit()
    return () => { if (dirty.delete(id)) emit() }
  }, [id, isDirty, what])
}

export const hasUnsaved = () => dirty.size > 0
/** Was ungespeichert ist, für die Rückfrage («Umgebungsvariablen», «Pause-Seite» …) */
export const unsavedWhat = () => [...new Set(dirty.values())]
export const forgetUnsaved = () => { dirty.clear(); emit() }

export function useHasUnsaved(): boolean {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb) }, hasUnsaved)
}

/* --- Rückfrage: Promise, beantwortet vom LeaveGuard -------------------------------- */

type Ask = { resolve: (ok: boolean) => void; what: string[] }
let pending: Ask | null = null
const askListeners = new Set<() => void>()

/** Vor einem eigenen Wechsel (z.B. Reiter): true = weiter (nichts offen oder bestätigt) */
export function confirmLeave(): Promise<boolean> {
  if (!hasUnsaved()) return Promise.resolve(true)
  if (pending) return Promise.resolve(false)
  return new Promise((resolve) => {
    pending = {
      what: unsavedWhat(),
      resolve: (ok) => {
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

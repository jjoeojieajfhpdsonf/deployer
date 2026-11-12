import { useSyncExternalStore } from 'react'

/**
 * Nacht 3, Etappe 1: erneute Bestätigung (sudo). Der Server lehnt heikle
 * Aktionen ohne frische Bestätigung mit 403 «sudo_required» ab; api.ts ruft
 * dann requestSudo() auf. Das öffnet den Bestätigungsdialog (SudoDialog) und
 * wartet: bestätigt → die Anfrage geht noch einmal, abgebrochen → sie
 * scheitert still («sudo_cancelled»). Mehrere Anfragen gleichzeitig teilen
 * sich einen Dialog.
 */
let pending: { promise: Promise<boolean>; resolve: (ok: boolean) => void } | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((f) => f())

export function requestSudo(): Promise<boolean> {
  if (pending) return pending.promise
  let resolve!: (ok: boolean) => void
  const promise = new Promise<boolean>((r) => { resolve = r })
  pending = { promise, resolve }
  emit()
  return promise
}

export function finishSudo(ok: boolean): void {
  const p = pending
  pending = null
  emit()
  p?.resolve(ok)
}

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }

export function useSudoRequested(): boolean {
  return useSyncExternalStore(subscribe, () => pending !== null)
}

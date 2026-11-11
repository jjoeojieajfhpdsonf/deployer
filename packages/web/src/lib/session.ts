import { useSyncExternalStore } from 'react'

/**
 * UI-Qualität 8: Sitzung abgelaufen, während die Seite offen ist. Statt die
 * Seite durch die Anmeldung zu ersetzen (und alle Eingaben zu verlieren),
 * erscheint ein Anmeldedialog darüber; danach geht es genau dort weiter.
 *
 * api.ts meldet jedes 401 hierher (ausser Anmeldung selbst und /auth/me).
 */
let expired = false
const listeners = new Set<() => void>()

export function markSessionExpired(): void {
  if (expired) return
  expired = true
  listeners.forEach((f) => f())
}

export function markSessionOk(): void {
  if (!expired) return
  expired = false
  listeners.forEach((f) => f())
}

export const isSessionExpired = () => expired

export function useSessionExpired(): boolean {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb) }, () => expired)
}

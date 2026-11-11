import { useSyncExternalStore } from 'react'

/**
 * UI-Qualität 8: Sitzung abgelaufen, während die Seite offen ist. Statt die
 * Seite durch die Anmeldung zu ersetzen (und alle Eingaben zu verlieren),
 * erscheint ein Anmeldedialog darüber; danach geht es genau dort weiter.
 *
 * api.ts meldet jedes 401 hierher (ausser der Anmeldung selbst und /auth/me).
 * Aktionen, die am 401 gescheitert sind, merkt sich der Dialog und nennt sie
 * («Nicht ausgeführt: …») – ein Toast würde hinter dem Dialog verschwinden.
 *
 * Bewusste Abmeldung (ProfileMenu) ist kein Ablauf: markLoggedOut() sorgt
 * dafür, dass danach die Anmeldeseite kommt und nicht dieser Dialog.
 */
type State = { expired: boolean; failed: readonly string[]; loggedOut: boolean }
let state: State = { expired: false, failed: [], loggedOut: false }
const listeners = new Set<() => void>()
const set = (next: Partial<State>) => { state = { ...state, ...next }; listeners.forEach((f) => f()) }

export function markSessionExpired(): void {
  if (state.expired || state.loggedOut) return
  set({ expired: true })
}

export function markSessionOk(): void {
  if (!state.expired && state.failed.length === 0 && !state.loggedOut) return
  set({ expired: false, failed: [], loggedOut: false })
}

/** Eine Aktion ist am 401 gescheitert (Titel wie «Nicht gespeichert», «Deploy nicht gestartet») */
export function noteFailedAction(title: string): void {
  if (state.loggedOut || state.failed.includes(title)) return
  set({ failed: [...state.failed, title] })
}

export function markLoggedOut(): void {
  set({ expired: false, failed: [], loggedOut: true })
}

export const isSessionExpired = () => state.expired
export const isLoggedOut = () => state.loggedOut

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }

export function useSessionExpired(): boolean {
  return useSyncExternalStore(subscribe, () => state.expired)
}

export function useFailedActions(): readonly string[] {
  return useSyncExternalStore(subscribe, () => state.failed)
}

export function useLoggedOut(): boolean {
  return useSyncExternalStore(subscribe, () => state.loggedOut)
}

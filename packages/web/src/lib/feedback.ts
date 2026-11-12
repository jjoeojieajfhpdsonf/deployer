import { toast } from 'sonner'
import { MutationCache, type Mutation } from '@tanstack/react-query'
import { errorReason } from '../components/States.js'
import { ApiError } from '../api.js'
import { isUnreachable } from './connection.js'
import { isSessionExpired, noteFailedAction } from './session.js'

/**
 * Rückmeldung bei Aktionen, ein Muster für die ganze App:
 *   Knopf mit Ladezustand (aria-busy, Breite bleibt) → Toast mit Ergebnis →
 *   «Rückgängig», wo es geht. Fehler: Toast mit Grund und einer Aktion.
 * Alle Toasts laufen über diese Datei (ein Toaster in main.tsx).
 */

/** So lange bleibt «Rückgängig» stehen */
export const UNDO_MS = 10_000

type Action = { label: string; onClick: () => void }

export function notifyOk(title: string, opts: { description?: string; undo?: () => unknown; action?: Action; id?: string } = {}): void {
  toast.success(title, {
    id: opts.id,
    description: opts.description,
    duration: opts.undo ? UNDO_MS : undefined,
    action: opts.undo ? { label: 'Rückgängig', onClick: () => void opts.undo!() } : opts.action,
  })
}

export function notifyWarn(title: string, opts: { description?: string; action?: Action; id?: string } = {}): void {
  toast.warning(title, { id: opts.id, description: opts.description, action: opts.action })
}

/** Fehler-Toast: Titel sagt, was nicht ging; Beschreibung den Grund; Aktion, wenn es eine gibt. */
export function notifyError(title: string, err: unknown, opts: { action?: Action; id?: string } = {}): void {
  toast.error(title, { id: opts.id, description: errorReason(err), duration: UNDO_MS, action: opts.action })
}

/**
 * Meta einer Mutation:
 *   errorTitle  – Titel des Fehler-Toasts («Nicht gespeichert»)
 *   quiet       – die Stelle zeigt den Fehler selbst (Feldfehler, eigener Toast)
 */
export interface FeedbackMeta { errorTitle?: string; quiet?: boolean; noRetry?: boolean }

declare module '@tanstack/react-query' {
  interface Register { mutationMeta: FeedbackMeta }
}

/**
 * Fehler jeder Mutation ohne eigene Anzeige → Fehler-Toast mit «Erneut
 * versuchen». Fehler mit Feldangaben (400 mit details) zeigt das Formular.
 */
export function mutationCacheWithToasts(): MutationCache {
  const cache: MutationCache = new MutationCache({
    onError: (err, variables, _ctx, mutation: Mutation<unknown, unknown, unknown, unknown>) => {
      const meta: FeedbackMeta = mutation.meta ?? {}
      // Sitzung abgelaufen: Der Anmeldedialog nennt, was nicht ausgeführt wurde (ein Toast läge
      // hinter dem Dialog und wäre weg, bevor jemand ihn liest)
      if (err instanceof ApiError && err.status === 401 && isSessionExpired()) {
        // Antwort 16: nicht zerstörerische Aktionen lassen sich nach der Anmeldung wiederholen
        noteFailedAction(meta.errorTitle ?? 'Aktion nicht ausgeführt', meta.noRetry ? undefined : () => mutation.execute(variables).catch(() => {}))
        return
      }
      if (meta.quiet) return
      // Bestätigung abgebrochen: bewusst so gewollt, kein Fehler-Toast
      if (err instanceof ApiError && err.code === 'sudo_cancelled') return
      const details = (err as { details?: unknown } | null)?.details
      if (Array.isArray(details) && details.length) return
      // «Erneut versuchen» nur, wo ein zweiter Versuch helfen kann (Server weg, 5xx) und nie bei
      // zerstörerischen Aktionen (meta.noRetry); bei 400/403/404/409 ändert Wiederholen nichts
      const status = err instanceof ApiError ? err.status : null
      const retryable = !meta.noRetry && (isUnreachable(err) || (status !== null && status >= 500))
      notifyError(meta.errorTitle ?? 'Aktion fehlgeschlagen', err, {
        action: retryable ? { label: 'Erneut versuchen', onClick: () => void mutation.execute(variables).catch(() => {}) } : undefined,
      })
    },
  })
  return cache
}

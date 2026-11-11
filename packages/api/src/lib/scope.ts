import { notFound } from './errors.js'

/**
 * M9: Für welche Umgebungen eine Abfrage gilt (SPEC «Umgebungen»,
 * Durchsetzung; docs/MILESTONE-9.md, Abschnitt 3).
 *
 * - env:     ein API-Token (REST und MCP) oder eine Liste in einer Umgebung –
 *            sieht und ändert nur diese eine Umgebung.
 * - session: eine Anmeldung in der Oberfläche – Einzelobjekte aller
 *            Umgebungen. Listen brauchen trotzdem eine Umgebung.
 * - server:  ein Server-Job (wöchentlicher Rescan, Ablauf, Auto-Deploy, …),
 *            immer mit Namen, damit jede Stelle ohne Umgebung auffindbar bleibt.
 *
 * Erzeugt nur über inEnvironment(), sessionScope() und serverJob().
 */
export type EnvScope = { readonly kind: 'env'; readonly envId: string }
export type SessionScope = { readonly kind: 'session' }
export type ServerScope = { readonly kind: 'server'; readonly job: string }
export type Scope = EnvScope | SessionScope | ServerScope
/** Listen: eine Umgebung oder ein Server-Job (nie «alles» für eine Anmeldung) */
export type ListScope = EnvScope | ServerScope

export const inEnvironment = (envId: string): EnvScope => ({ kind: 'env', envId })
export const sessionScope = (): SessionScope => ({ kind: 'session' })
export const serverJob = (job: string): ServerScope => ({ kind: 'server', job })

/** Darf dieser Scope ein Objekt der Umgebung envId sehen? */
export function allows(scope: Scope, envId: string | null | undefined): boolean {
  if (scope.kind !== 'env') return true
  return envId === scope.envId
}

/** Die eine Umgebung des Scopes; null für Anmeldung und Server-Jobs. */
export const scopeEnvId = (scope: Scope): string | null => (scope.kind === 'env' ? scope.envId : null)

/**
 * Objekt einer fremden Umgebung: dieselbe Meldung wie ein unbekanntes
 * Objekt – die Antwort verrät nicht, dass es existiert.
 */
export function assertAllowed(scope: Scope, envId: string | null | undefined, what: string): void {
  if (!allows(scope, envId)) throw notFound(what)
}

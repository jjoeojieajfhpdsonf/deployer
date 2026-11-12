import { EventEmitter } from 'node:events'

/**
 * UI-Qualität 3: Ereignisse für die Oberfläche (GET /api/v1/events, SSE).
 *
 * Nur Hinweise, *was* sich geändert hat – keine Daten. Die Oberfläche lädt
 * daraufhin gezielt nach (react-query invalidieren). So bleibt der Strom
 * frei von Inhalten, die eine Berechtigung bräuchten, und ein verpasstes
 * Ereignis kostet nur ein Nachladen beim Wiederverbinden.
 */
export type ServerEvent =
  /** Projekt angelegt, geändert, gelöscht oder Container-Zustand gewechselt */
  | { type: 'project'; projectId: string | null }
  /** Deploy-Schritt oder Ende */
  | { type: 'deploy'; deploymentId: string; status: string; projectId: string | null }
  /** Scan: Start, Stufe, Ende (Projekt oder externes Ziel) */
  | { type: 'scan'; phase: 'start' | 'stage' | 'end'; projectId: string | null; targetId?: string | null }
  /** Neuer Audit-Eintrag einer Änderung (reine Lesezugriffe nicht) */
  | { type: 'audit'; action: string; targetType: string | null; targetId: string | null }
  /** Zertifikat / Cloudflare-Einstellungen */
  | { type: 'cert' }
  /** Öffentlich: Schritt eines Übergangs (veröffentlichen, pausieren …) */
  | { type: 'public'; projectId: string }
  /** Etappe 3: neue Besucher-Zähler gespeichert (nach dem Flush, höchstens einmal pro Minute) */
  | { type: 'traffic'; projectIds: string[] }
  /**
   * Abgemeldet: session = nur Ströme dieser Sitzung schliessen; except = alle
   * ausser dieser (andere Sitzungen beendet); beides leer = alle.
   */
  | { type: 'session_ended'; session?: string | null; except?: string | null }
  /** Erste Zeile nach dem Verbinden */
  | { type: 'hello' }

const bus = new EventEmitter()
bus.setMaxListeners(0)

export function publish(e: ServerEvent): void {
  bus.emit('event', e)
}

export function subscribe(fn: (e: ServerEvent) => void): () => void {
  bus.on('event', fn)
  return () => bus.off('event', fn)
}

/** Anzahl offener Ströme (für Tests) */
export const subscriberCount = () => bus.listenerCount('event')

/** Reine Lesezugriffe (MCP get_/list_/read_…, Anmeldung): kein Grund, Oberflächen neu zu laden */
export const isReadOnlyAction = (action: string) => /^mcp\.(get_|list_|read_|export_)|^auth\.login$/.test(action)

/* --- Offene Ströme: beim Herunterfahren schliessen ----------------------------- */

const open = new Set<() => void>()

/**
 * Langlebige Antworten (SSE) melden hier ihr Ende an. Fastify schliesst beim
 * Herunterfahren nur ruhende Verbindungen; ohne das hinge app.close(), bis
 * Docker den Prozess abschiesst. Gibt die Abmeldung zurück.
 */
export function trackStream(end: () => void): () => void {
  open.add(end)
  return () => open.delete(end)
}

export function closeAllStreams(): void {
  for (const end of [...open]) end()
  open.clear()
}

/* --- Deploy → Projekt (die Pipeline meldet es beim Start) ------------------------ */

const deployProject = new Map<string, string>()
export const noteDeployProject = (deploymentId: string, projectId: string) => deployProject.set(deploymentId, projectId)
export const projectOfDeploy = (deploymentId: string) => deployProject.get(deploymentId) ?? null
export const forgetDeploy = (deploymentId: string) => deployProject.delete(deploymentId)

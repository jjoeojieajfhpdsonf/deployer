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
  | { type: 'deploy'; deploymentId: string; status: string; projectId?: string | null }
  /** Scan-Stufe, Start, Ende (Projekt oder externes Ziel) */
  | { type: 'scan'; projectId: string | null; targetId?: string | null }
  /** Neuer Audit-Eintrag (fast jede Änderung schreibt einen) */
  | { type: 'audit'; action: string; targetType: string | null; targetId: string | null }
  /** Zertifikat / Cloudflare-Einstellungen */
  | { type: 'cert' }
  // Öffentlich, Header-Prüfungen und Vorschläge von Claude schreiben einen Audit-Eintrag ('audit');
  // Statuswechsel von Vorschlägen hängen an Deploy und Nachscan ('deploy', 'scan').
  /** Abgemeldet bzw. Sitzung ungültig: offene Ströme schliessen (die Oberfläche prüft dann ihre Anmeldung) */
  | { type: 'session_ended' }
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

/** Anzahl offener Ströme (für /system und Tests) */
export const subscriberCount = () => bus.listenerCount('event')

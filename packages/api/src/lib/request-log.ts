/**
 * Stufe der Zugriffszeile im API-Log. Die Oberfläche fragt mehrere Endpunkte
 * alle paar Sekunden ab (scans/latest, health, deployments); auf info
 * verdrängten diese Zeilen alles andere. Erfolgreiche Lese-Anfragen gehen
 * deshalb auf debug; Änderungen, Fehler und langsame Antworten bleiben info,
 * Serverfehler warn.
 */
/** SSE-Routen (Ereignisse, Deploy-Fortschritt, Live-Logs, Zugriffe live, Besucher live) */
export const isStreamRoute = (url: string | undefined): boolean => Boolean(url && /\/(?:events|stream|traffic\/live)$/.test(url))

export function requestLogLevel(method: string, status: number, ms: number, stream = false): 'debug' | 'info' | 'warn' {
  if (status >= 500) return 'warn'
  if (status >= 400) return 'info'
  const read = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
  // UI-Qualität 3: Ereignisströme (SSE) dauern lange und enden bei jedem Tab-Wechsel – kein «langsam»
  if (read && stream) return 'debug'
  if (read && ms < 5_000) return 'debug'
  return 'info'
}

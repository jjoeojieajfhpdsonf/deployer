/**
 * Stufe der Zugriffszeile im API-Log. Die Oberfläche fragt mehrere Endpunkte
 * alle paar Sekunden ab (scans/latest, health, deployments); auf info
 * verdrängten diese Zeilen alles andere. Erfolgreiche Lese-Anfragen gehen
 * deshalb auf debug; Änderungen, Fehler und langsame Antworten bleiben info,
 * Serverfehler warn.
 */
export function requestLogLevel(method: string, status: number, ms: number): 'debug' | 'info' | 'warn' {
  if (status >= 500) return 'warn'
  if (status >= 400) return 'info'
  const read = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
  if (read && ms < 5_000) return 'debug'
  return 'info'
}

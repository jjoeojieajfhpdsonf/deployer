/**
 * Adressen-Prüfung vom Server aus.
 *
 * Läuft die Oberfläche über https, darf der Browser http-Adressen (nip.io)
 * nicht abfragen (Mixed Content) – er meldet dann «nicht erreichbar», obwohl
 * die Adresse geht. Deshalb fragt Airlock Caddy direkt, mit dem
 * Hostnamen im Host-Header. Getestet wird so Caddys Route samt Projekt, nicht
 * DNS oder der Weg vom Gerät.
 *
 * Mit IP-Filter sperrt Caddy Airlock selbst aus (seine Adresse im
 * Docker-Netz liegt weder im LAN noch im Tailnet). Die Sperrseite gibt es nur
 * für bekannte Namen: sie belegt, dass Caddy den Namen weiterleitet – nur die
 * Antwort des Projekts selbst bleibt dann ungeprüft.
 */

import type { AddressCheckDto } from '@airlock/shared'
import { probeUa } from './probe-ua.js'

/** Text der Sperrseite in caddy-config.ts (403 bei fremder Absenderadresse). */
const BLOCKED_PREFIX = 'Kein Zugriff von '
/** Text der Auffangroute in caddy-config.ts (404 bei unbekanntem Namen). */
const UNKNOWN_PREFIX = 'Kein Projekt unter diesem Namen'

/** Reine Auswertung einer Antwort von Caddy (testbar ohne Netz). */
export function interpretProbe(status: number, bodyStart: string): Omit<AddressCheckDto, 'url' | 'checkedAt'> {
  const body = bodyStart.trimStart()
  if (status === 403 && body.startsWith(BLOCKED_PREFIX)) {
    return { state: 'routed', detail: 'Caddy leitet den Namen weiter. Die Antwort des Projekts ist vom Server aus nicht prüfbar: der IP-Filter lässt nur LAN und Tailnet durch.' }
  }
  if (status === 404 && body.startsWith(UNKNOWN_PREFIX)) {
    return { state: 'unknown', detail: 'Caddy kennt diesen Namen nicht (keine Route).' }
  }
  if (status === 502 || status === 503 || status === 504) {
    return { state: 'down', detail: `Caddy erreicht das Projekt nicht (HTTP ${status}).` }
  }
  return { state: 'ok', detail: `Antwort HTTP ${status} über Caddy.` }
}

/** Nur der Hostname einer http(s)-URL, sonst null. */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Fragt Caddy (caddyAddr = "airlock-caddy:80", im Docker-Netz edge) mit
 * dem Namen im Host-Header.
 * Keine Weiterleitungen folgen; ein 3xx gilt als Antwort.
 */
export async function probeViaCaddy(caddyAddr: string, url: string, timeoutMs = 5_000): Promise<AddressCheckDto> {
  const checkedAt = new Date().toISOString()
  const host = hostOf(url)
  if (!host) return { url, state: 'error', detail: 'Keine gültige Adresse.', checkedAt }
  const { request } = await import('undici')
  try {
    const res = await request(`http://${caddyAddr}/`, {
      method: 'GET',
      // Direkt im Docker-Netz an Caddy, nie über die Host-Ports; Kennung für die Absender-Auswertung
      headers: { host, 'user-agent': probeUa('adresse') },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    })
    // Nur der Anfang zählt (Sperrseite/Auffangroute); eine grosse Seite nicht ganz laden.
    let bodyStart = ''
    try {
      for await (const chunk of res.body) {
        bodyStart += Buffer.from(chunk as Uint8Array).toString('utf8')
        if (bodyStart.length >= 200) break
      }
    } catch {
      /* Body egal, der Status zählt */
    } finally {
      res.body.destroy()
    }
    return { url, ...interpretProbe(res.statusCode, bodyStart), checkedAt }
  } catch (err) {
    return { url, state: 'error', detail: `Caddy vom Server aus nicht erreichbar: ${(err as Error).message}`, checkedAt }
  }
}

/**
 * Etappe 3 «Besucher und Herkunft»: Auswertung der Zugriffe eines Projekts
 * aus Caddys Zugriffs-Log – ohne Cookies, ohne Skript im Projekt, ohne
 * gespeicherte IP. Gespeichert werden nur Stundenzähler (Projekt, Stunde,
 * Zugang, Pfad, Land, Stadt, Referrer, Gerät, Status, Bot); eindeutige
 * Besucher zählt Airlock über einen Hash aus IP, User-Agent und einem
 * Tagessalz, das nur im Speicher liegt.
 *
 * Zugang heisst wie im Reiter «Aufbau» (TopologyWay): public = Internet
 * (über den Cloudflare-Tunnel), tailnet, lan = Heimnetz.
 */

import type { TopologyWay } from './topology.js'

export type TrafficWay = TopologyWay

export const TRAFFIC_WAYS: readonly TrafficWay[] = ['public', 'tailnet', 'lan'] as const

/** Bezeichnung des Zugangs in der Oberfläche (wie die Spalte «Zugang» im Aufbau) */
export const TRAFFIC_WAY_LABEL: Record<TrafficWay, string> = { public: 'Internet', tailnet: 'Tailnet', lan: 'Heimnetz' }

export const TRAFFIC_RANGES = [
  { key: '24h', label: '24 Std.', hours: 24, bucket: 'hour', within: 'in den letzten 24 Stunden' },
  { key: '7d', label: '7 Tage', hours: 7 * 24, bucket: 'day', within: 'in den letzten 7 Tagen' },
  { key: '30d', label: '30 Tage', hours: 30 * 24, bucket: 'day', within: 'in den letzten 30 Tagen' },
] as const
export type TrafficRange = (typeof TRAFFIC_RANGES)[number]['key']
export const isTrafficRange = (v: unknown): v is TrafficRange => TRAFFIC_RANGES.some((r) => r.key === v)
export const trafficRange = (v: unknown) => TRAFFIC_RANGES.find((r) => r.key === v) ?? TRAFFIC_RANGES[0]

/** Stundenzähler bleiben so viele Monate, danach löscht ein täglicher Job sie (SPEC: Datenschutz) */
export const TRAFFIC_RETENTION_MONTHS = 13

export type TrafficDevice = 'desktop' | 'mobile' | 'tablet'
export const TRAFFIC_DEVICE_LABEL: Record<TrafficDevice, string> = { desktop: 'Computer', mobile: 'Handy', tablet: 'Tablet' }

/** Ein Zeitpunkt der Kurve: Beginn der Stunde bzw. des Tages (Ortszeit) */
export interface TrafficPointDto {
  at: string
  views: number
  visitors: number
}

/** Eine Zeile einer Rangliste (Seite, Referrer, Land, Gerät) */
export interface TrafficRowDto {
  /** Pfad, Host des Referrers ('' = direkt), Ländercode ISO 3166-1 alpha-2 ('' = unbekannt, 'T1' = Tor), Gerät */
  key: string
  views: number
  visitors: number
}

export interface TrafficCityDto extends TrafficRowDto {
  /** Land der Stadt (alpha-2) */
  country: string
}

export interface TrafficStatusDto {
  status: number
  views: number
}

/**
 * Woher die Zahlen kommen. Fehlt etwas (Log nicht eingerichtet, keine
 * Städte-Datenbank), lässt die Oberfläche das Element weg statt zu raten.
 */
export interface TrafficSourceDto {
  /**
   * ok: Airlock liest Caddys Zugriffs-Log mit. waiting: eingerichtet, aber
   * die Datei fehlt noch (Caddy hat noch nichts geschrieben oder das Volume
   * ist nicht eingehängt). off: nicht eingerichtet (ACCESS_LOG_DIR leer).
   */
  ingest: 'ok' | 'waiting' | 'off'
  /** Ältester gespeicherter Zähler des Projekts (ISO) – davor gibt es keine Zahlen */
  since: string | null
  /** DB-IP «IP to City Lite» (CC BY 4.0): Stand der Datei als «JJJJ-MM»; null = keine Datei, nur Länder */
  cityDb: string | null
}

export interface TrafficSummaryDto {
  range: TrafficRange
  way: TrafficWay | 'all'
  from: string
  to: string
  bucket: 'hour' | 'day'
  totals: { views: number; visitors: number; bots: number }
  /** Nach Zugang, immer über alle Wege (für die Umschalter) */
  ways: { way: TrafficWay; views: number; visitors: number }[]
  series: TrafficPointDto[]
  pages: TrafficRowDto[]
  referrers: TrafficRowDto[]
  countries: TrafficRowDto[]
  cities: TrafficCityDto[]
  devices: TrafficRowDto[]
  statuses: TrafficStatusDto[]
  source: TrafficSourceDto
}

/** Aufrufe heute (seit Mitternacht Ortszeit) je Projekt-ID, für die Projektliste */
export interface TrafficTodayDto {
  /** Nur Projekte mit Aufrufen heute; fehlt eines, waren es 0 (sofern ingest 'ok') */
  views: Record<string, number>
  /** Zählt Airlock überhaupt mit? Sonst zeigt die Liste keine Zahl (statt einer falschen 0) */
  ingest: TrafficSourceDto['ingest']
}

/**
 * Live-Strom (GET /api/v1/projects/:id/traffic/live, Server-Sent Events):
 * pro Anfrage an einen Namen des Projekts ein Ereignis `data: {…}`, ohne
 * IP, ohne Pfad, ohne User-Agent. Eigene Prüfungen von Airlock
 * («airlock-probe») fehlen; alles andere kommt, auch Bots, statische Dateien
 * und vom IP-Filter gesperrte Anfragen (blocked). Gedacht für die Animation
 * im Reiter «Aufbau» (Etappe 4): host und service passen zu den Knoten
 * `host:<host>` und `svc:<service>` von GET /topology, access zu `way:<access>`.
 */
export interface TrafficLiveEventDto {
  /** Zeitpunkt der Anfrage (ISO, von Caddy) */
  at: string
  /** Zugang: public (über den Tunnel), tailnet, lan */
  access: TrafficWay
  /** Angefragter Name (ohne Port) */
  host: string
  /** Dienst, an den Caddy weiterleitet (Name wie im Aufbau); null bei Pause-Seite oder unbekannt */
  service: string | null
  /** HTTP-Status der Antwort */
  status: number
  /** Vom IP-Filter von Caddy abgewiesen (403 am Eingang, erreichte den Dienst nie) */
  blocked: boolean
  /** User-Agent als Bot erkannt (isbot) */
  bot: boolean
}

/** Ländername auf Deutsch aus dem Code (Intl); '' → «Unbekannt», T1 → «Tor-Netz» */
export function countryName(code: string, locale = 'de-CH'): string {
  if (!code) return 'Unbekannt'
  if (code === 'T1') return 'Tor-Netz'
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

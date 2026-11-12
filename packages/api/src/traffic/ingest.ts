import type { TrafficLiveEventDto } from '@airlock/shared'
import { hourOf, type TrafficAggregator } from './aggregate.js'
import { countryOf, deviceOf, isAsset, normalizePath, referrerOf, verdictOf, wayOf } from './classify.js'
import { parseAccessLine } from './parse.js'
import type { VisitorCounter } from './visitor.js'

/**
 * Herzstück des Ingest: eine Log-Zeile → Live-Ereignis und Zähler. Ohne
 * Datenbank und Dateien (die hängt service.ts dran), damit die ganze Kette
 * testbar bleibt (ingest.test.ts).
 */

/** Was Airlock zu einem Namen weiss (aus Routen und Projekt) */
export interface HostInfo {
  projectId: string
  /** Öffentlicher Name (nur über den Tunnel erreichbar) */
  public: boolean
  /** Dienst, an den Caddy weiterleitet (wie im Aufbau); null: Pause-Seite */
  service: string | null
  /** Healthcheck-Pfad des Projekts */
  healthPath: string | null
  /** Alle Namen des Projekts (Referrer von dort = Navigation innerhalb der Seite) */
  ownHosts: ReadonlySet<string>
}

export interface ProcessorDeps {
  aggregator: TrafficAggregator
  visitors: VisitorCounter
  hosts: () => ReadonlyMap<string, HostInfo>
  /** Stadt/Land zu einer öffentlichen IP (DB-IP); null ohne Datei */
  city: (ip: string) => { city: string; country: string } | null
  /** Projekte mit HTML-Seiten (statische Dateien zählen dort nicht als Aufruf) */
  hasPages: Set<string>
  emit: (projectId: string, e: TrafficLiveEventDto) => void
  /** Nacht 3, Etappe 5: jede fremde Anfrage (ohne eigene Prüfungen) für «Scan von aussen» */
  observe?: (projectId: string, a: { at: number; path: string; status: number; source: string }) => void
}

export type HandleResult = 'unknown' | 'ignore' | 'live' | 'bot' | 'page'

export class TrafficProcessor {
  constructor(private readonly d: ProcessorDeps) {}

  handle(line: string): HandleResult {
    const a = parseAccessLine(line)
    if (!a) return 'unknown'
    const host = this.d.hosts().get(a.host)
    if (!host) return 'unknown'
    const projectId = host.projectId
    const verdict = verdictOf(a, { healthPath: host.healthPath, hasPages: this.d.hasPages.has(projectId) })
    if (verdict === 'ignore') return 'ignore'
    this.d.observe?.(projectId, { at: a.at, path: a.path, status: a.status, source: a.ip })
    const way = wayOf(a.ip, host.public)
    const bot = verdict === 'bot'
    // Live: jede Anfrage ausser eigenen Prüfungen, ohne IP, Pfad und User-Agent
    this.d.emit(projectId, {
      at: new Date(a.at).toISOString(),
      access: way,
      host: a.host,
      service: a.blocked ? null : host.service,
      status: a.status,
      blocked: a.blocked,
      bot,
    })
    if (verdict === 'live') return 'live'
    const hour = hourOf(a.at)
    if (bot) {
      this.d.aggregator.add({ projectId, hour, way, path: '', country: '', city: '', referrer: '', device: '', status: a.status, bot: true })
      return 'bot'
    }
    // Erste HTML-Seite gesehen: ab jetzt zählen statische Dateien nicht mehr
    if (!isAsset(a.path, a.contentType) && a.status < 400) this.d.hasPages.add(projectId)
    let country = ''
    let city = ''
    if (way === 'public') {
      country = countryOf(a.country)
      const c = this.d.city(a.ip)
      if (c) {
        city = c.city
        if (!country) country = c.country
      }
    }
    const first = this.d.visitors.firstToday(projectId, a.ip, a.userAgent, a.at)
    this.d.aggregator.add({
      projectId, hour, way,
      path: normalizePath(a.path),
      country, city,
      referrer: referrerOf(a.referer, a.query, host.ownHosts),
      device: deviceOf(a.userAgent),
      status: a.status,
      bot: false,
    }, { views: 1, visitors: first ? 1 : 0 })
    return 'page'
  }
}

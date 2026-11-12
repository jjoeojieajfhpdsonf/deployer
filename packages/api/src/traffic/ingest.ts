import { TRAFFIC_SEP, UNKNOWN_VALUE, isOkStatus, type TrafficLiveEventDto } from '@airlock/shared'
import { hourOf, type TrafficAggregator, type TrafficDimAggregator, type TrafficDimKey } from './aggregate.js'
import { browserOf, campaignOf, languageOf, systemOf } from './agent.js'
import { countryOf, deviceOf, isAsset, normalizePath, referrerOf, verdictOf, wayOf } from './classify.js'
import { parseAccessLine, type AccessLine } from './parse.js'
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
  /** Merkmale (Sprache, Browser, System, Netz, Kampagne, Einstieg, Ausstieg); ohne: keine Merkmale */
  dims?: TrafficDimAggregator
  visitors: VisitorCounter
  hosts: () => ReadonlyMap<string, HostInfo>
  /** Stadt/Land zu einer öffentlichen IP (DB-IP); null ohne Datei */
  city: (ip: string) => { city: string; country: string } | null
  /** Netz zu einer öffentlichen IP (DB-IP ASN); null ohne Datei */
  asn?: (ip: string) => { asn: number; name: string } | null
  /** Projekte mit HTML-Seiten (statische Dateien zählen dort nicht als Aufruf) */
  hasPages: Set<string>
  emit: (projectId: string, e: TrafficLiveEventDto) => void
  /** Eine gezählte Zeile eines Projekts gesehen (Messbeginn) */
  measured?: (projectId: string, at: number) => void
  /** Cloudflare liefert Städte (cf-ipcity) */
  cfLocation?: () => void
  /** Zugriffe neu: jede gelesene Anfrage auf einen bekannten Namen (Reiter «Zugriffe» live, Docker-Netz-Warnung) */
  tap?: (a: AccessLine, host: HostInfo) => void
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
    // Zugriffe neu: jede Anfrage auf einen Namen des Projekts, auch eigene Prüfungen
    this.d.tap?.(a, host)
    const way = wayOf(a.ip, host.public)
    // Netz nur für Internet-Anfragen (Tailnet und Heimnetz haben private Adressen)
    const net = way === 'public' ? (this.d.asn?.(a.ip) ?? null) : null
    const verdict = verdictOf(a, { healthPath: host.healthPath, hasPages: this.d.hasPages.has(projectId), asn: net?.asn ?? null })
    if (verdict === 'ignore') return 'ignore'
    // Nacht 3, Etappe 5: jede fremde Anfrage (ohne eigene Prüfungen) für «Scan von aussen»
    this.d.observe?.(projectId, { at: a.at, path: a.path, status: a.status, source: a.ip })
    this.d.measured?.(projectId, a.at)
    const bot = verdict === 'bot'
    const page = verdict === 'page'

    // Herkunft: Land von Cloudflare, Stadt aus Cloudflares Kopfzeilen (falls eingeschaltet), sonst aus DB-IP
    let country = ''
    let city = ''
    if (page && way === 'public') {
      country = countryOf(a.country)
      if (a.cfCity) {
        city = a.cfCity
        this.d.cfLocation?.()
      } else {
        const c = this.d.city(a.ip)
        if (c) {
          city = c.city
          if (!country) country = c.country
        }
      }
    }
    const path = normalizePath(a.path)

    // Live: jede Anfrage ausser eigenen Prüfungen, ohne IP und User-Agent; Pfad und Herkunft nur bei Seitenaufrufen
    this.d.emit(projectId, {
      at: new Date(a.at).toISOString(),
      access: way,
      host: a.host,
      service: a.blocked ? null : host.service,
      status: a.status,
      blocked: a.blocked,
      bot,
      page,
      ...(page ? { path } : {}),
      ...(country ? { country } : {}),
      ...(city ? { city } : {}),
    })
    if (verdict === 'live') return 'live'
    const hour = hourOf(a.at)
    if (bot) {
      this.d.aggregator.add({ projectId, hour, way, path: '', country: '', city: '', referrer: '', device: '', status: a.status, bot: true })
      if (net) this.d.dims?.add({ projectId, hour, way, dim: 'asn', value: `${net.asn} ${net.name}`, bot: true })
      return 'bot'
    }
    // Erste HTML-Seite gesehen: ab jetzt zählen statische Dateien nicht mehr
    if (!isAsset(a.path, a.contentType) && a.status < 400) this.d.hasPages.add(projectId)

    // Besucher und Besuche nur bei erfolgreichen Aufrufen (wer nur 404 sieht, ist kein Besucher)
    const ok = isOkStatus(a.status)
    const seen = ok
      ? this.d.visitors.see(projectId, a.ip, a.userAgent, a.at, { path, way, track: !a.optOut })
      : { first: false, entry: false }
    const visitors = seen.first ? 1 : 0
    this.d.aggregator.add({
      projectId, hour, way, path, country, city,
      referrer: referrerOf(a.referer, a.query, host.ownHosts),
      device: deviceOf(a.userAgent),
      status: a.status,
      bot: false,
    }, { views: 1, visitors })

    const dims = this.d.dims
    if (ok && dims) {
      const base = { projectId, hour, way, bot: false }
      const add = (dim: TrafficDimKey['dim'], value: string) => dims.add({ ...base, dim, value }, { views: 1, visitors })
      // Unbekannt als «?», damit die Anteile auf alle Aufrufe aufgehen
      add('lang', languageOf(a.acceptLanguage) || UNKNOWN_VALUE)
      add('browser', browserOf(a.userAgent, a.chUa) || UNKNOWN_VALUE)
      add('os', systemOf(a.userAgent, a.chPlatform, a.chPlatformVersion) || UNKNOWN_VALUE)
      if (net) add('asn', `${net.asn} ${net.name}`)
      const utm = campaignOf(a.query)
      if (utm) add('utm', [utm.source, utm.medium, utm.campaign].join(TRAFFIC_SEP))
      if (seen.entry) add('entry', path)
    }
    this.flushEnded()
    return 'page'
  }

  /** Beendete Besuche als Ausstieg zählen */
  private flushEnded(): void {
    const dims = this.d.dims
    for (const e of this.d.visitors.takeEnded()) {
      dims?.add({ projectId: e.projectId, hour: hourOf(e.at), way: e.way, dim: 'exit', value: e.path, bot: false })
    }
  }

  /** Besuche ohne Aufruf seit 30 Min. beenden (Job, jede Minute vor dem Flush) */
  sweep(now = Date.now()): void {
    this.d.visitors.sweep(now)
    this.flushEnded()
  }

  /** Beim Herunterfahren: offene Besuche als beendet zählen */
  closeAll(): void {
    this.d.visitors.closeAll()
    this.flushEnded()
  }
}

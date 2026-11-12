/**
 * Reiter «Zugriffe» (neu): einzelne Anfragen aus Caddys Zugriffs-Log
 * (visits.log im Volume caddy_access, 2 Tage). Hier liegen die DTOs und alle
 * reinen Regeln, die Oberfläche und API teilen: Einteilung nach Status,
 * Herkunft, Zusammenfassen gleicher Aufrufe, Erklärungen bei Auffälligem
 * und die Warnung «Docker-Netz abgewiesen». Getestet in
 * packages/api/src/traffic/access-rules.test.ts.
 *
 * Datenschutz: Die API liefert die Absenderadresse nur gekürzt
 * (192.168.1.x), Header nur ausgewählt und gekürzt – nie Cookie oder
 * Authorization.
 */

import { DATACENTER_ASNS, TRAFFIC_WAY_LABEL, isScannerPath, type TrafficDevice, type TrafficWay } from './traffic.js'

/* --- Daten ------------------------------------------------------------------ */

/**
 * Sperre von Airlock: IP-Filter (Caddy, X-Airlock-Block: ip-filter), Pause
 * (Pause-Seite, X-Airlock-State: paused), Rate-Limit (429 am CSP-Endpunkt),
 * other: X-Airlock-Block mit unbekanntem Wert.
 */
export type AccessBlock = 'ip-filter' | 'pause' | 'rate-limit' | 'other'
export const ACCESS_BLOCK_LABEL: Record<AccessBlock, string> = { 'ip-filter': 'IP-Filter', pause: 'Pause', 'rate-limit': 'Rate-Limit', other: 'Airlock' }

export interface AccessNetworkDto {
  asn: number
  /** Name laut DB-IP («Init7 (Switzerland) Ltd.») */
  name: string
  /** Rechenzentrum (DATACENTER_ASNS): «vermutlich Bot» */
  datacenter: boolean
}

export interface AccessEntryDto {
  /** Stabile Kennung innerhalb des Logs (Zeit und Position), für Auswahl und Adresse */
  id: string
  at: string
  method: string
  host: string
  /** Pfad ohne Query (die kann Tokens enthalten) */
  path: string
  status: number
  /** Von Airlock abgewiesen (sonst null) */
  block: AccessBlock | null
  /** Zugang wie im Aufbau: public = Internet (Tunnel), tailnet, lan = Heimnetz */
  way: TrafficWay
  /** Absender im Docker-Netz (172.16.0.0/12): ein Gateway, nicht das Gerät */
  dockerNet: boolean
  /** Absender gekürzt: «192.168.1.x», «2a02:1210:4e3a:…» */
  ip: string
  /** Land (alpha-2, nur über den Tunnel), '' unbekannt */
  country: string
  /** Stadt (Cloudflare-Kopfzeilen oder DB-IP), '' unbekannt */
  city: string
  /** Netz (DB-IP ASN, nur Internet); null ohne Datei oder Treffer */
  network: AccessNetworkDto | null
  /** «Safari 18», '' unbekannt */
  browser: string
  /** «iOS 18», '' unbekannt */
  system: string
  device: TrafficDevice
  /** Erste Sprache aus Accept-Language («de-CH»), '' ohne */
  language: string
  /** Referrer ohne Query und Fragment, '' ohne */
  referrer: string
  /** «HTTP/2» */
  proto: string
  /** «TLS 1.3», '' ohne TLS (Tunnel endet vor Caddy, nip.io über HTTP) */
  tls: string
  durationMs: number | null
  bytes: number | null
  /** ua: User-Agent sagt Bot (oder fehlt); datacenter: Browser aus einem Rechenzentrum; null: Mensch */
  bot: 'ua' | 'datacenter' | null
  /** Eigene Prüfung von Airlock (User-Agent «airlock-probe …») */
  probe: boolean
  /** Bekannter Scanner-Pfad (SCANNER_PATHS) */
  scanner: boolean
  /** Ausgewählte Header, gekürzt (user-agent, accept-language, sec-fetch-*, x-airlock-block) */
  headers: [string, string][]
}

export interface AccessListDto {
  /** Neueste zuerst */
  entries: AccessEntryDto[]
  since: string
  /** Liest Airlock das Zugriffs-Log? ok, waiting (Datei fehlt noch), off (nicht eingerichtet) */
  ingest: 'ok' | 'waiting' | 'off'
  /** Mehr Einträge im Zeitraum, als geliefert (die neuesten ACCESS_MAX) */
  capped: boolean
  error: string | null
}

/** Höchstens so viele Einträge je Abruf */
export const ACCESS_MAX = 5000

/* --- Status ------------------------------------------------------------------ */

export type AccessKind = 'ok' | 'redirect' | 'not-found' | 'blocked' | 'client' | 'error'

/** Wort zum Status, damit die Farbe nie allein steht */
export const ACCESS_KIND_WORD: Record<AccessKind, string> = {
  ok: 'ok', redirect: 'umgeleitet', 'not-found': 'nicht gefunden', blocked: 'abgewiesen', client: 'Clientfehler', error: 'Fehler',
}

export function accessKind(e: Pick<AccessEntryDto, 'status' | 'block'>): AccessKind {
  if (e.block) return 'blocked'
  if (e.status >= 500) return 'error'
  if (e.status === 404) return 'not-found'
  if (e.status >= 400) return 'client'
  if (e.status >= 300) return 'redirect'
  return 'ok'
}

export const ACCESS_STATUS_FILTERS = [
  { key: 'alle', label: 'Alle', hint: 'Alle Anfragen' },
  { key: 'erfolg', label: 'Erfolg', hint: 'Status 2xx und 3xx' },
  { key: 'nicht-gefunden', label: 'Nicht gefunden', hint: 'Status 404' },
  { key: 'abgewiesen', label: 'Abgewiesen', hint: 'Sperren von Airlock: IP-Filter, Pause, Rate-Limit' },
  { key: 'fehler', label: 'Fehler', hint: 'Status 5xx' },
] as const
export type AccessStatusFilter = (typeof ACCESS_STATUS_FILTERS)[number]['key']
export const isAccessStatusFilter = (v: unknown): v is AccessStatusFilter => ACCESS_STATUS_FILTERS.some((f) => f.key === v)

export function matchesStatus(e: Pick<AccessEntryDto, 'status' | 'block'>, f: AccessStatusFilter): boolean {
  const k = accessKind(e)
  if (f === 'alle') return true
  if (f === 'erfolg') return k === 'ok' || k === 'redirect'
  if (f === 'nicht-gefunden') return k === 'not-found'
  if (f === 'abgewiesen') return k === 'blocked'
  return k === 'error'
}

/* --- Herkunft ---------------------------------------------------------------- */

/** IPv4 im Docker-Bereich 172.16.0.0/12 (auch als ::ffff:-Adresse, auch gekürzt «172.25.0.x») */
export function isDockerNet(ip: string): boolean {
  return /^(?:::ffff:)?172\.(?:1[6-9]|2\d|3[01])\./.test(ip)
}

/** Netzname ohne Rechtsform und Klammern: «Init7 (Switzerland) Ltd.» → «Init7» */
export function providerShort(n: Pick<AccessNetworkDto, 'asn' | 'name'>): string {
  const known = DATACENTER_ASNS[n.asn]
  if (known) return known
  let s = n.name.replace(/\s*\([^)]*\)/g, '').trim()
  for (let i = 0; i < 2; i++) {
    s = s.replace(/[,]?\s+(?:LLC|L\.L\.C\.|Ltd\.?|Limited|AG|GmbH|Inc\.?|S\.?A\.?S?|B\.?V\.?|S\.r\.l\.|Corp\.?|Corporation|plc|Co\.?|KG|SE|Oy|AB|AS|A\/S)$/i, '').trim()
  }
  return s || n.name
}

/** Gerät für Tailnet und Heimnetz (Airlock kennt die Gerätenamen nicht): aus System und Gerätetyp */
export function deviceName(system: string, device: TrafficDevice): string {
  if (system.startsWith('iOS')) return device === 'tablet' ? 'iPad' : 'iPhone'
  if (system === 'macOS') return 'Mac'
  if (system.startsWith('Windows')) return 'Windows-PC'
  if (system.startsWith('Android')) return device === 'tablet' ? 'Android-Tablet' : 'Android-Handy'
  if (system === 'ChromeOS') return 'Chromebook'
  if (system === 'Linux') return 'Linux-Rechner'
  return ''
}

/** Herkunft für Tabelle und Detail: Ort (Zugang bzw. Docker-Netz) und Zusatz (Provider, Gerät oder Adresse) */
export function accessOrigin(e: Pick<AccessEntryDto, 'way' | 'dockerNet' | 'ip' | 'network' | 'city' | 'system' | 'device'>): { place: string; detail: string } {
  if (e.dockerNet) return { place: 'Docker-Netz', detail: e.ip }
  if (e.way === 'public') return { place: TRAFFIC_WAY_LABEL.public, detail: e.network ? providerShort(e.network) : e.city }
  return { place: TRAFFIC_WAY_LABEL[e.way], detail: deviceName(e.system, e.device) || e.ip }
}

/** Kennzeichen in der Tabelle: «Bot» (User-Agent), «Bot?» (Rechenzentrum oder Scanner-Pfad), sonst null */
export function botLabel(e: Pick<AccessEntryDto, 'bot' | 'scanner'>): 'Bot' | 'Bot?' | null {
  if (e.bot === 'ua') return 'Bot'
  if (e.bot === 'datacenter' || e.scanner) return 'Bot?'
  return null
}

/** Browser ohne Version für die Tabelle: «Safari 18» → «Safari» */
export const browserFamily = (browser: string): string => browser.replace(/\s+\d+$/, '')

/* --- Zusammenfassen ------------------------------------------------------------ */

/** Gleiche Aufrufe innerhalb dieser Spanne werden eine Zeile */
export const ACCESS_GROUP_WINDOW_MS = 5 * 60_000

export interface AccessGroup {
  /** Kennung des neuesten Eintrags */
  id: string
  /** Neueste zuerst */
  entries: AccessEntryDto[]
}

/** Gleiche Herkunft: Zugang, Docker-Netz, Land, Netz; ohne Netz (Tailnet, Heimnetz) die gekürzte Adresse; Bot getrennt */
export function originKey(e: Pick<AccessEntryDto, 'way' | 'dockerNet' | 'country' | 'network' | 'ip' | 'bot'>): string {
  return [e.way, e.dockerNet ? 'docker' : '', e.country, e.network?.asn ?? '', e.way === 'public' && e.network ? '' : e.ip, e.bot ?? ''].join('|')
}

/**
 * Zusammenfassen (rein): gleiche Methode und Pfad, gleicher Status (und
 * Sperre), gleicher Zugang und gleiche Herkunft innerhalb von 5 Minuten,
 * gemessen ab dem neuesten Aufruf der Gruppe. Eingabe und Ausgabe neueste
 * zuerst; eine Gruppe steht an der Stelle ihres neuesten Aufrufs.
 */
export function groupAccess(entries: readonly AccessEntryDto[], windowMs = ACCESS_GROUP_WINDOW_MS): AccessGroup[] {
  const open = new Map<string, { group: AccessGroup; newest: number }>()
  const out: AccessGroup[] = []
  for (const e of entries) {
    const key = `${e.method} ${e.path}|${e.status}|${e.block ?? ''}|${originKey(e)}`
    const at = Date.parse(e.at)
    const cur = open.get(key)
    if (cur && cur.newest - at <= windowMs) {
      cur.group.entries.push(e)
      continue
    }
    const group: AccessGroup = { id: e.id, entries: [e] }
    open.set(key, { group, newest: at })
    out.push(group)
  }
  return out
}

/** Einzeln anzeigen: jede Anfrage eine Gruppe */
export const singleGroups = (entries: readonly AccessEntryDto[]): AccessGroup[] => entries.map((e) => ({ id: e.id, entries: [e] }))

/* --- Erklärungen ------------------------------------------------------------- */

/** Anleitung «Tailscale als Subnet-Router» (docs/INSTALL.md im Repository) */
export const GATEWAY_GUIDE_URL = 'https://github.com/jjoeojieajfhpdsonf/deployer/blob/main/docs/INSTALL.md#tailscale-als-subnet-router'

export type AccessHintKind = 'gateway' | 'scanner' | 'datacenter'

export interface AccessHint {
  kind: AccessHintKind
  /** warn: etwas prüfen; info: einordnen */
  tone: 'warn' | 'info'
  title: string
  text: string
  link?: { href: string; label: string }
}

/**
 * Erklärungen zu einer Anfrage (rein, getestet):
 * - Absender im Docker-Netz und vom IP-Filter (oder Rate-Limit) abgewiesen:
 *   Tailnet-Verkehr wird maskiert (docs/INSTALL.md, ts-docker-nosnat).
 * - Scanner-Pfad: harmlos, solange 404 oder abgewiesen – sonst prüfen.
 * - Rechenzentrum: vermutlich Bot.
 */
export function accessHints(e: Pick<AccessEntryDto, 'dockerNet' | 'block' | 'path' | 'status' | 'network' | 'scanner'>): AccessHint[] {
  const out: AccessHint[] = []
  if (e.dockerNet && e.block && e.block !== 'pause') {
    out.push({
      kind: 'gateway',
      tone: 'warn',
      title: 'Tailnet-Verkehr wird maskiert – Regel ts-docker-nosnat prüfen',
      text: 'Der Absender ist das Docker-Gateway, nicht dein Gerät. Das passiert, wenn Tailscale als Subnet-Router den Verkehr aus dem Tailnet umschreibt: Der IP-Filter kennt die echte Adresse nicht und weist ab.',
      link: { href: GATEWAY_GUIDE_URL, label: 'Anleitung' },
    })
  }
  if (e.scanner || isScannerPath(e.path)) {
    const harmless = e.status === 404 || e.block !== null
    out.push(harmless
      ? { kind: 'scanner', tone: 'info', title: 'Typischer Scanner-Aufruf, harmlos solange 404', text: 'Bots suchen solche Pfade auf jeder Adresse im Internet nach bekannten Lücken. Die Seite hat nichts geliefert.' }
      : { kind: 'scanner', tone: 'warn', title: `Typischer Scanner-Aufruf – Antwort ${e.status}`, text: 'Bots suchen solche Pfade nach bekannten Lücken. Hier kam keine 404 zurück: prüfen, ob unter diesem Pfad etwas offen liegt.' })
  }
  if (e.network?.datacenter) {
    out.push({ kind: 'datacenter', tone: 'info', title: 'Aus einem Rechenzentrum – vermutlich Bot', text: `Das Netz von ${providerShort(e.network)} gehört einem Hoster. Menschen am Browser kommen selten von dort, Crawler und Scanner oft.` })
  }
  return out
}

/* --- Warnung in Server › Übersicht (Netz) ------------------------------------- */

export const DOCKER_BLOCK_WINDOW_MS = 60 * 60_000
/** Mehr als so viele Abweisungen aus dem Docker-Netz in einer Stunde → Warnung */
export const DOCKER_BLOCK_THRESHOLD = 3

export interface DockerBlockWarningDto {
  /** Abweisungen aus dem Docker-Netz in der letzten Stunde (Projekt-Routen) */
  count: number
  /** Betroffene Namen (höchstens 4, häufigste zuerst) */
  hosts: string[]
  /** Letzte Abweisung (ISO) */
  last: string
}

/** Rein: mehr als 3 Abweisungen aus dem Docker-Netz innerhalb einer Stunde? Sonst null. */
export function dockerBlockWarning(events: readonly { at: number; host: string }[], now: number): DockerBlockWarningDto | null {
  const recent = events.filter((e) => e.at > now - DOCKER_BLOCK_WINDOW_MS && e.at <= now)
  if (recent.length <= DOCKER_BLOCK_THRESHOLD) return null
  const count = new Map<string, number>()
  for (const e of recent) count.set(e.host, (count.get(e.host) ?? 0) + 1)
  return {
    count: recent.length,
    hosts: [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([h]) => h),
    last: new Date(Math.max(...recent.map((e) => e.at))).toISOString(),
  }
}

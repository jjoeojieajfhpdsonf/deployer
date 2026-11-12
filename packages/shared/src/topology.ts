/**
 * Reiter «Aufbau»: wie ein Projekt zusammenhängt – Zugang (Internet,
 * Tailnet, Heimnetz), Eingang (je Host eine Caddy-Route), Dienste (Compose
 * oder der eine Container) und Daten (Datenbank-Dienste, benannte Volumes).
 * GET /projects/:id/topology liefert es fertig zusammengefasst; die
 * Oberfläche ordnet nur noch in Spalten und zeichnet die Linien.
 *
 * Nichts davon ist erfunden: Was Docker oder die Routen nicht sagen
 * (Grösse eines Volumes, Backup), bleibt null bzw. fehlt.
 */

import type { ServiceChangeDto, ServiceEditWay } from './services.js'

export type TopologyWay = 'public' | 'tailnet' | 'lan'

/** Datenbanken, an ihrem Image erkannt */
export type DatabaseKind = 'postgres' | 'mysql' | 'mariadb' | 'redis' | 'mongo'

/**
 * Zustand eines Dienstes:
 * running – läuft (healthy: Docker-Healthcheck bestanden, unhealthy: gescheitert, starting: noch offen)
 * restarting – Docker startet ihn gerade neu (meist: er stürzt ab)
 * exited – beendet (exitCode), stopped – Projekt gestoppt, missing – Container fehlt,
 * static – statische Seite, Caddy liefert die Dateien selbst aus (kein Container)
 */
export type TopologyServiceState = 'running' | 'restarting' | 'exited' | 'stopped' | 'missing' | 'static'
export type TopologyHealth = 'healthy' | 'unhealthy' | 'starting' | null

export interface TopologyAccessDto {
  /** «way:public» usw. */
  id: string
  way: TopologyWay
  /** Ist das Projekt über diesen Weg erreichbar? */
  on: boolean
  /** Nur öffentlich: pausiert (Name bleibt, Caddy zeigt die Pause-Seite) */
  paused: boolean
  /** Bereich des Wegs (z. B. 192.168.1.0/24) bzw. bei Internet die Art (Cloudflare Access) */
  detail: string | null
}

export interface TopologyHostDto {
  /** «host:<hostname>» */
  id: string
  hostname: string
  url: string
  /** Über welche Wege der Name führt */
  ways: TopologyWay[]
  /** nip.io-Ausweich neben dem Hauptnamen (ohne lokalen DNS) */
  fallback: boolean
  /** Security-Header, die Caddy an diesem Host setzt (eigene Regeln und Vorlagen der Umgebung) */
  headers: number
  /** https: Zertifikat von Airlock (Caddy), cloudflare: TLS macht Cloudflare, http: ohne TLS */
  tls: 'https' | 'cloudflare' | 'http'
  /** Problem des Zertifikats (abgelaufen, Probelauf …); null = in Ordnung oder unbekannt */
  tlsProblem: string | null
  accessProtected: boolean
  /** Etappe 4: eigene interne Adresse eines Dienstes (x-airlock-internal, z. B. Adminer) – nie öffentlich */
  internal?: boolean
  paused: boolean
  /** Dienst, an den Caddy weiterleitet (Id); null: keiner */
  service: string | null
}

export interface TopologyServiceDto {
  /** «svc:<name>» */
  id: string
  name: string
  /** Image wie in compose.yaml bzw. am Container; null bei statischen Seiten */
  image: string | null
  /** Port im Container (Web-Dienst: Port des Projekts; sonst expose bzw. EXPOSE des Images) */
  port: number | null
  state: TopologyServiceState
  health: TopologyHealth
  exitCode: number | null
  /** Tag des Images bzw. bei selbst gebauten Images die Fassung (Commit) */
  version: string | null
  /** Dienst, an den die Routen gehen */
  web: boolean
  /** Einmal-Dienst (restart: no / on-failure): beendet ist dann normal */
  oneShot: boolean
  database: DatabaseKind | null
  /** Momentaufnahme: CPU in Kernen, RAM in MB; null = läuft nicht oder nicht lesbar */
  usage: { cpu: number; memMb: number } | null
  /** Benannte Volumes (Ids), die der Dienst einhängt */
  volumes: string[]
}

export interface TopologyVolumeDto {
  /** «vol:<name>» */
  id: string
  /** Name in compose.yaml (bzw. am Container) */
  name: string
  /** Wo es eingehängt ist (erster Dienst) */
  mountPath: string | null
  /** Belegter Platz; null: über den Socket-Proxy nicht lesbar (Docker nennt die Grösse nur in /system/df) */
  sizeBytes: number | null
  /** Dienste (Ids), die es einhängen */
  usedBy: string[]
  /** Pfad im Container je Dienst (Id → Pfad) */
  paths: Record<string, string>
}

export interface TopologyEdgeDto {
  from: string
  to: string
  /** false: gestrichelt (Weg aus, Dienst gestoppt, Route pausiert) */
  on: boolean
  /** route: Zugang → Host → Dienst; depends_on/network: Dienst → Datenbank; mount: Dienst → Volume */
  via: 'route' | 'depends_on' | 'network' | 'mount'
}

export interface TopologyDto {
  /** external: Bestehender Dienst – nur Zugang → Eingang → Ziel, keine Dienste von Airlock */
  kind: 'image' | 'dockerfile' | 'static' | 'compose' | 'external'
  /** Bestehender Dienst: das Ziel in Worten («Container sonarr, Port 8989» bzw. die Adresse) */
  external?: { label: string; mode: 'container' | 'address'; found: boolean | null } | null
  access: TopologyAccessDto[]
  hosts: TopologyHostDto[]
  services: TopologyServiceDto[]
  volumes: TopologyVolumeDto[]
  edges: TopologyEdgeDto[]
  /** Dienst mit der Hauptroute (Standard der Seitenkarte); null ohne Dienst */
  main: string | null
  /** Grenzen je Container (bei Compose gelten sie für jeden Dienst) */
  limits: { cpu: number; memoryMb: number }
  /**
   * Etappe 4: Dienste hinzufügen und entfernen. way null: hier nicht möglich
   * (reason sagt warum, z. B. GitHub-App fehlt); changes: laufende und
   * gescheiterte Änderungen (gestrichelte Knoten «wird erstellt»).
   */
  edit?: { way: ServiceEditWay | null; reason: string | null; changes: ServiceChangeDto[]; webService: string | null }
}

const DB_RE = /^(postgres|mysql|mariadb|redis|mongo)(?:ql|db|-stack|-stack-server|db-community-server)?$/

/**
 * Datenbank am Image erkennen: letzter Pfadteil ohne Tag heisst postgres,
 * mysql, mariadb, redis oder mongo (auch «bitnami/postgresql», «mongodb»,
 * «redis-stack»). Werkzeuge mit ähnlichem Namen («postgres-backup») zählen
 * nicht. Alles andere: null.
 */
export function databaseKindOf(image: string | null | undefined): DatabaseKind | null {
  if (!image) return null
  const noDigest = image.split('@')[0]!
  const last = noDigest.split('/').at(-1) ?? ''
  const repo = last.split(':')[0]!.toLowerCase()
  const m = DB_RE.exec(repo)
  return m ? (m[1] as DatabaseKind) : null
}

/** Tag eines Images («postgres:16» → «16»); ohne Tag «latest», mit Digest null */
export function imageTag(image: string | null | undefined): string | null {
  if (!image || image.includes('@')) return null
  const last = image.split('/').at(-1) ?? ''
  const i = last.indexOf(':')
  return i < 0 ? 'latest' : last.slice(i + 1) || null
}

export const TOPOLOGY_WAY_LABEL: Record<TopologyWay, string> = { public: 'Internet', tailnet: 'Tailnet', lan: 'Heimnetz' }

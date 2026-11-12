import { z } from 'zod'

/**
 * Nacht 3, Etappe 5: Einbruchserkennung (leichtgewichtig, ohne Falco).
 *
 * Airlock sammelt Hinweise aus sechs Quellen (Anmeldung, Prozesse in den
 * Containern, Dateien, Netz, Web, Container-Neustarts), bewertet sie mit
 * einem Schweregrad und bündelt gleiche Hinweise zu einem Vorfall mit
 * Zähler. Vorfälle haben einen Status (offen, gesehen, erledigt), eine Notiz
 * und einen Verlauf.
 */

export const incidentSeverities = ['niedrig', 'mittel', 'hoch', 'kritisch'] as const
export type IncidentSeverity = (typeof incidentSeverities)[number]

export const INCIDENT_SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  niedrig: 'Niedrig',
  mittel: 'Mittel',
  hoch: 'Hoch',
  kritisch: 'Kritisch',
}

/** Rangfolge: höher = schlimmer */
export const severityRank = (s: IncidentSeverity): number => incidentSeverities.indexOf(s)

export const incidentStatuses = ['offen', 'gesehen', 'erledigt'] as const
export type IncidentStatus = (typeof incidentStatuses)[number]

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  offen: 'Offen',
  gesehen: 'Gesehen',
  erledigt: 'Erledigt',
}

export const incidentSources = ['anmeldung', 'prozess', 'datei', 'netz', 'web', 'container'] as const
export type IncidentSource = (typeof incidentSources)[number]

export const INCIDENT_SOURCE_LABEL: Record<IncidentSource, string> = {
  anmeldung: 'Anmeldung',
  prozess: 'Prozess',
  datei: 'Dateien',
  netz: 'Netz',
  web: 'Web',
  container: 'Container',
}

/** Arten von Vorfällen; die Quelle steht davor */
export const incidentKinds = [
  // Anmeldung
  'login_fehlversuche', 'login_sperre', 'login_neues_geraet', 'login_neuer_zugang',
  // Prozesse in Projekt-Containern
  'prozess_miner', 'prozess_aus_tmp', 'prozess_verdaechtig', 'prozess_neu',
  // Dateien: Container (docker diff) und statische Seiten (Hash gegen das Artefakt)
  'datei_ausfuehrbar', 'datei_programm', 'datei_webroot', 'datei_system', 'datei_seite',
  // Netz
  'netz_gesperrt',
  // Web
  'web_scan',
  // Container
  'container_neustart', 'container_oom',
] as const
export type IncidentKind = (typeof incidentKinds)[number]

export const INCIDENT_KIND_LABEL: Record<IncidentKind, string> = {
  login_fehlversuche: 'Viele Fehlversuche bei der Anmeldung',
  login_sperre: 'Anmeldung gesperrt nach Fehlversuchen',
  login_neues_geraet: 'Anmeldung von neuem Gerät',
  login_neuer_zugang: 'Anmeldung über neuen Zugang',
  prozess_miner: 'Krypto-Miner im Container',
  prozess_aus_tmp: 'Programm aus /tmp gestartet',
  prozess_verdaechtig: 'Verdächtiges Programm im Container',
  prozess_neu: 'Neues Programm im Container',
  datei_ausfuehrbar: 'Neue ausführbare Datei im Container',
  datei_programm: 'Programm-Ordner im Container geändert',
  datei_webroot: 'Dateien im Webroot des Containers geändert',
  datei_system: 'Systemdateien im Container geändert',
  datei_seite: 'Ausgelieferte Dateien weichen vom Artefakt ab',
  netz_gesperrt: 'Gesperrte Verbindungsversuche',
  web_scan: 'Scan von aussen',
  container_neustart: 'Unerwarteter Neustart des Containers',
  container_oom: 'Container wegen Speichergrenze beendet',
}

/** «Als normal markieren» geht für Hinweise, die eine Grundlinie haben */
export const NORMALIZABLE_KINDS: readonly IncidentKind[] = [
  'prozess_verdaechtig', 'prozess_neu', 'datei_ausfuehrbar', 'datei_programm', 'datei_webroot', 'datei_system', 'netz_gesperrt',
]

/** Wie lange Airlock die Programme und Dateien eines neuen Containers als Grundlinie lernt */
export const INTRUSION_LEARN_MINUTES = 10

/* --- Eingaben ------------------------------------------------------------------ */

/* Namen mit «Intrusion»: «Incident» ist schon die Störung der Statusseite (status.ts) */
export const intrusionIncidentUpdateSchema = z.object({
  status: z.enum(incidentStatuses).optional(),
  /** null oder "" = Notiz entfernen */
  note: z.string().trim().max(2000).nullable().optional(),
}).refine((v) => v.status !== undefined || v.note !== undefined, { message: 'Status oder Notiz angeben' })
export type IntrusionIncidentUpdateInput = z.infer<typeof intrusionIncidentUpdateSchema>

export const intrusionSettingsSchema = z.object({
  /** Bei kritischem Vorfall Container stoppen und öffentliche Seite pausieren (Standard aus) */
  autoStop: z.boolean(),
})
export type IntrusionSettingsInput = z.infer<typeof intrusionSettingsSchema>

export const incidentListQuerySchema = z.object({
  status: z.enum([...incidentStatuses, 'aktiv', 'alle'] as const).default('aktiv'),
  projectId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})
export type IncidentListQuery = z.infer<typeof incidentListQuerySchema>

/* --- Antworten ----------------------------------------------------------------- */

export interface IntrusionIncidentDto {
  id: string
  /** null = betrifft den Server (Anmeldung) */
  project: { id: string; name: string } | null
  source: IncidentSource
  kind: IncidentKind
  severity: IncidentSeverity
  status: IncidentStatus
  /** Kurz, z. B. «Shell gestartet: sh (Dienst web)» */
  title: string
  /** Programm, Adresse, Pfad o. Ä.; null wenn nichts Einzelnes */
  subject: string | null
  /** Compose-Dienst bzw. Container */
  service: string | null
  /** Wie oft gesehen (gebündelt) */
  count: number
  firstSeen: string
  lastSeen: string
  note: string | null
  /** Beispiele (Pfade, Befehlszeilen, Ziele), höchstens 20 */
  samples: string[]
  /** Wann zuletzt per ntfy/E-Mail gemeldet */
  notifiedAt: string | null
  /** Bei kritischem Vorfall wurde gestoppt/pausiert */
  reactedAt: string | null
  canMarkNormal: boolean
}

export const incidentEventKinds = ['erkannt', 'erneut', 'hochgestuft', 'status', 'notiz', 'normal', 'gemeldet', 'reaktion'] as const
export type IncidentEventKind = (typeof incidentEventKinds)[number]

export interface IncidentEventDto {
  at: string
  kind: IncidentEventKind
  text: string
  actor: string | null
}

export interface IntrusionIncidentDetailDto extends IntrusionIncidentDto {
  events: IncidentEventDto[]
}

export interface IncidentCountsDto {
  /** Offene (nicht erledigte) Vorfälle je Schweregrad */
  active: Record<IncidentSeverity, number>
  /** davon noch nicht gesehen */
  unseen: number
}

export interface IncidentListDto {
  incidents: IntrusionIncidentDto[]
  counts: IncidentCountsDto
}

/** Zustand der Überwachung eines Projekts */
export type IntrusionWatchState =
  /** Container laufen, Grundlinie gelernt – neue Programme werden gemeldet */
  | 'aktiv'
  /** Mindestens ein Container lernt noch seine Grundlinie */
  | 'lernt'
  /** Keine laufenden Container (gestoppt, nie deployt) */
  | 'ohne-container'
  /** Statische Seite: Dateien werden stündlich gegen das Artefakt geprüft */
  | 'statisch'
  /** Bestehender Dienst: nur Web und Netz – Prozesse und Dateien eines fremden Containers sieht Airlock nicht */
  | 'extern'

export interface ProjectIntrusionDto {
  watch: {
    state: IntrusionWatchState
    /** Lernt bis (spätester Container) */
    learnUntil: string | null
    containers: number
    /** Letzte Prüfung der Prozesse bzw. der Dateien */
    lastCheckAt: string | null
  }
  /** Offene und gesehene Vorfälle des Projekts, dazu die letzten erledigten */
  incidents: IntrusionIncidentDto[]
  autoStop: boolean
  isolation: { at: string; by: string } | null
  /** Vom Benutzer als normal markiert (Grundlinie des Projekts) */
  normal: { kind: string; service: string | null; value: string }[]
}

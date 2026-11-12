import type { ProjectDto, ProjectStateDto } from './index.js'

/**
 * Abgrenzung HomeBento: HomeBento ist das Dashboard für den ganzen
 * Homeserver; Airlock liefert ihm nur eine lesende Übersicht seiner Projekte
 * (GET /api/v1/summary) – mit einem Token, das nichts ändern und nichts
 * Geheimes sehen kann.
 */

/** Umfang eines API-Tokens: voll (REST und MCP der Umgebung) oder nur lesen (GET /summary) */
export const TOKEN_SCOPES = ['voll', 'lesen'] as const
export type TokenScope = (typeof TOKEN_SCOPES)[number]

export const TOKEN_SCOPE_LABEL: Record<TokenScope, string> = {
  voll: 'Voller Zugriff',
  lesen: 'Nur lesen',
}

/** Die einzigen Routen, die ein Token mit Umfang «lesen» aufrufen darf (Routenmuster, nur GET) */
export const READ_TOKEN_ROUTES = ['/api/v1/summary', '/api/v1/environments/:env/summary'] as const

/** kind: wofür, unabhängig vom Text (Sortierung); tone nach der Farbregel – hoch ist rot wie kritisch */
export interface ProjectAttention {
  kind: 'deploy' | 'down' | 'critical' | 'high' | 'expiry'
  reason: string
  tone: 'bad' | 'warn'
}

type AttentionInput = Pick<ProjectDto, 'state' | 'activeDeployment' | 'lastDeployment' | 'security' | 'expiresAt' | 'keep'>

/** Gescheiterter Deploy, der Aufmerksamkeit braucht (alte Fassung läuft weiter oder gar nichts) */
export const deployFailedOf = (p: Pick<ProjectDto, 'state' | 'activeDeployment' | 'lastDeployment'>): boolean =>
  p.state.key === 'failed_old_running' || (p.state.key === 'down' && !p.activeDeployment && p.lastDeployment?.status === 'failed')

/**
 * Braucht das Projekt Aufmerksamkeit? Und warum. Eine Definition für die
 * Projektliste (Filter, Hinweise, Reihenfolge) und GET /summary.
 */
export function attentionOf(p: AttentionInput, now = Date.now()): ProjectAttention | null {
  if (deployFailedOf(p)) return { kind: 'deploy', reason: 'Deploy fehlgeschlagen', tone: 'bad' }
  if (p.state.key === 'down') return { kind: 'down', reason: 'nichts läuft', tone: 'bad' }
  const crit = p.security?.open.critical ?? 0
  const high = p.security?.open.high ?? 0
  if (crit > 0) return { kind: 'critical', reason: crit === 1 ? '1 kritischer Befund' : `${crit} kritische Befunde`, tone: 'bad' }
  if (high > 0) return { kind: 'high', reason: high === 1 ? '1 hoher Befund' : `${high} hohe Befunde`, tone: 'bad' }
  const until = p.expiresAt ? Date.parse(p.expiresAt) : NaN
  if (Number.isFinite(until) && !p.keep && until - now < 7 * 86_400_000) return { kind: 'expiry', reason: 'läuft bald ab', tone: 'warn' }
  return null
}

/** Ein Projekt in GET /summary – nur, was ein Dashboard zeigt; keine Env, keine Secrets, keine Logs */
export interface SummaryProjectDto {
  id: string
  slug: string
  name: string
  /** Zustand wie in Airlock (Schlüssel, Wort, Ton) */
  state: Pick<ProjectStateDto, 'key' | 'label' | 'tone'>
  /** Hauptadresse: öffentlich (live) vor Tailnet vor LAN; null ohne Adresse */
  url: string | null
  /** Öffentlich erreichbar (live, nicht pausiert) */
  public: boolean
  /** Note des letzten abgeschlossenen Scans (A–D); null ohne Scan */
  grade: 'A' | 'B' | 'C' | 'D' | null
  /** Offene Befunde des letzten Scans nach Schwere */
  findings: Record<'critical' | 'high' | 'medium' | 'low', number>
  /** Braucht Aufmerksamkeit (gleiche Regel wie der Filter in Airlock) und warum */
  attention: boolean
  attentionReason: string | null
  /** bad (Fehler, nichts läuft, kritisch/hoch) oder warn (läuft bald ab); null ohne Aufmerksamkeit */
  attentionTone: 'bad' | 'warn' | null
  /** Eindeutige Besucher seit Mitternacht (Ortszeit); null, wenn Airlock nicht mitzählt oder das Projekt keine Adresse hat */
  visitorsToday: number | null
  /**
   * Verfügbarkeit in Prozent (0–100, zwei Nachkommastellen) aus der Messung der
   * Statusseite (Minuten «läuft» gegen «Störung», Tagesauflösung): uptime24h =
   * heute und gestern, uptime30d = die letzten 30 Tage. null ohne Messung
   * (Projekt nicht auf der Statusseite oder noch keine Minute gemessen).
   */
  uptime24h: number | null
  uptime30d: number | null
  /** Ablauf des Zertifikats der internen Adresse (ISO); null ohne HTTPS-Adresse bei Airlock (öffentlich: Cloudflare) */
  certificateExpiresAt: string | null
  /** Läuft gerade ein Deploy? */
  deploying: boolean
}

export interface SummaryDto {
  /** Zeitpunkt der Antwort (ISO) */
  at: string
  /** Name der Umgebung (das Token gehört zu genau einer) */
  environment: string
  projects: SummaryProjectDto[]
  /** Laufende Deploys der Umgebung */
  deploying: { projectId: string; name: string; startedAt: string }[]
  /** Kurz zusammengezählt, für eine Kachel */
  totals: {
    projects: number
    running: number
    attention: number
    public: number
    findings: Record<'critical' | 'high' | 'medium' | 'low', number>
    /** null, wenn Airlock nicht mitzählt */
    visitorsToday: number | null
  }
  /** Zertifikat der internen Adressen; null ohne HTTPS (TLS aus) */
  certificate: { expiresAt: string | null; daysLeft: number | null } | null
}

import { z } from 'zod'

/**
 * Nacht 3, Etappe 4: Ausgang der Projekt-Container begrenzen.
 *
 * Pro Projekt-Netz (air_<slug>) ein Modus:
 * - «internet» (Standard): Internet ja, Heimnetz, Tailnet, Link-local und der
 *   Server selbst nein. DNS (Port 53) bleibt erlaubt, ebenso das eigene
 *   Projekt-Netz und Antworten (z. B. an Caddy).
 * - «abgeschottet»: auch kein Internet und kein DNS nach draussen; Namen im
 *   eigenen Projekt-Netz löst Docker selbst auf.
 * - «frei»: keine Regel, wie vor der Etappe (nur nach erneuter Bestätigung).
 *
 * Dazu «Durchsetzen» (sperren) oder «Beobachten» (nur protokollieren, nie
 * sperren). Nach dem Update beobachten bestehende Projekte, neue setzen durch.
 * Plus Ausnahmen je Projekt (IP/CIDR oder Hostname, optional Port).
 */

export const egressModes = ['internet', 'abgeschottet', 'frei'] as const
export type EgressMode = (typeof egressModes)[number]

/** Gesperrte Ziele im Modus «internet» (IPv4): privat, Tailnet (CGNAT), Link-local */
export const EGRESS_BLOCKED_V4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16'] as const
/** Dasselbe für IPv6: Unique Local und Link-local */
export const EGRESS_BLOCKED_V6 = ['fc00::/7', 'fe80::/10'] as const

export const EGRESS_MODE_LABEL: Record<EgressMode, string> = {
  internet: 'Internet',
  abgeschottet: 'Abgeschottet',
  frei: 'Frei',
}

/** Was der Modus bedeutet, kurz (Aufbau, Listen) */
export function egressSummary(s: { mode: EgressMode; enforce: boolean }): string {
  if (s.mode === 'frei') return 'Frei, nichts gesperrt'
  const base = s.mode === 'internet' ? 'Internet, Heimnetz gesperrt' : 'Kein Internet, Heimnetz gesperrt'
  return s.enforce ? base : `${base} (nur beobachtet)`
}

/** Was eine Ausnahme bedeutet: Ziel und Port */
export const egressProtocols = ['tcp', 'udp'] as const
export type EgressProtocol = (typeof egressProtocols)[number]

/* --- Ziele prüfen (ohne node:net, läuft auch im Browser) ---------------------- */

const V4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/

export const isIpv4 = (s: string): boolean => V4_RE.test(s)

/** IPv6 grob, aber streng genug für Regeln: Hex-Gruppen, höchstens ein «::» */
export function isIpv6(s: string): boolean {
  if (!/^[0-9a-f:]+$/i.test(s) || !s.includes(':') || s.length > 39) return false
  const parts = s.split('::')
  if (parts.length > 2) return false
  const groups = parts.flatMap((p) => (p === '' ? [] : p.split(':')))
  if (groups.some((g) => g.length < 1 || g.length > 4)) return false
  return parts.length === 2 ? groups.length <= 7 : groups.length === 8
}

export type EgressTargetKind = 'ip' | 'cidr' | 'host'

/**
 * Ziel einer Ausnahme einordnen; null = ungültig. CIDR-Netze nicht breiter als
 * /8 (IPv4) bzw. /16 (IPv6) – wer alles freigeben will, nimmt den Modus «Frei».
 */
export function egressTargetKind(raw: string): { kind: EgressTargetKind; family: 4 | 6 | null } | null {
  const s = raw.trim().toLowerCase()
  const slash = s.indexOf('/')
  if (slash >= 0) {
    const addr = s.slice(0, slash)
    const bits = s.slice(slash + 1)
    if (!/^\d{1,3}$/.test(bits)) return null
    const n = Number(bits)
    if (isIpv4(addr)) return n >= 8 && n <= 32 ? { kind: 'cidr', family: 4 } : null
    if (isIpv6(addr)) return n >= 16 && n <= 128 ? { kind: 'cidr', family: 6 } : null
    return null
  }
  if (isIpv4(s)) return { kind: 'ip', family: 4 }
  if (isIpv6(s)) return { kind: 'ip', family: 6 }
  // Hostname: mindestens ein Punkt, kein reiner Zahlenname
  if (HOST_RE.test(s) && s.includes('.') && !/^[\d.]+$/.test(s)) return { kind: 'host', family: null }
  return null
}

/* --- Eingaben ------------------------------------------------------------------ */

export const egressSettingsSchema = z.object({
  mode: z.enum(egressModes).optional(),
  /** true = sperren, false = nur beobachten */
  enforce: z.boolean().optional(),
}).refine((v) => v.mode !== undefined || v.enforce !== undefined, { message: 'Modus oder Durchsetzen angeben' })
export type EgressSettingsInput = z.infer<typeof egressSettingsSchema>

export const egressExceptionInputSchema = z.object({
  target: z.string().trim().min(1, 'Ziel fehlt').max(253)
    .refine((v) => egressTargetKind(v) !== null, 'IP-Adresse, Netz (z. B. 192.168.1.0/24, höchstens /8) oder Hostname'),
  /** Ohne Port: alle Ports und Protokolle dieses Ziels */
  port: z.number().int().min(1).max(65535).nullable().default(null),
  protocol: z.enum(egressProtocols).default('tcp'),
  note: z.string().trim().max(80).nullable().optional(),
})
export type EgressExceptionInput = z.infer<typeof egressExceptionInputSchema>

/** Höchstens so viele Ausnahmen je Projekt */
export const EGRESS_MAX_EXCEPTIONS = 20

/* --- Antworten ----------------------------------------------------------------- */

export interface EgressExceptionDto {
  id: string
  /** wie eingegeben (IP, CIDR oder Hostname) */
  target: string
  port: number | null
  protocol: EgressProtocol
  note: string | null
  /** Hostname: Adressen beim letzten Anwenden; null = nicht auflösbar; bei IP/CIDR leer */
  resolved: string[] | null
  createdAt: string
}

export const egressVerdicts = ['beobachtet', 'gesperrt'] as const
export type EgressVerdict = (typeof egressVerdicts)[number]

/** Gebündelte Versuche: gleiches Ziel, Port, Protokoll und Urteil */
export interface EgressAttemptDto {
  verdict: EgressVerdict
  protocol: 'tcp' | 'udp' | 'icmp' | 'andere'
  destination: string
  /** null bei ICMP und ohne Port */
  port: number | null
  /** Ziel ist der Server selbst (LAN-, Tailscale- oder Gateway-Adresse) */
  toServer: boolean
  /** Gezählte Pakete (begrenzt auf 20 pro Minute und Projekt, also eher mehr) */
  count: number
  firstSeen: string
  lastSeen: string
}

/** Wie weit die Regeln des Projekts auf dem Server angekommen sind */
export type EgressApplyState =
  /** Regeln stehen im Kernel (Firewall-Dienst hat den Stand bestätigt) */
  | 'angewendet'
  /** Geschrieben, der Dienst hat noch nicht bestätigt (wenige Sekunden) */
  | 'ausstehend'
  /** Der Firewall-Dienst meldet sich nicht (gestoppt, nicht installiert) */
  | 'dienst-aus'
  /** Der Dienst hat den Stand abgelehnt oder nft ist gescheitert */
  | 'fehler'
  /** Notausgang aktiv (airlock-fw flush): keine Regeln, bis «airlock-fw enable» */
  | 'abgeschaltet'
  /** Noch kein Netz (Projekt nie deployt) – Regeln entstehen mit dem Netz */
  | 'ohne-netz'
  /** Modus «frei»: es gibt nichts anzuwenden */
  | 'frei'

export interface EgressApplyDto {
  state: EgressApplyState
  /** Wann der Dienst zuletzt einen Stand angewendet hat */
  at: string | null
  message: string | null
}

export interface ProjectEgressDto {
  mode: EgressMode
  enforce: boolean
  exceptions: EgressExceptionDto[]
  /** Versuche der letzten 7 Tage, neueste zuerst (höchstens 20) */
  attempts: EgressAttemptDto[]
  apply: EgressApplyDto
  /** Vorschau: Einstellungen kommen vom Projekt (nur lesen) */
  inheritedFrom: { id: string; name: string } | null
}

export type EgressServiceState = 'laeuft' | 'aus' | 'fehler' | 'abgeschaltet' | 'nicht-unterstuetzt'

export interface EgressServerDto {
  service: {
    state: EgressServiceState
    /** Letztes Lebenszeichen des Dienstes */
    heartbeatAt: string | null
    /** Letzter angewendeter Stand */
    appliedAt: string | null
    /** Projekt-Netze mit Regeln im letzten Stand */
    networks: number | null
    message: string | null
    /** z. B. «nftables v1.1.3» */
    version: string | null
  }
  projects: { total: number; observe: number; enforce: number; frei: number; abgeschottet: number }
  /** Gesperrte bzw. beobachtete Versuche der letzten 24 Stunden (alle Projekte) */
  last24h: { beobachtet: number; gesperrt: number }
}

export const egressEnforceAllSchema = z.object({ confirm: z.literal(true) })

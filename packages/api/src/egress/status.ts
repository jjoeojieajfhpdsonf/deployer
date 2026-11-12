import type { EgressApplyDto, EgressMode, EgressServerDto, EgressServiceState } from '@airlock/shared'

/**
 * Nacht 3, Etappe 4: status.json des Firewall-Dienstes deuten – rein
 * (status.test.ts). Geschrieben von firewall/airlock-fw (write_status).
 */

export interface FirewallStatusFile {
  state?: string
  heartbeat?: string
  table?: string
  nft?: string
  applied?: { sha256?: string | null; at?: string | null; networks?: number | null }
  lastSha256?: string | null
  error?: string | null
}

/** Ohne Lebenszeichen so lange gilt der Dienst als aus (er schreibt alle 5 s) */
export const HEARTBEAT_STALE_MS = 60_000

export function parseStatusFile(text: string | null): FirewallStatusFile | null {
  if (!text) return null
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' ? (v as FirewallStatusFile) : null
  } catch {
    return null
  }
}

export function serviceOf(s: FirewallStatusFile | null, now: Date): EgressServerDto['service'] {
  const base = {
    heartbeatAt: s?.heartbeat ?? null,
    appliedAt: s?.applied?.at ?? null,
    networks: typeof s?.applied?.networks === 'number' ? s.applied.networks : null,
    version: s?.nft || null,
  }
  if (!s) return { ...base, state: 'aus', message: 'Der Firewall-Dienst hat sich noch nie gemeldet (nicht installiert oder nicht gestartet).' }
  const beat = s.heartbeat ? Date.parse(s.heartbeat) : NaN
  if (!Number.isFinite(beat) || now.getTime() - beat > HEARTBEAT_STALE_MS) {
    return { ...base, state: 'aus', message: 'Der Firewall-Dienst meldet sich nicht mehr (gestoppt oder abgestürzt). Bestehende Regeln bleiben im Kernel stehen.' }
  }
  const state: EgressServiceState =
    s.state === 'disabled' ? 'abgeschaltet'
    : s.state === 'unsupported' ? 'nicht-unterstuetzt'
    : s.state === 'error' ? 'fehler'
    : 'laeuft'
  const message =
    state === 'abgeschaltet' ? 'Notausgang aktiv: keine Ausgangsregeln. Wieder einschalten: docker exec airlock-firewall airlock-fw enable'
    : state === 'nicht-unterstuetzt' ? (s.error ?? 'nft geht auf diesem Server nicht.')
    : state === 'fehler' ? `Der letzte Stand wurde abgelehnt; der vorherige gilt weiter. ${s.error ?? ''}`.trim()
    : null
  return { ...base, state, message }
}

/** Wie weit sind die Regeln eines Projekts angekommen? */
export function applyStateOf(o: {
  mode: EgressMode
  hasNetwork: boolean
  skipped: string | null
  service: EgressServerDto['service']
  status: FirewallStatusFile | null
  desiredSha: string | null
}): EgressApplyDto {
  const at = o.service.appliedAt
  if (o.mode === 'frei') return { state: 'frei', at: null, message: null }
  if (o.skipped) return { state: 'fehler', at, message: o.skipped }
  if (!o.hasNetwork) return { state: 'ohne-netz', at: null, message: 'Die Regeln entstehen mit dem Netz des Projekts beim ersten Deploy.' }
  if (o.service.state === 'aus') return { state: 'dienst-aus', at, message: o.service.message }
  if (o.service.state === 'abgeschaltet') return { state: 'abgeschaltet', at: null, message: o.service.message }
  if (o.service.state === 'nicht-unterstuetzt') return { state: 'fehler', at: null, message: o.service.message }
  if (!o.desiredSha) return { state: 'ausstehend', at, message: null }
  if (o.status?.lastSha256 === o.desiredSha && o.status.state === 'error') return { state: 'fehler', at, message: o.service.message }
  if (o.status?.applied?.sha256 === o.desiredSha) return { state: 'angewendet', at, message: null }
  return { state: 'ausstehend', at, message: null }
}

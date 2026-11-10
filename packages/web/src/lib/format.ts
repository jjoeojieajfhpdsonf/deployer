import type { AuditEventDto, ProjectDto } from '@airlock/shared'

/** «vor 18 Min.», «vor 2 Std.», «gestern», «vor 3 Tagen» */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '–'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'gerade eben'
  if (min < 60) return `vor ${min} Min.`
  const h = Math.floor(min / 60)
  if (h < 24) return `vor ${h} Std.`
  const d = Math.floor(h / 24)
  if (d === 1) return 'gestern'
  if (d < 30) return `vor ${d} Tagen`
  return new Date(iso).toLocaleDateString('de-CH')
}

/** «seit 2 Std.», «seit gestern» */
export function since(iso: string | null | undefined): string {
  const r = relativeTime(iso)
  if (r === '–') return r
  if (r === 'gerade eben') return 'seit eben'
  if (r === 'gestern') return 'seit gestern'
  return r.replace(/^vor /, 'seit ')
}

/** Uhrzeit für heute, sonst «gestern» oder Datum – für die Aktivitätsliste. */
export function clockOrDay(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return 'gestern'
  return d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })
}

export function duration(ms: number | null): string {
  if (ms === null) return '–'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

/** Gigabyte mit Komma, eine Stelle unter 10, sonst ganze Zahl: «6,4», «142» */
export function gb(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '–'
  const v = bytes / 1024 ** 3
  // Dezimalkomma wie im Prototyp («6,4»); de-CH setzte einen Punkt.
  return v < 10 ? v.toLocaleString('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 }) : Math.round(v).toLocaleString('de-CH')
}

export const pct = (part: number | null | undefined, total: number | null | undefined): number | null =>
  part === null || part === undefined || !total ? null : Math.round((part / total) * 100)

export function shortVersion(v: string | null | undefined): string {
  if (!v) return '–'
  // image@sha256:… → letzter Namensteil und 7 Zeichen des Digests
  const at = v.indexOf('@sha256:')
  if (at > 0) return `${v.slice(0, at).split('/').pop()}@${v.slice(at + 8, at + 15)}`
  if (/^[0-9a-f]{12,}$/i.test(v)) return v.slice(0, 7)
  if (v.startsWith('sha256:')) return v.slice(7, 14)
  return v.length > 24 ? `${v.slice(0, 23)}…` : v
}

export const KIND_LABEL: Record<string, string> = {
  image: 'Image',
  dockerfile: 'Dockerfile',
  compose: 'Compose',
  static: 'Statisch',
  files: 'Chat',
}

/** Wer etwas getan hat, kurz: UI, Tokenname, Airlock. */
export function actorLabel(actor: string): string {
  if (actor.startsWith('ui:')) return 'UI'
  if (actor.startsWith('token:')) return actor.slice(6)
  if (actor === 'system') return 'Airlock'
  return actor
}

/** Ton eines Audit-Eintrags für den Punkt in der Aktivitätsliste. */
export function auditTone(e: AuditEventDto): 'ok' | 'bad' | 'info' | 'warn' | 'none' {
  if (e.result === 'error') return 'bad'
  if (/deploy|rollback/.test(e.action)) return 'info'
  if (/scan|finding|expir|verification_lost/.test(e.action)) return 'warn'
  if (/create|start|public|verify/.test(e.action)) return 'ok'
  return 'none'
}

const VERBS: Record<string, string> = {
  'project.create': 'angelegt',
  'project.delete': 'gelöscht',
  'project.deploy': 'deployt',
  'project.rollback': 'zurückgerollt',
  'project.recreate': 'neu erstellt',
  'project.start': 'gestartet',
  'project.stop': 'gestoppt',
  'project.update': 'geändert',
  'project.env.replace': 'Variablen geändert',
  'project.routes.set': 'Erreichbarkeit geändert',
  'project.public': 'öffentlich geschaltet',
  'project.public.remove': 'ganz offline genommen',
  'project.public.pause': 'öffentlich pausiert',
  'project.public.resume': 'wieder online',
  'project.public.access': 'Cloudflare Access geändert',
  'project.public.rename': 'öffentlichen Namen geändert',
  'project.public.change': 'Veröffentlichung geändert',
  'project.expiry_warning': 'läuft bald ab',
  'project.expired': 'wegen Ablauf gestoppt',
  'scan.start': 'Scan gestartet',
  'finding.accept': 'Befund akzeptiert',
  'files.update': 'Dateien geändert',
  'files.init': 'Dateien angelegt',
  'files.export': 'exportiert',
}

const GENERAL: Record<string, string> = {
  'auth.login': 'Anmeldung',
  'token.create': 'Token angelegt',
  'token.revoke': 'Token widerrufen',
  'notifications.update': 'Benachrichtigungen geändert',
  'notifications.test': 'Test-Benachrichtigung',
  'external_target.add': 'Externes Ziel eingetragen',
  'external_target.verify': 'Externes Ziel geprüft',
  'external_target.verification_lost': 'Besitznachweis verloren',
  'external_target.update': 'Externes Ziel geändert',
  'external_target.delete': 'Externes Ziel entfernt',
  'domain.default': 'Standard-Domain gesetzt',
  'dns.tailnet': 'Tailnet-DNS gesetzt',
  'upload.create': 'Datei hochgeladen',
  'reconcile.container_missing': 'Container fehlte, neu gestartet',
}

/** Ein Audit-Eintrag als Satz: «blog-api: deployt», «wetter: Deploy fehlgeschlagen». */
export function describeAudit(e: AuditEventDto, projects: Map<string, ProjectDto>): string {
  const p = e.targetType === 'project' && e.targetId ? projects.get(e.targetId) : undefined
  const params = (e.paramsMasked ?? {}) as Record<string, unknown>
  const name = p?.slug ?? (typeof params.slug === 'string' ? params.slug : typeof params.name === 'string' ? params.name : null)
  let action = e.action
  const viaMcp = action.startsWith('mcp.')
  if (viaMcp) action = action.slice(4)
  if (e.result === 'error' && /deploy|rollback/.test(action)) return `${name ?? 'Projekt'}: ${action.includes('rollback') ? 'Rollback' : 'Deploy'} fehlgeschlagen`
  const verb = VERBS[action]
  if (verb) return `${name ?? 'Projekt'}: ${verb}${viaMcp ? ' über MCP' : ''}${e.result === 'error' ? ' (Fehler)' : ''}`
  const general = GENERAL[action]
  if (general) {
    const h = typeof params.hostname === 'string' ? ` ${params.hostname}` : typeof params.name === 'string' ? ` «${params.name}»` : ''
    return `${general}${h}${e.result === 'error' ? ' (Fehler)' : ''}`
  }
  if (viaMcp) return `MCP: ${action}${name ? ` (${name})` : ''}${e.result === 'error' ? ' – Fehler' : ''}`
  return `${action}${name ? ` (${name})` : ''}`
}

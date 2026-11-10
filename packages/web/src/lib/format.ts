import type { AuditEventDto, ProjectDto } from '@airlock/shared'
import { describeEvent } from './activity.js'
import { addDays, fmtDate, fmtDayMonth, fmtTime, msOf, sameDay } from './dates.js'

/** «vor 18 Min.», «vor 2 Std.», «gestern», «vor 3 Tagen» */
export function relativeTime(iso: string | null | undefined): string {
  // Ungültiges Datum: Strich statt «Invalid Date» oder NaN
  const t = msOf(iso)
  if (t === null) return '–'
  const diff = Date.now() - t
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'gerade eben'
  if (min < 60) return `vor ${min} Min.`
  const h = Math.floor(min / 60)
  if (h < 24) return `vor ${h} Std.`
  const d = Math.floor(h / 24)
  if (d === 1) return 'gestern'
  if (d < 30) return `vor ${d} Tagen`
  return fmtDate(t)
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
  const now = new Date()
  if (msOf(iso) === null) return '–'
  if (sameDay(iso, now)) return fmtTime(iso)
  if (sameDay(iso, addDays(now, -1))) return 'gestern'
  return fmtDayMonth(iso)
}

export function duration(ms: number | null): string {
  if (ms === null) return '–'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

/** Zeitpunkt in der Zukunft: «heute», «morgen», «in 6 Tagen» */
export function inTime(iso: string | null | undefined): string {
  const t = msOf(iso)
  if (t === null) return '–'
  const diff = t - Date.now()
  if (diff <= 0) return 'demnächst'
  const h = Math.floor(diff / 3_600_000)
  if (h < 1) return 'in weniger als einer Stunde'
  if (h < 24) return `in ${h} Std.`
  const d = Math.round(diff / 86_400_000)
  if (d === 1) return 'morgen'
  return `in ${d} Tagen`
}

/** Dauer eines Deployments: unter einer Sekunde «sofort» (statische Seiten, nur Umschalten) */
export function deployDuration(ms: number | null): string | null {
  if (ms === null || ms < 0) return null
  return ms < 1000 ? 'sofort' : duration(ms)
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

/**
 * Ein Audit-Eintrag als Satz für kurze Listen (Projektliste): «fotoalbum:
 * Header gesetzt: CSP». Titel aus der zentralen Tabelle in lib/activity.ts,
 * nie der rohe Schlüssel.
 */
export function describeAudit(e: AuditEventDto, projects: Map<string, ProjectDto>): string {
  const p = e.targetType === 'project' && e.targetId ? projects.get(e.targetId) : undefined
  const params = (e.paramsMasked ?? {}) as Record<string, unknown>
  const name = p?.slug ?? (typeof params.slug === 'string' ? params.slug : null)
  const title = describeEvent(e).title
  return name ? `${name}: ${title}` : title
}

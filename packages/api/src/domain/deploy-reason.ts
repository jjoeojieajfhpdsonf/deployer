import type { DeployReason, DeploymentDto } from '@airlock/shared'

/**
 * Warum ein Deployment lief – als Titel der Zeile auf der Projektseite.
 *
 * Neue Deployments speichern den Grund beim Start (pipeline.startJob),
 * ältere bekommen ihn hier aus dem Audit-Log: Was ist seit dem vorherigen
 * Deployment am Projekt geschehen? Eine Code-Änderung schlägt alles andere,
 * sonst zählt die jüngste Einstellung (Header, Veröffentlichung,
 * Erreichbarkeit). Ohne Hinweis: «redeploy».
 */

export interface ReasonEvent {
  at: Date
  actor: string
  action: string
  params: Record<string, unknown>
}

export interface ReasonInput {
  trigger: 'deploy' | 'rollback'
  /** «Neu erstellen» (Übergang) ist technisch ein Rollback auf die aktive Fassung */
  recreate?: boolean
  actor: string | null
  /** Erstes Deployment des Projekts */
  isFirst: boolean
  /** Audit-Einträge des Projekts seit dem vorherigen Deployment (beliebige Reihenfolge) */
  events: ReasonEvent[]
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Erste Zeile einer Commit-Nachricht, höchstens 120 Zeichen. */
export function commitSubject(message: string | null | undefined): string | null {
  const line = (message ?? '').split('\n')[0]!.trim()
  if (!line) return null
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

const HEADER_SHORT: Record<string, string> = {
  'strict-transport-security': 'Strict-Transport-Security',
  'content-security-policy': 'Content-Security-Policy',
  'content-security-policy-report-only': 'Content-Security-Policy (Report-Only)',
  'x-frame-options': 'X-Frame-Options',
  'x-content-type-options': 'X-Content-Type-Options',
  'referrer-policy': 'Referrer-Policy',
  'permissions-policy': 'Permissions-Policy',
}

/** Header-Name in der üblichen Schreibweise («strict-transport-security» → «Strict-Transport-Security»). */
export function headerName(h: string): string {
  const k = h.toLowerCase()
  return HEADER_SHORT[k] ?? k.replace(/(^|-)([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase())
}

function configReason(e: ReasonEvent): DeployReason | null {
  const a = e.action.replace(/^mcp\./, '')
  switch (a) {
    case 'header.set':
    case 'header.remove':
    case 'set_security_header':
      return { kind: 'headers', detail: str(e.params.header) ? headerName(String(e.params.header)) : null }
    case 'project.public':
    case 'project.public.resume':
    case 'project.public.rename':
    case 'public.request.apply':
    case 'resume_public':
      return { kind: 'public', detail: str(e.params.hostname) }
    case 'project.public.pause':
    case 'pause_public':
      return { kind: 'paused', detail: null }
    case 'project.routes.set':
    case 'project.routes.internal':
    case 'project.public.remove':
    case 'set_targets':
    case 'unpublish':
      return { kind: 'internal', detail: null }
    default:
      return null
  }
}

export function deriveReason(i: ReasonInput): DeployReason {
  if (i.trigger === 'rollback') return { kind: i.recreate ? 'recreate' : 'rollback', detail: null }
  if (i.isFirst) return { kind: 'first', detail: null }
  const events = [...i.events].sort((a, b) => b.at.getTime() - a.at.getTime())
  if (i.actor?.startsWith('system:auto-deploy')) {
    const head = events.find((e) => e.action === 'project.auto_deploy')
    return { kind: 'auto_merge', detail: str(head?.params.message) }
  }
  // Code-Änderung (Chat-Projekt, Vorschlag übernommen): die Commit-Nachricht ist der Titel
  const code = events.find((e) => e.action === 'files.update' || e.action === 'fix.apply' || e.action === 'mcp.update_files')
  if (code) {
    const msg = str(code.params.message) ?? (str(code.params.title) ? `Fix: ${String(code.params.title)}` : null)
    return { kind: 'code', detail: commitSubject(msg) }
  }
  for (const e of events) {
    const r = configReason(e)
    if (r) return r
  }
  return { kind: 'redeploy', detail: null }
}

/**
 * Auslöser eines alten Eintrags aus dem Audit-Log: Deploy und Rollback
 * schreiben am Ende ein Ereignis mit der Deployment-ID.
 */
export function actorFromEvents(deploymentId: string, events: ReasonEvent[], startedAt?: Date): string | null {
  const hit = events.find((e) => /^project\.(deploy|rollback|recreate)$/.test(e.action) && e.params.deployment === deploymentId)
  if (!hit) return null
  // Über MCP ausgelöst: dasselbe Token rief kurz vor dem Start ein MCP-Werkzeug auf
  if (startedAt && hit.actor.startsWith('token:')) {
    const t = startedAt.getTime()
    const viaMcp = events.some((e) => e.actor === hit.actor && e.action.startsWith('mcp.') && e.at.getTime() >= t - 120_000 && e.at.getTime() <= hit.at.getTime() + 1000)
    if (viaMcp) return `mcp:${hit.actor.slice(6)}`
  }
  return hit.actor
}

interface HistoryRow { id: string; startedAt: Date; trigger: 'deploy' | 'rollback'; reason: DeployReason | null; actor: string | null }

/**
 * Laufende Nummer, Grund und Auslöser für eine Liste (neueste zuerst).
 * Alte Einträge ohne gespeicherten Grund: aus dem Audit-Log abgeleitet, mit
 * dem Zeitraum seit dem vorherigen Eintrag. Ist der vorherige nicht in der
 * Liste, ist der Zeitraum unbekannt: dann «Neu deployt».
 * `total` ist die Zahl aller Deployments des Projekts.
 */
export function withHistory<R extends HistoryRow>(rows: R[], total: number, events: ReasonEvent[], toDto: (r: R) => DeploymentDto): DeploymentDto[] {
  return rows.map((r, i) => {
    const seq = total - i
    const dto = toDto(r)
    dto.seq = seq
    if (!r.reason || !r.actor) {
      const prev = rows[i + 1]?.startedAt ?? null
      const actor = r.actor ?? actorFromEvents(r.id, events, r.startedAt)
      dto.actor = actor
      if (!r.reason) {
        const window = prev ? events.filter((e) => e.at <= r.startedAt && e.at > prev) : []
        dto.reason = deriveReason({ trigger: r.trigger, actor, isFirst: seq === 1, events: window })
      }
    }
    return dto
  })
}

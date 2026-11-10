import type { DeploymentDto } from '@airlock/shared'
import { deployReasonTitle } from '@airlock/shared'

/**
 * Deployments für die Liste aufbereiten (Projektseite, Karte und Reiter):
 * aktive Version zuerst abgesetzt, dahinter die übrigen in ihrer Reihenfolge.
 * Ältere aufeinanderfolgende Einträge mit demselben Code-Stand werden zu
 * einer Zeile «n weitere Deployments mit Stand …» zusammengefasst – ausser
 * dem Stand der aktiven Version direkt dahinter: Dort erklärt jede Zeile,
 * warum derselbe Stand noch einmal deployt wurde («gleicher Stand»).
 */

export type DeployState = 'active' | 'failed' | 'busy' | 'past'

export const BUSY_STATUSES = ['pending', 'pulling', 'starting', 'healthchecking'] as const

export function deployState(d: DeploymentDto): DeployState {
  if (d.isActive) return 'active'
  if (d.status === 'failed') return 'failed'
  if ((BUSY_STATUSES as readonly string[]).includes(d.status)) return 'busy'
  return 'past'
}

export type DeployItem =
  | { type: 'row'; d: DeploymentDto; sameAsActive: boolean }
  | { type: 'group'; version: string; rows: DeploymentDto[] }

/** Höchstens so viele Einträge mit dem Stand der aktiven Version bleiben einzeln sichtbar. */
const KEEP_SAME_AS_ACTIVE = 2

export function groupDeployments(rows: DeploymentDto[]): DeployItem[] {
  const active = rows.find((d) => d.isActive) ?? null
  const items: DeployItem[] = []
  let i = 0
  let sameShown = 0
  while (i < rows.length) {
    const d = rows[i]!
    const same = Boolean(active && !d.isActive && d.version && d.version === active.version)
    // Lauf gleicher Stände ab hier (ohne die aktive Zeile; laufende und gescheiterte bleiben sichtbar)
    let j = i
    while (j < rows.length && rows[j]!.version && rows[j]!.version === d.version && deployState(rows[j]!) === 'past') j++
    const run = rows.slice(i, j)
    if (same && sameShown < KEEP_SAME_AS_ACTIVE) {
      items.push({ type: 'row', d, sameAsActive: true })
      sameShown++
      i++
      continue
    }
    if (run.length >= 2) {
      items.push({ type: 'group', version: d.version!, rows: run })
      i = j
      continue
    }
    items.push({ type: 'row', d, sameAsActive: same })
    i++
  }
  return items
}

/** Kurzform des Grunds für die Sammelzeile: «Header, Öffentlich, Erstes Deployment» */
export function shortReason(d: DeploymentDto): string {
  switch (d.reason?.kind) {
    case 'headers': return 'Header'
    case 'public': return 'Öffentlich'
    case 'paused': return 'Pausiert'
    case 'internal': return 'Intern'
    case 'rollback': return 'Rollback'
    case 'recreate': return 'Neu erstellt'
    case 'auto_merge': return 'Auto-Deploy'
    case 'start': return 'Gestartet'
    case 'code': {
      const t = deployReasonTitle(d.reason, d.message)
      return t.length > 28 ? `${t.slice(0, 27)}…` : t
    }
    case 'first': return 'Erstes Deployment'
    default: return 'Neu deployt'
  }
}

export function groupSummary(rows: DeploymentDto[]): string {
  return [...new Set(rows.map(shortReason))].join(', ')
}

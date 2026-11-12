import type { IncidentListDto } from '@airlock/shared'

/**
 * Nacht 3, Etappe 5: Antwort von list_incidents (nur lesen). Ein MCP-Token
 * gehört zu einer Umgebung: darum nur Vorfälle ihrer Projekte – keine
 * Anmelde-Vorfälle des Servers (die nennen Adressen von Geräten und gelten
 * für alle Umgebungen) und keine Notizen. Rein, damit testbar.
 */
export function mcpIncidents(l: IncidentListDto): Record<string, unknown> {
  const own = l.incidents.filter((i) => i.project !== null)
  return {
    incidents: own.map((i) => ({
      id: i.id,
      project: i.project?.name ?? null,
      severity: i.severity,
      status: i.status,
      source: i.source,
      kind: i.kind,
      title: i.title,
      service: i.service,
      count: i.count,
      first_seen: i.firstSeen,
      last_seen: i.lastSeen,
      examples: i.samples.slice(0, 5),
      can_mark_normal: i.canMarkNormal,
    })),
    open_by_severity: own.reduce<Record<string, number>>((m, i) => {
      if (i.status !== 'erledigt') m[i.severity] = (m[i.severity] ?? 0) + 1
      return m
    }, {}),
    hint: 'Status ändern, als normal markieren und Container isolieren gehen nur in der Oberfläche (Security › Vorfälle, Projekt › Security).',
  }
}

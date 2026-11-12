import {
  attentionOf, mainUrlOf, sumCounts,
  type ProjectDto, type SummaryDto, type SummaryProjectDto, type TrafficSourceDto,
} from '@airlock/shared'

/**
 * Abgrenzung HomeBento: GET /api/v1/summary – eine lesende Übersicht der
 * Projekte einer Umgebung für Dashboards. Bewusst aus ProjectDto
 * herausgeschnitten statt durchgereicht: keine Env, keine Quelle (Repo-URL),
 * keine Logs, keine Fehlermeldungen, keine Befund-Texte.
 */
export interface SummaryInput {
  now: Date
  environment: string
  projects: ProjectDto[]
  /** Eindeutige Besucher heute je Projekt-ID */
  visitors: Record<string, number>
  ingest: TrafficSourceDto['ingest']
  /** Verfügbarkeit je Projekt-ID (fehlt: nicht gemessen) */
  uptime: Map<string, { h24: number | null; d30: number | null }>
  /** Zertifikat der internen Adressen; null ohne HTTPS */
  certificate: { expiresAt: string | null; daysLeft: number | null } | null
}

/** Ein Deploy läuft (Pille «deployt gerade») */
const isDeploying = (p: ProjectDto) => p.state.key === 'deploying'

export function buildSummary(i: SummaryInput): SummaryDto {
  const counting = i.ingest === 'ok'
  const projects: SummaryProjectDto[] = i.projects
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'de-CH'))
    .map((p) => {
      const att = attentionOf(p, i.now.getTime())
      const url = mainUrlOf(p.routes)
      // Zertifikat von Airlock: nur, wenn das Projekt eine HTTPS-Adresse im Tailnet/LAN hat
      const internalHttps = p.routes.some((r) => r.target !== 'public' && r.urls.some((u) => u.startsWith('https://')))
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        state: { key: p.state.key, label: p.state.label, tone: p.state.tone },
        url,
        public: p.routes.some((r) => r.target === 'public' && !r.pausedAt),
        grade: p.security?.grade ?? null,
        findings: { critical: 0, high: 0, medium: 0, low: 0, ...p.security?.open },
        attention: att !== null,
        attentionReason: att?.reason ?? null,
        attentionTone: att?.tone ?? null,
        visitorsToday: counting && p.routes.length > 0 ? i.visitors[p.id] ?? 0 : null,
        uptime24h: i.uptime.get(p.id)?.h24 ?? null,
        uptime30d: i.uptime.get(p.id)?.d30 ?? null,
        certificateExpiresAt: internalHttps ? i.certificate?.expiresAt ?? null : null,
        deploying: isDeploying(p),
      }
    })

  const deploying = i.projects
    .filter(isDeploying)
    .sort((a, b) => a.name.localeCompare(b.name, 'de-CH'))
    .map((p) => ({ projectId: p.id, name: p.name, startedAt: p.lastDeployment?.startedAt ?? i.now.toISOString() }))

  return {
    at: i.now.toISOString(),
    environment: i.environment,
    projects,
    deploying,
    totals: {
      projects: projects.length,
      running: i.projects.filter((p) => p.state.key === 'running' || p.state.key === 'paused').length,
      attention: projects.filter((p) => p.attention).length,
      public: projects.filter((p) => p.public).length,
      findings: sumCounts(i.projects.map((p) => p.security?.open)),
      visitorsToday: counting ? projects.reduce((n, p) => n + (p.visitorsToday ?? 0), 0) : null,
    },
    certificate: i.certificate,
  }
}

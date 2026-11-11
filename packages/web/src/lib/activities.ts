import { useIsMutating, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BackupStatusDto, DeploymentStatus, ProjectDto } from '@airlock/shared'
import { api } from '../api.js'
import { useProjects } from './projects.js'
import { FALLBACK_MS } from './live.js'

/**
 * Lange Vorgänge, die im Kopf als Aktivitätsanzeige erscheinen: Deploy, Scan,
 * Zertifikat, Tunnel. Die Quellen sind dieselben Abfragen wie auf den Seiten
 * (Projektliste, Cloudflare-Status) bzw. laufende Mutationen mit festem
 * Schlüssel (Tunnel anlegen) – deshalb bleibt die Anzeige beim Seitenwechsel.
 */

export type ActivityKind = 'deploy' | 'scan' | 'cert' | 'tunnel' | 'backup'

export interface RunningActivity {
  key: string
  kind: ActivityKind
  title: string
  /** Fortschritt in Worten, z. B. «Healthcheck (Schritt 3 von 4)» */
  detail: string
  /** 0–1, wenn bekannt */
  progress: number | null
  to: string
  startedAt: string | null
  projectId?: string
  /** Für den Tab-Titel: welches Projekt (wenn es nicht die offene Seite ist) */
  projectName?: string
}

/** Schlüssel der Mutationen, die als Vorgang zählen, solange sie laufen */
export const MUTATION_TUNNEL = ['cloudflare', 'tunnel'] as const

/** Schritte eines Deploys, wie DeployProgress sie zeigt */
const DEPLOY_STEPS: Partial<Record<DeploymentStatus, { n: number; label: string }>> = {
  pending: { n: 0, label: 'Wartet auf den Start' },
  pulling: { n: 1, label: 'Quelle holen' },
  starting: { n: 2, label: 'Starten' },
  healthchecking: { n: 3, label: 'Healthcheck' },
}
const DEPLOY_TOTAL = 4

export const isDeployRunning = (p: ProjectDto) => Boolean(p.lastDeployment && DEPLOY_STEPS[p.lastDeployment.status])
export const isScanRunning = (p: ProjectDto) => p.security?.status === 'queued' || p.security?.status === 'running'

export function deployActivity(p: ProjectDto): RunningActivity | null {
  const d = p.lastDeployment
  const step = d ? DEPLOY_STEPS[d.status] : undefined
  if (!d || !step) return null
  return {
    key: `deploy-${d.id}`,
    kind: 'deploy',
    title: `Deploy · ${p.name}`,
    detail: step.n === 0 ? step.label : `${step.label} (Schritt ${step.n} von ${DEPLOY_TOTAL})`,
    progress: step.n / DEPLOY_TOTAL,
    to: `/projekte/${p.id}`,
    startedAt: d.startedAt,
    projectId: p.id,
    projectName: p.name,
  }
}

export function scanActivity(p: ProjectDto): RunningActivity | null {
  if (!p.security || !isScanRunning(p)) return null
  return {
    key: `scan-${p.security.scanId}`,
    kind: 'scan',
    title: `Scan · ${p.name}`,
    detail: p.security.status === 'queued' ? 'Wartet in der Warteschlange' : 'Läuft',
    progress: null,
    to: `/projekte/${p.id}?tab=security`,
    startedAt: null,
    projectId: p.id,
    projectName: p.name,
  }
}

export function useActivities(): RunningActivity[] {
  const projects = useProjects()
  // Zertifikat: nur der Cloudflare-Status weiss davon; Phasen kommen über den Ereignisstrom, der Rest
  // (Tunnel, Zertifikatsprobe) sind Messwerte – einmal pro Minute, wie auf der Cloudflare-Seite
  const cf = useQuery({
    queryKey: ['cloudflare'],
    queryFn: api.cloudflare,
    refetchInterval: FALLBACK_MS,
    staleTime: 10_000,
  })
  const tunnel = useIsMutating({ mutationKey: [...MUTATION_TUNNEL] })
  // Backup: kein eigener Takt auf jeder Seite. Bekannt ist ein Lauf nur, wenn die
  // Backup-Seite ihn geladen oder gestartet hat; dann nachsehen, bis er fertig ist.
  const qc = useQueryClient()
  const backupKnownRunning = qc.getQueryData<BackupStatusDto>(['backup'])?.running === true
  const backup = useQuery({
    queryKey: ['backup'],
    queryFn: api.backup,
    enabled: backupKnownRunning,
    refetchInterval: (q) => (q.state.data?.running ? 3_000 : false),
  })

  const out: RunningActivity[] = []
  for (const p of projects.data?.projects ?? []) {
    const d = deployActivity(p)
    if (d) out.push(d)
    const s = scanActivity(p)
    if (s) out.push(s)
  }
  const phase = cf.data?.tls.phase
  if (phase === 'staging' || phase === 'production') {
    out.push({
      key: 'cert',
      kind: 'cert',
      title: 'Zertifikat',
      detail: phase === 'staging' ? 'Probelauf bei Let’s Encrypt (Schritt 1 von 2)' : 'Echtes Zertifikat holen (Schritt 2 von 2)',
      progress: phase === 'staging' ? 0.5 : 0.75,
      to: '/system/cloudflare',
      startedAt: cf.data?.tls.startedAt ?? null,
    })
  }
  if (backup.data?.running) {
    const run = backup.data.lastRun
    out.push({
      key: `backup-${run?.id ?? 'lauf'}`,
      kind: 'backup',
      title: 'Backup',
      detail: run?.trigger === 'schedule' ? 'Nächtliche Sicherung' : 'Sicherung von Hand',
      progress: null,
      to: '/server/backup',
      startedAt: run?.startedAt ?? null,
    })
  }
  if (tunnel > 0) {
    out.push({ key: 'tunnel', kind: 'tunnel', title: 'Tunnel', detail: 'Image holen, Container starten', progress: null, to: '/system/cloudflare', startedAt: null })
  }
  return out
}

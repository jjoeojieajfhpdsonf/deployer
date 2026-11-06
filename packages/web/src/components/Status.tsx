import type { ProjectStatus } from '@deployer/shared'

const LABELS: Record<ProjectStatus, string> = {
  created: 'angelegt',
  deploying: 'deployt gerade',
  running: 'läuft',
  stopped: 'gestoppt',
  failed: 'fehlgeschlagen',
}

export function StatusBadge({ status }: { status: ProjectStatus }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {LABELS[status]}
    </span>
  )
}

export function relativeTime(iso: string | null): string {
  if (!iso) return '–'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'gerade eben'
  if (min < 60) return `vor ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `vor ${h} h`
  return `vor ${Math.round(h / 24)} d`
}

export function duration(ms: number | null): string {
  if (ms === null) return '–'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

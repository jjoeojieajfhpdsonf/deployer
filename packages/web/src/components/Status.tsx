import type { ProjectStatus } from '@airlock/shared'

const LABELS: Record<ProjectStatus, string> = {
  created: 'angelegt',
  deploying: 'deployt',
  running: 'läuft',
  stopped: 'gestoppt',
  failed: 'fehlgeschlagen',
}

/** Zustand immer als Punkt UND Wort – nie nur Farbe. */
export function StatusBadge({ status }: { status: ProjectStatus }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {LABELS[status]}
    </span>
  )
}

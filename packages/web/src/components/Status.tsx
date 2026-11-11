import type { ProjectStateDto } from '@airlock/shared'

/** Ton des Zustands → Klasse der Pille */
const TONE_CLASS: Record<ProjectStateDto['tone'], string> = {
  ok: 'status-running',
  info: 'status-deploying',
  bad: 'status-failed',
  warn: 'status-warn',
  neutral: 'status-stopped',
}

/**
 * Zustand des Projekts als Pille: immer Punkt UND Wort – nie nur Farbe.
 * Einzige Quelle ist p.state vom Server (UI-Qualität 1).
 */
export function StatusBadge({ state }: { state: Pick<ProjectStateDto, 'label' | 'tone'> }) {
  return (
    <span className={`status ${TONE_CLASS[state.tone]}`}>
      <span className="status-dot" aria-hidden="true" />
      {state.label}
    </span>
  )
}

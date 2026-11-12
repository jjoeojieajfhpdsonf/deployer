import type { ScanHistoryItemDto } from '@airlock/shared'

/**
 * Verlauf der Scans eines Projekts (Reiter Security › Verlauf) und Alter der
 * Befunde. Reine Funktionen; die Abfragen stehen in scan.ts.
 */

export interface HistoryRun {
  id: string
  status: ScanHistoryItemDto['status']
  level: ScanHistoryItemDto['level']
  startedAt: Date
  finishedAt: Date | null
  score: number | null
  grade: ScanHistoryItemDto['grade']
  trigger: ScanHistoryItemDto['trigger']
}

export interface HistoryFinding {
  scanRunId: string
  fingerprint: string
  status: string
}

/**
 * Scans neueste zuerst, mit «neu» und «behoben» gegenüber dem vorherigen
 * abgeschlossenen Scan. Ein Befund zählt in einem Scan, solange er dort nicht
 * behoben ist (der Header-Nachscan setzt «fixed» im selben Scan). Akzeptierte
 * zählen mit: sie sind weiter da, nur bewusst hingenommen.
 */
export function scanHistory(runs: HistoryRun[], findings: HistoryFinding[]): ScanHistoryItemDto[] {
  const present = new Map<string, Set<string>>()
  for (const f of findings) {
    if (f.status === 'fixed') continue
    let s = present.get(f.scanRunId)
    if (!s) present.set(f.scanRunId, (s = new Set()))
    s.add(f.fingerprint)
  }
  const sorted = [...runs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
  return sorted.map((r, i) => {
    const prev = r.status === 'done' ? sorted.slice(i + 1).find((x) => x.status === 'done') : undefined
    let newCount: number | null = null
    let fixedCount: number | null = null
    if (prev) {
      const now = present.get(r.id) ?? new Set<string>()
      const before = present.get(prev.id) ?? new Set<string>()
      newCount = [...now].filter((fp) => !before.has(fp)).length
      fixedCount = [...before].filter((fp) => !now.has(fp)).length
    }
    return {
      id: r.id, status: r.status, level: r.level,
      startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
      score: r.score, grade: r.grade, trigger: r.trigger, newCount, fixedCount,
    }
  })
}

/**
 * Wann ein Befund (Fingerabdruck) zuerst vorkam und in wie vielen Scans.
 * runs: abgeschlossene Scans des Ziels mit Beginn; findings: deren Befunde.
 */
export function firstSeen(runs: { id: string; startedAt: Date }[], findings: { scanRunId: string; fingerprint: string }[]): Map<string, { firstSeenAt: string; seenIn: number }> {
  const start = new Map(runs.map((r) => [r.id, r.startedAt.getTime()]))
  const acc = new Map<string, { first: number; runs: Set<string> }>()
  for (const f of findings) {
    const t = start.get(f.scanRunId)
    if (t === undefined) continue
    const a = acc.get(f.fingerprint)
    if (!a) acc.set(f.fingerprint, { first: t, runs: new Set([f.scanRunId]) })
    else { a.first = Math.min(a.first, t); a.runs.add(f.scanRunId) }
  }
  return new Map([...acc].map(([fp, a]) => [fp, { firstSeenAt: new Date(a.first).toISOString(), seenIn: a.runs.size }]))
}

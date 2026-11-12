import { DISK_BLOCK_PERCENT, DISK_HINT_PERCENT, DISK_NOTIFY_PERCENT, type StorageDto } from '@airlock/shared'

/**
 * Nacht 3, Etappe 3: Antwort von get_disk_usage (nur lesen). Ein MCP-Token
 * gehört zu einer Umgebung, die Platte dem ganzen Server: darum nur Summen –
 * keine Namen von Volumes, Images oder Projekten (die verrieten Projekte
 * anderer Umgebungen). Rein, damit testbar.
 */
export function mcpDiskUsage(s: StorageDto): Record<string, unknown> {
  const gb = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round((n / 1e9) * 100) / 100)
  return {
    disk: s.disk
      ? { percent: s.disk.percent, usedGb: gb(s.disk.usedBytes), totalGb: gb(s.disk.totalBytes), level: s.disk.level }
      : null,
    thresholds: { hintPercent: DISK_HINT_PERCENT, notifyPercent: DISK_NOTIFY_PERCENT, blockDeploysPercent: DISK_BLOCK_PERCENT },
    deploysBlocked: s.deploysBlocked,
    categories: s.categories.map((c) => ({ key: c.key, label: c.label, sizeGb: gb(c.bytes), reclaimableGb: gb(c.reclaimableBytes), count: c.count })),
    cleanup: {
      wouldFreeGb: gb(s.plan.bytes),
      items: s.plan.byKind.map((k) => ({ kind: k.kind, count: k.count, sizeGb: gb(k.bytes) })),
      buildCache: s.plan.buildCache ? { count: s.plan.buildCache.count, sizeGb: gb(s.plan.buildCache.bytes) } : null,
      keepVersions: s.settings.keepVersions,
      lastRun: s.lastRun ? { at: s.lastRun.at, trigger: s.lastRun.trigger, freedGb: gb(s.lastRun.freedBytes), removed: s.lastRun.removed, failed: s.lastRun.failed } : null,
      nextRunAt: s.nextRunAt,
    },
    orphanVolumes: { count: s.orphanVolumes.length, sizeGb: gb(s.orphanVolumes.reduce((a, v) => a + (v.bytes ?? 0), 0)) },
    measuredAt: s.measuredAt,
    problems: s.problems,
    hint: 'Aufräumen und verwaiste Volumes löschen gehen nur in der Oberfläche unter Server › Speicher.',
  }
}

import { mergeLogLines, parseDockerLines, LOG_LINES_MAX, type LogLinesDto } from '@airlock/shared'
import * as docker from '../drivers/docker.js'
import { activeDeployment } from './deployments.js'

/**
 * UI-Qualität 4: Woher die Zeilen des Reiters «Logs» kommen. Ein Container –
 * oder bei Compose alle laufenden Dienste des Projekts (auch die bleibenden
 * wie die Datenbank), je mit Dienstnamen.
 */
export interface LogSource {
  service: string | null
  containerId: string
}

export async function logSources(project: { id: string; slug: string; sourceType: string }): Promise<LogSource[]> {
  const active = await activeDeployment(project.id)
  if (!active?.containerId) return []
  if (project.sourceType !== 'compose') return [{ service: null, containerId: active.containerId }]
  const all = await docker.listManagedContainers()
  const byService = new Map<string, LogSource>()
  for (const c of all) {
    const service = c.labels[docker.LABEL.composeService]
    if (c.legacy || !c.running || c.labels[docker.LABEL_PROJECT] !== project.slug || !service) continue
    // Pro Dienst einer; der der aktiven Fassung hat Vorrang
    const prev = byService.get(service)
    if (!prev || c.labels[docker.LABEL_DEPLOYMENT] === active.id) byService.set(service, { service, containerId: c.id })
  }
  const list = [...byService.values()].sort((a, b) => a.service!.localeCompare(b.service!))
  return list.length ? list : [{ service: null, containerId: active.containerId }]
}

/** Zeilen der letzten `minutes` Minuten, optional nur ein Dienst; gemischt nach Zeit */
export async function readLogLines(
  project: { id: string; slug: string; sourceType: string },
  o: { minutes: number; service?: string | null; max?: number },
): Promise<LogLinesDto> {
  const sources = await logSources(project)
  if (!sources.length) return { lines: [], services: [], hint: 'Kein laufender Container – es gibt noch keine Ausgabe.' }
  const services = sources.map((s) => s.service).filter((s): s is string => s !== null)
  const picked = o.service ? sources.filter((s) => s.service === o.service) : sources
  if (!picked.length) return { lines: [], services, hint: `Den Dienst «${o.service}» gibt es in diesem Projekt nicht (mehr).` }
  const since = Math.floor((Date.now() - o.minutes * 60_000) / 1000)
  const max = Math.min(o.max ?? LOG_LINES_MAX, LOG_LINES_MAX)
  const groups = await Promise.all(picked.map(async (s) =>
    parseDockerLines(await docker.getLogs(s.containerId, { tail: max, since, timestamps: true }).catch(() => ''), s.service)))
  return { lines: mergeLogLines(groups, max), services, hint: null }
}

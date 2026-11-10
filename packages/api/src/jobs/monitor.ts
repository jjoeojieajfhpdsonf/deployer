import { eq } from 'drizzle-orm'
import { request } from 'undici'
import { db, schema } from '../db/index.js'
import * as docker from '../drivers/docker.js'
import { activeDeployment, effectiveKind } from '../domain/deployments.js'
import { withProjectNetwork } from '../deploy/attach.js'
import { log } from '../lib/log.js'
import type { ProjectHealthDto, ResourceSample } from '@airlock/shared'

/**
 * Wie es den Projekten geht: CPU und RAM jede Minute (eine Stunde im
 * Speicher, nach einem Neustart von Airlock beginnt die Reihe neu) und ein
 * Healthcheck alle fünf Minuten – oder auf Anfrage, wenn jemand die
 * Übersicht öffnet. Nichts davon landet in der Datenbank: es ist ein Blick
 * auf den Moment, kein Monitoring-System.
 */

const SAMPLE_MS = 60_000
const PROBE_MS = 5 * 60_000
const PROBE_FRESH_MS = 30_000
const KEEP = 60

interface Probe { at: string; ok: boolean; status: number | null; error: string | null; ms: number }

const samples = new Map<string, ResourceSample[]>()
const probes = new Map<string, Probe>()
const probing = new Map<string, Promise<Probe | null>>()

interface Target { projectId: string; slug: string; containerId: string | null; host: string; network: string; port: number | null; path: string; kind: string }

async function targetFor(projectId: string): Promise<Target | null> {
  const rows = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1)
  const p = rows[0]
  if (!p) return null
  const active = await activeDeployment(p.id)
  if (!active) return null
  const kind = effectiveKind(p.sourceType, active.artifact)
  // Übergang: eine Fassung aus der deployer-Zeit läuft noch in dep_<slug>
  const legacy = await docker.legacyState().catch(() => docker.legacySnapshot())
  const ref = { id: active.id, webContainer: active.artifact?.webContainer ?? null }
  const host = docker.webContainerOf(p.slug, ref, legacy)
  const network = docker.networkOf(p.slug, ref, legacy)
  return { projectId: p.id, slug: p.slug, containerId: kind === 'compose' ? host : active.containerId, host, network, port: p.port, path: p.healthcheckPath ?? '/', kind }
}

/** Docker-Stats einmal lesen: CPU in Kernen, RAM in MB (ohne Datei-Cache). */
async function readStats(container: string): Promise<{ cpu: number; memMb: number } | null> {
  try {
    const s = (await docker.docker.getContainer(container).stats({ stream: false })) as unknown as {
      cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number; online_cpus?: number }
      precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number }
      memory_stats: { usage?: number; stats?: { inactive_file?: number; cache?: number } }
    }
    const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage
    const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0)
    const cores = s.cpu_stats.online_cpus ?? 1
    const cpu = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * cores : 0
    const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0
    const mem = Math.max(0, (s.memory_stats.usage ?? 0) - cache)
    return { cpu: Math.round(cpu * 1000) / 1000, memMb: Math.round(mem / 1024 / 1024) }
  } catch {
    return null
  }
}

async function sample(t: Target): Promise<void> {
  if (!t.containerId) return
  const s = await readStats(t.containerId)
  if (!s) return
  const list = samples.get(t.projectId) ?? []
  list.push({ at: new Date().toISOString(), ...s })
  samples.set(t.projectId, list.slice(-KEEP))
}

/** Ein Healthcheck wie beim Deploy, aber nur ein Versuch. */
async function probe(t: Target): Promise<Probe | null> {
  if (t.kind === 'static' || !t.port) return null
  const running = probing.get(t.projectId)
  if (running) return running
  const job = (async () => {
    const started = Date.now()
    const url = `http://${t.host}:${t.port}${t.path}`
    const result = await withProjectNetwork(t.network, async () => {
      try {
        const res = await request(url, { method: 'GET', headersTimeout: 5_000, bodyTimeout: 5_000 })
        await res.body.dump()
        const ok = res.statusCode >= 200 && res.statusCode < 400
        return { ok, status: res.statusCode, error: ok ? null : `HTTP ${res.statusCode}` }
      } catch (e) {
        return { ok: false, status: null, error: (e as Error).message }
      }
    }).catch((e: Error) => ({ ok: false, status: null, error: e.message }))
    const p: Probe = { at: new Date().toISOString(), ms: Date.now() - started, ...result }
    probes.set(t.projectId, p)
    return p
  })()
  probing.set(t.projectId, job)
  try {
    return await job
  } finally {
    probing.delete(t.projectId)
  }
}

async function runningProjectIds(): Promise<string[]> {
  const rows = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.desiredState, 'running'))
  return rows.map((r) => r.id)
}

let lastProbeRound = 0

async function tick(): Promise<void> {
  const doProbe = Date.now() - lastProbeRound >= PROBE_MS
  if (doProbe) lastProbeRound = Date.now()
  for (const id of await runningProjectIds()) {
    const t = await targetFor(id).catch(() => null)
    if (!t) continue
    await sample(t)
    if (doProbe) await probe(t).catch(() => null)
  }
  // Gelöschte oder gestoppte Projekte vergessen
  const keep = new Set(await runningProjectIds())
  for (const id of samples.keys()) if (!keep.has(id)) samples.delete(id)
}

export function startMonitorJob(): void {
  const run = () => void tick().catch((e) => log.warn('Monitor-Runde fehlgeschlagen', { err: String(e) }))
  setTimeout(run, 5_000)
  setInterval(run, SAMPLE_MS).unref()
}

/** Zustand für die Projekt-Übersicht. Mit fresh: Healthcheck auffrischen, wenn älter als 30 s. */
export async function projectHealth(projectId: string, opts: { fresh?: boolean } = {}): Promise<ProjectHealthDto> {
  const t = await targetFor(projectId)
  if (!t) return { kind: null, container: null, health: null, samples: [] }

  let health = probes.get(projectId) ?? null
  if (opts.fresh && (!health || Date.now() - new Date(health.at).getTime() > PROBE_FRESH_MS)) {
    health = (await probe(t).catch(() => null)) ?? health
  }
  // Ohne Reihe (frisch gestartet): sofort einen ersten Wert holen
  if (!samples.get(projectId)?.length) await sample(t)

  const state = t.containerId ? await docker.inspectContainer(t.containerId).catch(() => null) : null
  return {
    kind: t.kind,
    container: state
      ? { running: state.running, startedAt: state.startedAt, exitCode: state.exitCode }
      : t.containerId && t.kind !== 'static' ? { running: false, missing: true, startedAt: null, exitCode: null } : null,
    health: health ? { ...health, url: `${t.path}`, port: t.port } : null,
    samples: samples.get(projectId) ?? [],
  }
}

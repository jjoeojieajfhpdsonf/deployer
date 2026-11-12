import { and, eq, gte, inArray, lt, min, sql, sum } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { TrafficCount, TrafficDimCount } from './aggregate.js'

/**
 * Stundenzähler in PostgreSQL (traffic_hourly, traffic_dims) und Messbeginn
 * je Projekt (traffic_projects). Als Schnittstelle, damit Löschfrist und
 * Ingest ohne Datenbank testbar bleiben.
 */
export interface TrafficStore {
  /** Zähler addieren (gleiche Merkmale → views/visitors addiert) */
  write(rows: TrafficCount[], dims?: TrafficDimCount[]): Promise<void>
  /** Alle Zeilen eines Projekts ab Zeitpunkt */
  read(projectId: string, from: number): Promise<TrafficCount[]>
  /** Alle Merkmalszeilen eines Projekts ab Zeitpunkt */
  readDims(projectId: string, from: number): Promise<TrafficDimCount[]>
  /** Ältester Zähler eines Projekts (ms), null ohne Zähler */
  oldest(projectId: string): Promise<number | null>
  /** Messbeginn eines Projekts (ms), null wenn nie gemessen */
  since(projectId: string): Promise<number | null>
  /** Messbeginn setzen bzw. auf einen früheren Zeitpunkt vorziehen */
  markSince(entries: Map<string, number>): Promise<void>
  /** Gespeicherte Messbeginne aller Projekte */
  allSince(): Promise<Map<string, number>>
  /** Aufrufe (ohne Bots, nur 2xx/3xx) je Projekt ab Zeitpunkt */
  viewsSince(from: number): Promise<Map<string, number>>
  /** Projekte, die schon einmal eine HTML-Seite ausgeliefert haben (seit from) */
  projectsWithPages(from: number): Promise<Set<string>>
  /** Zeilen vor dem Zeitpunkt löschen; Anzahl gelöschter Zeilen */
  deleteBefore(cutoff: number): Promise<number>
}

const t = schema.trafficHourly
const d = schema.trafficDims
const p = schema.trafficProjects
const BATCH = 500

async function knownProjects(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  return new Set((await db.select({ id: schema.projects.id }).from(schema.projects).where(inArray(schema.projects.id, ids))).map((r) => r.id))
}

export const pgTrafficStore: TrafficStore = {
  async write(rows, dims = []) {
    if (!rows.length && !dims.length) return
    // Projekt inzwischen gelöscht: seine Zähler verwerfen statt den ganzen Flush scheitern zu lassen
    const known = await knownProjects([...new Set([...rows, ...dims].map((r) => r.projectId))])
    const keep = rows.filter((r) => known.has(r.projectId))
    for (let i = 0; i < keep.length; i += BATCH) {
      const chunk = keep.slice(i, i + BATCH).map((r) => ({ ...r, hour: new Date(r.hour) }))
      await db.insert(t).values(chunk).onConflictDoUpdate({
        target: [t.projectId, t.hour, t.way, t.path, t.country, t.city, t.referrer, t.device, t.status, t.bot],
        set: { views: sql`${t.views} + excluded.views`, visitors: sql`${t.visitors} + excluded.visitors` },
      })
    }
    const keepDims = dims.filter((r) => known.has(r.projectId))
    for (let i = 0; i < keepDims.length; i += BATCH) {
      const chunk = keepDims.slice(i, i + BATCH).map((r) => ({ ...r, hour: new Date(r.hour) }))
      await db.insert(d).values(chunk).onConflictDoUpdate({
        target: [d.projectId, d.hour, d.way, d.dim, d.value, d.bot],
        set: { views: sql`${d.views} + excluded.views`, visitors: sql`${d.visitors} + excluded.visitors` },
      })
    }
  },

  async read(projectId, from) {
    const rows = await db.select().from(t).where(and(eq(t.projectId, projectId), gte(t.hour, new Date(from))))
    return rows.map((r) => ({ ...r, hour: r.hour.getTime() }))
  },

  async readDims(projectId, from) {
    const rows = await db.select().from(d).where(and(eq(d.projectId, projectId), gte(d.hour, new Date(from))))
    return rows.map((r) => ({ ...r, hour: r.hour.getTime() }))
  },

  async oldest(projectId) {
    const r = await db.select({ first: min(t.hour) }).from(t).where(eq(t.projectId, projectId))
    return r[0]?.first ? new Date(r[0].first).getTime() : null
  },

  async since(projectId) {
    const r = await db.select({ since: p.measuredSince }).from(p).where(eq(p.projectId, projectId))
    return r[0]?.since ? r[0].since.getTime() : null
  },

  async markSince(entries) {
    const known = await knownProjects([...entries.keys()])
    for (const [projectId, at] of entries) {
      if (!known.has(projectId)) continue
      await db.insert(p).values({ projectId, measuredSince: new Date(at) }).onConflictDoUpdate({
        target: p.projectId,
        set: { measuredSince: sql`least(${p.measuredSince}, excluded.measured_since)` },
      })
    }
  },

  async allSince() {
    const rows = await db.select().from(p)
    return new Map(rows.map((r) => [r.projectId, r.measuredSince.getTime()]))
  },

  async viewsSince(from) {
    const rows = await db.select({ projectId: t.projectId, views: sum(t.views) }).from(t)
      .where(and(gte(t.hour, new Date(from)), eq(t.bot, false), gte(t.status, 100), lt(t.status, 400)))
      .groupBy(t.projectId)
    return new Map(rows.map((r) => [r.projectId, Number(r.views ?? 0)]))
  },

  async projectsWithPages(from) {
    // Seiten: Zeilen ohne Bot mit Pfad ohne Dateiendung oder .html – grob, reicht als Startwert
    const rows = await db.selectDistinct({ projectId: t.projectId }).from(t)
      .where(and(gte(t.hour, new Date(from)), eq(t.bot, false), sql`(${t.path} !~ '\\.[A-Za-z0-9]{1,8}$' OR ${t.path} ~* '\\.html?$')`))
    return new Set(rows.map((r) => r.projectId))
  },

  async deleteBefore(cutoff) {
    const r = await db.delete(t).where(lt(t.hour, new Date(cutoff)))
    const r2 = await db.delete(d).where(lt(d.hour, new Date(cutoff)))
    return (r.rowCount ?? 0) + (r2.rowCount ?? 0)
  },
}

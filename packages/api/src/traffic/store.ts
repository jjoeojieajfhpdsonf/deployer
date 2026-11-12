import { and, eq, gte, inArray, lt, min, sql, sum } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { TrafficCount } from './aggregate.js'

/**
 * Stundenzähler in PostgreSQL (traffic_hourly). Als Schnittstelle, damit
 * Löschfrist und Ingest ohne Datenbank testbar bleiben.
 */
export interface TrafficStore {
  /** Zähler addieren (gleiche Merkmale → views/visitors addiert) */
  write(rows: TrafficCount[]): Promise<void>
  /** Alle Zeilen eines Projekts ab Zeitpunkt */
  read(projectId: string, from: number): Promise<TrafficCount[]>
  /** Ältester Zähler eines Projekts (ms), null ohne Zähler */
  oldest(projectId: string): Promise<number | null>
  /** Aufrufe (ohne Bots) je Projekt ab Zeitpunkt */
  viewsSince(from: number): Promise<Map<string, number>>
  /** Projekte, die schon einmal eine HTML-Seite ausgeliefert haben (seit from) */
  projectsWithPages(from: number): Promise<Set<string>>
  /** Zeilen vor dem Zeitpunkt löschen; Anzahl gelöschter Zeilen */
  deleteBefore(cutoff: number): Promise<number>
}

const t = schema.trafficHourly
const BATCH = 500

export const pgTrafficStore: TrafficStore = {
  async write(rows) {
    if (!rows.length) return
    // Projekt inzwischen gelöscht: seine Zähler verwerfen statt den ganzen Flush scheitern zu lassen
    const ids = [...new Set(rows.map((r) => r.projectId))]
    const known = new Set((await db.select({ id: schema.projects.id }).from(schema.projects).where(inArray(schema.projects.id, ids))).map((r) => r.id))
    const keep = rows.filter((r) => known.has(r.projectId))
    for (let i = 0; i < keep.length; i += BATCH) {
      const chunk = keep.slice(i, i + BATCH).map((r) => ({ ...r, hour: new Date(r.hour) }))
      await db.insert(t).values(chunk).onConflictDoUpdate({
        target: [t.projectId, t.hour, t.way, t.path, t.country, t.city, t.referrer, t.device, t.status, t.bot],
        set: { views: sql`${t.views} + excluded.views`, visitors: sql`${t.visitors} + excluded.visitors` },
      })
    }
  },

  async read(projectId, from) {
    const rows = await db.select().from(t).where(and(eq(t.projectId, projectId), gte(t.hour, new Date(from))))
    return rows.map((r) => ({ ...r, hour: r.hour.getTime() }))
  },

  async oldest(projectId) {
    const r = await db.select({ first: min(t.hour) }).from(t).where(eq(t.projectId, projectId))
    return r[0]?.first ? new Date(r[0].first).getTime() : null
  },

  async viewsSince(from) {
    const rows = await db.select({ projectId: t.projectId, views: sum(t.views) }).from(t)
      .where(and(gte(t.hour, new Date(from)), eq(t.bot, false)))
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
    return r.rowCount ?? 0
  },
}

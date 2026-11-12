import type { TrafficDim, TrafficWay } from '@airlock/shared'

/**
 * Stundenzähler im Speicher, bis der nächste Flush sie in die Datenbank
 * addiert (store.ts). Ein Schlüssel ist die Kombination aller Merkmale
 * einer Zeile von traffic_hourly; gezählt wird, wie viele Aufrufe (views)
 * und wie viele erste Aufrufe eines Besuchers am Tag (visitors) darauf
 * fallen.
 */

export interface TrafficKey {
  projectId: string
  /** Beginn der Stunde, ms (UTC) */
  hour: number
  way: TrafficWay
  path: string
  country: string
  city: string
  referrer: string
  device: string
  status: number
  bot: boolean
}

export interface TrafficCount extends TrafficKey {
  views: number
  visitors: number
}

export const HOUR = 60 * 60_000
export const hourOf = (ms: number) => Math.floor(ms / HOUR) * HOUR

/** Höchstens so viele verschiedene Pfade je Projekt und Stunde (Pfad-Scanner); der Rest landet hier */
export const MAX_PATHS_PER_HOUR = 300
export const OTHER_PATHS = '(weitere Pfade)'

const keyOf = (k: TrafficKey) => [k.projectId, k.hour, k.way, k.path, k.country, k.city, k.referrer, k.device, k.status, k.bot ? 1 : 0].join('\u0001')

export class TrafficAggregator {
  private pending = new Map<string, TrafficCount>()
  /** Projekt + Stunde → bekannte Pfade (für die Obergrenze) */
  private paths = new Map<string, Set<string>>()

  add(k: TrafficKey, n: { views?: number; visitors?: number } = {}): void {
    const ph = `${k.projectId}\u0001${k.hour}`
    let known = this.paths.get(ph)
    if (!known) {
      known = new Set()
      this.paths.set(ph, known)
    }
    let path = k.path
    if (path && !known.has(path)) {
      if (known.size >= MAX_PATHS_PER_HOUR) path = OTHER_PATHS
      else known.add(path)
    }
    const key = { ...k, path }
    const id = keyOf(key)
    const row = this.pending.get(id)
    const views = n.views ?? 1
    const visitors = n.visitors ?? 0
    if (row) {
      row.views += views
      row.visitors += visitors
    } else {
      this.pending.set(id, { ...key, views, visitors })
    }
  }

  /** Alles Ausstehende herausnehmen (für den Flush) */
  drain(): TrafficCount[] {
    const rows = [...this.pending.values()]
    this.pending.clear()
    // Pfad-Zähler alter Stunden vergessen; die laufende behält ihre Pfade
    const current = hourOf(Date.now())
    for (const k of this.paths.keys()) if (Number(k.split('\u0001')[1]) < current) this.paths.delete(k)
    return rows
  }

  /** Flush gescheitert: zurücklegen, damit nichts verloren geht */
  restore(rows: TrafficCount[]): void {
    for (const r of rows) this.add(r, { views: r.views, visitors: r.visitors })
  }

  /** Ausstehende Zeilen (Kopie), optional nur eines Projekts – damit Abfragen auch die letzte Minute sehen */
  peek(projectId?: string): TrafficCount[] {
    const out: TrafficCount[] = []
    for (const r of this.pending.values()) if (!projectId || r.projectId === projectId) out.push({ ...r })
    return out
  }

  get size(): number {
    return this.pending.size
  }
}

/** Ein Merkmal in traffic_dims (Einstieg, Ausstieg, Sprache, Browser, System, Netz, Kampagne) */
export interface TrafficDimKey {
  projectId: string
  hour: number
  way: TrafficWay
  dim: TrafficDim
  value: string
  bot: boolean
}

export interface TrafficDimCount extends TrafficDimKey {
  views: number
  visitors: number
}

/** Höchstens so viele verschiedene Werte je Projekt, Stunde und Merkmal; der Rest landet bei OTHER_VALUES */
export const MAX_VALUES_PER_HOUR = 200
export const OTHER_VALUES = '(weitere)'

const dimKeyOf = (k: TrafficDimKey) => [k.projectId, k.hour, k.way, k.dim, k.value, k.bot ? 1 : 0].join('\u0001')

/** Wie TrafficAggregator, für traffic_dims */
export class TrafficDimAggregator {
  private pending = new Map<string, TrafficDimCount>()
  private values = new Map<string, Set<string>>()

  add(k: TrafficDimKey, n: { views?: number; visitors?: number } = {}): void {
    if (!k.value) return
    const vh = `${k.projectId}\u0001${k.hour}\u0001${k.dim}`
    let known = this.values.get(vh)
    if (!known) {
      known = new Set()
      this.values.set(vh, known)
    }
    let value = k.value
    if (!known.has(value)) {
      if (known.size >= MAX_VALUES_PER_HOUR) value = OTHER_VALUES
      else known.add(value)
    }
    const key = { ...k, value }
    const id = dimKeyOf(key)
    const row = this.pending.get(id)
    const views = n.views ?? 1
    const visitors = n.visitors ?? 0
    if (row) {
      row.views += views
      row.visitors += visitors
    } else {
      this.pending.set(id, { ...key, views, visitors })
    }
  }

  drain(): TrafficDimCount[] {
    const rows = [...this.pending.values()]
    this.pending.clear()
    const current = hourOf(Date.now())
    for (const k of this.values.keys()) if (Number(k.split('\u0001')[1]) < current) this.values.delete(k)
    return rows
  }

  restore(rows: TrafficDimCount[]): void {
    for (const r of rows) this.add(r, { views: r.views, visitors: r.visitors })
  }

  peek(projectId?: string): TrafficDimCount[] {
    const out: TrafficDimCount[] = []
    for (const r of this.pending.values()) if (!projectId || r.projectId === projectId) out.push({ ...r })
    return out
  }

  get size(): number {
    return this.pending.size
  }
}

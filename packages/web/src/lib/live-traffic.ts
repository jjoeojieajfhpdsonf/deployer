import type { TrafficLiveEventDto } from '@airlock/shared'

/**
 * Etappe 4 «Live-Verkehr» im Aufbau: Zählen und Bündeln – rein, ohne DOM.
 *
 * Jede Anfrage aus dem Live-Strom (GET /projects/:id/traffic/live) läuft
 * über die Linien Zugang → Host → Dienst; geblockte nur bis zum Host. Pro
 * Linie zählen Ein-Sekunden-Eimer die letzten 60 s («12/min»). Kommen auf
 * einem Weg mehr als 20 Anfragen pro Sekunde, wird gebündelt: die Linie
 * wird dicker, statt dass eine Punkteflut läuft – dann höchstens ein Punkt
 * alle 200 ms (zeigt weiter die Richtung). Zurück unter 15/s: wieder einzeln.
 */

export type LiveTone = 'ok' | '4xx' | '5xx'

export const liveTone = (status: number): LiveTone => (status >= 500 ? '5xx' : status >= 400 ? '4xx' : 'ok')

export const edgeKey = (from: string, to: string): string => `${from}>${to}`

export interface LiveRoute {
  /** Linien in Laufrichtung (1 oder 2) */
  edges: string[]
  /** Endet am Eingang mit ✕ (vom IP-Filter abgewiesen) */
  blocked: boolean
}

/**
 * Weg einer Anfrage über die Linien des Aufbaus. null, wenn der Zugang oder
 * der Host im Aufbau fehlt (z. B. Name inzwischen entfernt).
 */
export function routeOf(e: Pick<TrafficLiveEventDto, 'access' | 'host' | 'service' | 'blocked'>, edges: { from: string; to: string }[]): LiveRoute | null {
  const has = new Set(edges.map((x) => edgeKey(x.from, x.to)))
  const way = `way:${e.access}`
  const host = `host:${e.host.toLowerCase()}`
  const first = edgeKey(way, host)
  if (!has.has(first)) return null
  if (e.blocked || !e.service) return { edges: [first], blocked: e.blocked }
  const second = edgeKey(host, `svc:${e.service}`)
  return { edges: has.has(second) ? [first, second] : [first], blocked: false }
}

export interface EdgeCount {
  /** Anfragen in den letzten 60 s */
  n: number
  n4: number
  n5: number
  /** Davon am Eingang abgewiesen */
  blocked: number
}

interface Bucket { sec: number; n: number; n4: number; n5: number; blocked: number }

export interface MeterOptions {
  windowSec: number
  /** Ab so vielen Anfragen pro Sekunde auf einem Weg: bündeln */
  bundleAbove: number
  /** Darunter wieder einzeln */
  bundleBelow: number
  /** Gebündelt: höchstens ein Punkt pro so viele ms */
  bundledDotMs: number
}

const DEFAULTS: MeterOptions = { windowSec: 60, bundleAbove: 20, bundleBelow: 15, bundledDotMs: 200 }

export class TrafficMeter {
  private readonly o: MeterOptions
  private readonly buckets = new Map<string, Bucket[]>()
  /** Je Weg (Linien verbunden): Zeitpunkte der letzten Sekunde */
  private readonly recent = new Map<string, number[]>()
  private readonly bundled = new Set<string>()
  private readonly lastDot = new Map<string, number>()

  constructor(o: Partial<MeterOptions> = {}) {
    this.o = { ...DEFAULTS, ...o }
  }

  /** Eine Anfrage: zählen; ob ein Punkt laufen soll und ob der Weg gebündelt ist */
  add(route: LiveRoute, status: number, now: number): { dot: boolean; bundled: boolean } {
    const sec = Math.floor(now / 1000)
    const tone = liveTone(status)
    for (const e of route.edges) {
      const list = this.buckets.get(e) ?? []
      let b = list[list.length - 1]
      if (!b || b.sec !== sec) {
        b = { sec, n: 0, n4: 0, n5: 0, blocked: 0 }
        list.push(b)
        // Ältere Eimer als das Fenster fallen weg
        while (list.length && list[0]!.sec <= sec - this.o.windowSec) list.shift()
      }
      b.n++
      // Abgewiesene (403 vom IP-Filter) zählen als «abgewiesen», nicht zusätzlich als 4xx
      if (route.blocked) b.blocked++
      else if (tone === '4xx') b.n4++
      else if (tone === '5xx') b.n5++
      this.buckets.set(e, list)
    }
    const key = route.edges.join('|')
    const times = this.prune(key, now)
    times.push(now)
    // Speicher begrenzen: mehr als das Doppelte der Schwelle braucht niemand
    if (times.length > this.o.bundleAbove * 4) times.splice(0, times.length - this.o.bundleAbove * 4)
    if (times.length > this.o.bundleAbove) this.bundled.add(key)
    const isBundled = this.bundled.has(key)
    if (!isBundled) return { dot: true, bundled: false }
    const last = this.lastDot.get(key) ?? -Infinity
    if (now - last < this.o.bundledDotMs) return { dot: false, bundled: true }
    this.lastDot.set(key, now)
    return { dot: true, bundled: true }
  }

  private prune(key: string, now: number): number[] {
    const times = this.recent.get(key) ?? []
    while (times.length && times[0]! <= now - 1000) times.shift()
    this.recent.set(key, times)
    return times
  }

  /** Zähler je Linie über das Fenster (nur Linien mit Anfragen) */
  counts(now: number): Map<string, EdgeCount> {
    const sec = Math.floor(now / 1000)
    const out = new Map<string, EdgeCount>()
    for (const [edge, list] of this.buckets) {
      const c: EdgeCount = { n: 0, n4: 0, n5: 0, blocked: 0 }
      for (const b of list) {
        if (b.sec <= sec - this.o.windowSec) continue
        c.n += b.n
        c.n4 += b.n4
        c.n5 += b.n5
        c.blocked += b.blocked
      }
      if (c.n) out.set(edge, c)
    }
    return out
  }

  /** Linien gebündelter Wege; ein Weg unter der unteren Schwelle wird wieder einzeln */
  bundledEdges(now: number): Set<string> {
    const out = new Set<string>()
    for (const key of [...this.bundled]) {
      if (this.prune(key, now).length < this.o.bundleBelow) {
        this.bundled.delete(key)
        continue
      }
      for (const e of key.split('|')) out.add(e)
    }
    return out
  }

  /** Summe über alle Anfragen (erste Linie jedes Wegs zählt jede Anfrage genau einmal) */
  totals(now: number): EdgeCount {
    const t: EdgeCount = { n: 0, n4: 0, n5: 0, blocked: 0 }
    for (const [edge, c] of this.counts(now)) {
      if (!edge.startsWith('way:')) continue
      t.n += c.n
      t.n4 += c.n4
      t.n5 += c.n5
      t.blocked += c.blocked
    }
    return t
  }

  clear(): void {
    this.buckets.clear()
    this.recent.clear()
    this.bundled.clear()
    this.lastDot.clear()
  }
}

/** «12/min», ab 1000 «1.2k/min» (de-CH; passt zwischen zwei Spalten) */
export function formatRate(n: number): string {
  if (n < 1000) return `${n}/min`
  const k = n / 1000
  return `${k < 10 ? k.toLocaleString('de-CH', { maximumFractionDigits: 1 }) : Math.round(k)}k/min`
}

/**
 * Zähler, die zwischen denselben Spalten fast auf gleicher Höhe stünden,
 * untereinander schieben (Reihenfolge nach y bleibt, mindestens `gap` px).
 */
export function placeLabels<T extends { x: number; y: number }>(labels: T[], gap = 18): T[] {
  const byColumn = new Map<number, T[]>()
  for (const l of labels) {
    const col = Math.round(l.x / 40)
    byColumn.set(col, [...(byColumn.get(col) ?? []), l])
  }
  const out: T[] = []
  for (const list of byColumn.values()) {
    const sorted = [...list].sort((a, b) => a.y - b.y)
    let last = -Infinity
    for (const l of sorted) {
      const y = Math.max(l.y, last + gap)
      out.push({ ...l, y })
      last = y
    }
  }
  return out
}

/** Text für die Legende: Summe mit Wort, nie nur Farbe */
export function liveSummary(t: EdgeCount): string {
  if (!t.n) return 'keine Anfragen in der letzten Minute'
  const parts = [formatRate(t.n)]
  if (t.n4) parts.push(`${t.n4}× 4xx`)
  if (t.n5) parts.push(`${t.n5}× 5xx`)
  if (t.blocked) parts.push(`${t.blocked} abgewiesen`)
  return parts.join(' · ')
}

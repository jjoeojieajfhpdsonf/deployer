import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { TopologyEdgeDto, TrafficLiveEventDto } from '@airlock/shared'
import { subscribeTraffic } from '../api.js'
import {
  TrafficMeter, edgeKey, formatRate, liveSummary, liveTone, placeLabels, routeOf,
  type EdgeCount, type LiveRoute, type LiveTone,
} from '../lib/live-traffic.js'

/**
 * Etappe 4 «Live-Verkehr» im Aufbau. Ein Strom pro Projekt (LiveHub), den die
 * Fläche und der vergrösserte Dialog gemeinsam nutzen:
 *   - Punkte: je Anfrage einer, Zugang → Host → Dienst in 600 ms, linear
 *     (gleichmässiger Fluss). Nur transform und opacity, per WAAPI – die
 *     Bahn wird aus den Linien abgetastet (getPointAtLength) und als
 *     translate()-Schlüsselbilder abgespielt, ohne React-Render pro Punkt.
 *     Hinter der Host-Karte ist der Punkt verdeckt («geht durch Caddy»).
 *   - Geblockt: Punkt endet am Eingang, dort erscheint ✕ (160 ms ease-out, dann aus).
 *   - Über 20/s auf einem Weg: Linie dicker (Deckkraft 200 ms), höchstens ein Punkt alle 200 ms.
 *   - Zähler «12/min» an den Linien, Summe mit Worten in der Legende.
 *   - prefers-reduced-motion: nur Zähler. Versteckter Tab: Strom zu, nichts läuft.
 */

export interface Box { x: number; y: number; w: number; h: number; col: number }

export function edgePath(a: Box, b: Box): string {
  if (a.col === b.col) {
    // Gleiche Spalte (Datenbank → ihr Volume): Bogen rechts aussen, nie durch einen Knoten
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x + b.w, y2 = b.y + b.h / 2
    return `M${x1} ${y1} C${x1 + 18} ${y1}, ${x2 + 18} ${y2}, ${x2} ${y2}`
  }
  const [l, r] = a.col < b.col ? [a, b] : [b, a]
  const x1 = l.x + l.w, y1 = l.y + l.h / 2, x2 = r.x, y2 = r.y + r.h / 2
  const mx = (x1 + x2) / 2
  return `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
}

/** Mitte einer Linie zwischen zwei Spalten (Bezier mit Kontrollpunkten auf halber Strecke: genau die Mitte) */
function edgeMid(a: Box, b: Box): { x: number; y: number } {
  const [l, r] = a.col < b.col ? [a, b] : [b, a]
  return { x: (l.x + l.w + r.x) / 2, y: (l.y + l.h / 2 + r.y + r.h / 2) / 2 }
}

export type LiveState = 'connecting' | 'open' | 'retry' | 'paused'

export interface LiveSnap {
  state: LiveState
  counts: Map<string, EdgeCount>
  bundled: Set<string>
  totals: EdgeCount
}

const ZERO: EdgeCount = { n: 0, n4: 0, n5: 0, blocked: 0 }

export class LiveHub {
  readonly meter = new TrafficMeter()
  edges: Pick<TopologyEdgeDto, 'from' | 'to'>[] = []
  private snap: LiveSnap = { state: 'connecting', counts: new Map(), bundled: new Set(), totals: ZERO }
  private readonly listeners = new Set<() => void>()
  private readonly dots = new Set<(r: LiveRoute, tone: LiveTone) => void>()
  private timer = 0

  /** Eine Anfrage aus dem Strom */
  push(e: TrafficLiveEventDto, now = Date.now()): void {
    const route = routeOf(e, this.edges)
    if (!route) return
    const r = this.meter.add(route, e.status, now)
    if (r.dot) for (const fn of this.dots) fn(route, liveTone(e.status))
    // Zähler und Bündel zeitnah (höchstens alle 250 ms), nicht pro Anfrage
    if (!this.timer) this.timer = window.setTimeout(() => { this.timer = 0; this.refresh() }, r.bundled && !this.snap.bundled.size ? 0 : 250)
  }

  /** Zähler neu berechnen; meldet nur, wenn sich etwas geändert hat */
  refresh(now = Date.now()): void {
    const counts = this.meter.counts(now)
    const bundled = this.meter.bundledEdges(now)
    const totals = this.meter.totals(now)
    const same = counts.size === 0 && this.snap.counts.size === 0 && bundled.size === 0 && this.snap.bundled.size === 0
    if (same) return
    this.snap = { ...this.snap, counts, bundled, totals }
    this.emit()
  }

  setState(state: LiveState): void {
    if (this.snap.state === state) return
    this.snap = { ...this.snap, state }
    this.emit()
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): LiveSnap => this.snap

  onDot(fn: (r: LiveRoute, tone: LiveTone) => void): () => void {
    this.dots.add(fn)
    return () => this.dots.delete(fn)
  }

  dispose(): void {
    window.clearTimeout(this.timer)
    this.timer = 0
  }
}

/**
 * Strom eines Projekts mit Neuverbindung (5 s, 10 s, dann alle 30 s) und
 * Pause bei verstecktem Tab. Ereignisse eines versteckten Tabs gibt es nicht
 * nachzuholen – der Strom ist nur für jetzt.
 */
export function useLiveTraffic(projectId: string, edges: Pick<TopologyEdgeDto, 'from' | 'to'>[] | undefined): LiveHub {
  const hub = useMemo(() => new LiveHub(), [projectId])
  hub.edges = edges ?? []
  useEffect(() => {
    let close: (() => void) | null = null
    let retry = 0
    let retryTimer = 0
    const tick = window.setInterval(() => hub.refresh(), 1000)
    const connect = () => {
      window.clearTimeout(retryTimer)
      close?.()
      hub.setState(retry ? 'retry' : 'connecting')
      close = subscribeTraffic(projectId, (e) => hub.push(e), (open) => {
        if (open) { retry = 0; hub.setState('open'); return }
        close = null
        hub.setState('retry')
        const wait = [5_000, 10_000][retry] ?? 30_000
        retry++
        retryTimer = window.setTimeout(() => { if (document.visibilityState === 'visible') connect() }, wait)
      })
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (!close) connect()
      } else {
        window.clearTimeout(retryTimer)
        close?.()
        close = null
        hub.setState('paused')
      }
    }
    if (document.visibilityState === 'visible') connect()
    else hub.setState('paused')
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(tick)
      window.clearTimeout(retryTimer)
      close?.()
      hub.dispose()
    }
  }, [hub, projectId])
  return hub
}

const useSnap = (hub: LiveHub) => useSyncExternalStore(hub.subscribe, hub.getSnapshot)

/** Höchstens so viele Punkte gleichzeitig je Fläche */
const MAX_DOTS = 80
const FULL_MS = 600
const HALF_MS = 360

/**
 * Ebene über den Linien und unter den Knoten: Punkte (imperativ), dicke
 * Linien gebündelter Wege, Zähler an den Linien (darüber, damit lesbar).
 */
export function LiveLayer({ hub, boxes, reduced }: { hub: LiveHub; boxes: Map<string, Box>; reduced: boolean }) {
  const snap = useSnap(hub)
  const layer = useRef<HTMLDivElement>(null)
  const measure = useRef<SVGSVGElement>(null)
  const routeEdges = useMemo(() => hub.edges.filter((e) => boxes.has(e.from) && boxes.has(e.to) && (e.from.startsWith('way:') || e.from.startsWith('host:'))), [hub.edges, boxes])

  useEffect(() => {
    if (reduced) return
    let running = 0
    return hub.onDot((route, tone) => {
      const el = layer.current
      const svg = measure.current
      if (!el || !svg || running >= MAX_DOTS) return
      const paths = route.edges.map((k) => svg.querySelector<SVGPathElement>(`path[data-edge="${CSS.escape(k)}"]`))
      if (paths.some((p) => !p)) return
      const pts: { x: number; y: number; at: number }[] = []
      let len = 0
      let prev: DOMPoint | null = null
      for (const p of paths as SVGPathElement[]) {
        const total = p.getTotalLength()
        const steps = Math.max(8, Math.ceil(total / 24))
        for (let i = 0; i <= steps; i++) {
          const pt = p.getPointAtLength((total * i) / steps)
          // Auch der Sprung durch die Host-Karte zählt als Weg: gleichmässiges Tempo
          if (prev) len += Math.hypot(pt.x - prev.x, pt.y - prev.y)
          pts.push({ x: pt.x, y: pt.y, at: len })
          prev = pt
        }
      }
      if (!len) return
      const fade = 0.08
      const frames = pts.map((p) => {
        const o = p.at / len
        return { transform: `translate(${p.x}px, ${p.y}px)`, opacity: route.blocked ? Math.min(1, o / fade) : Math.min(1, o / fade, (1 - o) / fade), offset: o }
      })
      const dot = document.createElement('i')
      dot.className = `topo-live-dot topo-live-${tone}`
      el.append(dot)
      running++
      const ms = route.edges.length > 1 ? FULL_MS : HALF_MS
      const done = () => { dot.remove(); running-- }
      dot.animate(frames, { duration: ms, easing: 'linear', fill: 'forwards' }).finished.then(() => {
        done()
        if (!route.blocked) return
        // ✕ am Eingang: kurz einblenden, stehen lassen, ausblenden
        const end = pts[pts.length - 1]!
        const x = document.createElement('i')
        x.className = 'topo-live-x'
        x.textContent = '✕'
        el.append(x)
        const at = `translate(${end.x}px, ${end.y}px) translate(-50%, -50%)`
        x.animate([
          { transform: `${at} scale(0.9)`, opacity: 0 },
          { transform: `${at} scale(1)`, opacity: 1, offset: 0.25 },
          { transform: `${at} scale(1)`, opacity: 1, offset: 0.7 },
          { transform: `${at} scale(1)`, opacity: 0 },
        ], { duration: 640, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }).finished.then(() => x.remove(), () => x.remove())
      }, done)
    })
  }, [hub, reduced])

  const labels = placeLabels(
    [...snap.counts].flatMap(([key, c]) => {
      const [from, to] = key.split('>') as [string, string]
      const a = boxes.get(from)
      const b = boxes.get(to)
      if (!a || !b || a.col === b.col) return []
      return [{ key, n: c.n, ...edgeMid(a, b) }]
    }),
  )

  return (
    <>
      <div className="topo-live" aria-hidden="true">
        <svg ref={measure} className="topo-live-svg">
          {routeEdges.map((e) => {
            const k = edgeKey(e.from, e.to)
            const d = edgePath(boxes.get(e.from)!, boxes.get(e.to)!)
            return (
              <g key={k}>
                <path data-edge={k} d={d} className="topo-live-track" />
                {!reduced && <path d={d} className={`topo-live-bundle${snap.bundled.has(k) ? ' topo-live-bundle-on' : ''}`} />}
              </g>
            )
          })}
        </svg>
        <div ref={layer} className="topo-live-dots" />
      </div>
      {/* Zähler: die Summe mit Worten steht in der Legende (für Screenreader dort) */}
      <div className="topo-rates" aria-hidden="true">
        {labels.map((l) => (
          <span key={l.key} className="topo-rate num" style={{ transform: `translate(${l.x}px, ${l.y}px) translate(-50%, -50%)` }}>{formatRate(l.n)}</span>
        ))}
      </div>
    </>
  )
}

/** Legende: Bedeutung der Punkte (mit Wort) und die Summe der letzten Minute */
export function LiveLegend({ hub, reduced }: { hub: LiveHub; reduced: boolean }) {
  const snap = useSnap(hub)
  const text = snap.state === 'paused' ? 'pausiert (Tab im Hintergrund)'
    : snap.state === 'retry' ? 'getrennt – neuer Versuch gleich'
    : snap.state === 'connecting' ? 'verbindet …'
    : liveSummary(snap.totals)
  return (
    <>
      {!reduced && (
        <span className="topo-legend-live">
          <span><i className="topo-legend-dot topo-live-ok" aria-hidden="true" />Anfrage</span>
          <span><i className="topo-legend-dot topo-live-4xx" aria-hidden="true" />4xx</span>
          <span><i className="topo-legend-dot topo-live-5xx" aria-hidden="true" />5xx</span>
          <span><span className="topo-legend-x" aria-hidden="true">✕</span>abgewiesen</span>
        </span>
      )}
      <span className="topo-legend-sum">Live: <span className="num">{text}</span></span>
    </>
  )
}

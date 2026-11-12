import { useMemo, useState } from 'react'
import topology from 'world-atlas/countries-110m.json'
import { countryName, type TrafficRowDto } from '@airlock/shared'
import { MAP_VIEWS, countryShapes, type MapView, type Topology } from '../lib/world-map.js'
import { mapLevel, mapSteps, nf, plural, stepLabel } from '../lib/traffic-view.js'

/**
 * Weltkarte (einfaches SVG) der Karte «Woher die Besucher kommen»: Länder
 * in bis zu vier Stufen eingefärbt (Token-Skala --map-1 … --map-4, Legende
 * mit Zahlenbereichen), Tooltip mit Land und Anzahl per Maus und Tastatur
 * (Länder mit Aufrufen sind fokussierbar), grüner Punkt in der Mitte des
 * Landes des letzten Aufrufs (nur Land, nie Koordinaten des Besuchers).
 * Ausschnitt Welt oder Europa. Wird erst geladen, wenn der Reiter Länder
 * zeigt (eigener Chunk).
 *
 * Geometrie: Natural Earth 1:110 Mio. (gemeinfrei) über world-atlas (ISC).
 */

let shapes: ReturnType<typeof countryShapes> | null = null

export default function WorldMap({ countries, view, last }: {
  countries: TrafficRowDto[]
  view: MapView
  /** Herkunft des letzten Aufrufs (Land, optional Stadt) */
  last?: { country: string; city?: string } | null
}) {
  shapes ??= countryShapes(topology as unknown as Topology)
  const byCode = useMemo(() => new Map(countries.map((c) => [c.key, c.views])), [countries])
  const max = Math.max(0, ...countries.filter((c) => c.key && c.key !== 'T1').map((c) => c.views))
  const steps = mapSteps(max)
  const [tip, setTip] = useState<string | null>(null)
  const v = MAP_VIEWS[view]
  const pct = (x: number, y: number) => ({ left: `${((x - v.x) / v.w) * 100}%`, top: `${((y - v.y) / v.h) * 100}%` })
  const lastShape = last?.country ? shapes.find((s) => s.code === last.country) : undefined
  const tipShape = tip ? shapes.find((s) => s.code === tip) : undefined
  const tipViews = tip ? byCode.get(tip) ?? 0 : 0
  const top = countries.filter((c) => c.key && c.key !== 'T1').slice(0, 3).map((c) => `${countryName(c.key)} ${nf(c.views)}`)
  // Gezeichnet: ohne Länder ausserhalb des Ausschnitts (Europa: Tab-Reihenfolge nur über Sichtbares)
  const visible = view === 'world' ? shapes : shapes.filter((s) => s.cx >= v.x - 5 && s.cx <= v.x + v.w + 5 && s.cy >= v.y - 5 && s.cy <= v.y + v.h + 5)
  const inView = (s: { cx: number; cy: number }) => s.cx >= v.x && s.cx <= v.x + v.w && s.cy >= v.y && s.cy <= v.y + v.h

  return (
    <figure className="vs-map">
      <div className={`vs-map-plot vs-map-${view}`} onMouseLeave={() => setTip(null)}>
        <svg
          viewBox={`${v.x} ${v.y} ${v.w} ${v.h}`}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          aria-label={`${view === 'world' ? 'Weltkarte' : 'Europakarte'} der Aufrufe nach Land${top.length ? `: ${top.join(', ')}` : ''}. Länder mit Aufrufen per Tabulator erreichbar.`}
        >
          {visible.map((s) => {
            const n = byCode.get(s.code) ?? 0
            const level = mapLevel(n, steps)
            return (
              <path
                key={s.code}
                d={s.d}
                className={`vs-map-c vs-map-${level}`}
                vectorEffect="non-scaling-stroke"
                onMouseEnter={() => setTip(s.code)}
                {...(n > 0 && inView(s) ? {
                  tabIndex: 0,
                  role: 'img',
                  'aria-label': `${countryName(s.code)}: ${plural(n, 'Aufruf', 'Aufrufe')}`,
                  onFocus: () => setTip(s.code),
                  onBlur: () => setTip(null),
                } : { 'aria-hidden': true })}
              />
            )
          })}
        </svg>
        {lastShape && inView(lastShape) && <span className="vs-map-last" style={pct(lastShape.cx, lastShape.cy)} aria-hidden="true" />}
        {tipShape && (
          <span className={`vs-map-tip${(tipShape.cx - v.x) / v.w > 0.7 ? ' vs-map-tip-left' : ''}`} style={pct(tipShape.cx, tipShape.cy)} aria-hidden="true">
            <strong>{countryName(tipShape.code)}</strong> {tipViews ? plural(tipViews, 'Aufruf', 'Aufrufe') : 'keine Aufrufe'}
          </span>
        )}
      </div>
      <figcaption className="vs-map-legend">
        {steps.map((_, i) => (
          <span key={i}><i className={`vs-swatch vs-map-${4 - (steps.length - 1 - i)}`} aria-hidden="true" />{stepLabel(steps, i)}</span>
        ))}
        {steps.length > 0 && <span className="sr-only"> Aufrufe je Land</span>}
        {last?.country && (
          <span><i className="vs-swatch vs-swatch-last" aria-hidden="true" />letzter Aufruf · {last.city || countryName(last.country)}</span>
        )}
      </figcaption>
    </figure>
  )
}

import { useMemo } from 'react'
import topology from 'world-atlas/countries-110m.json'
import { countryName, type TrafficRowDto } from '@airlock/shared'
import { MAP_HEIGHT, MAP_WIDTH, countryShapes, type Topology } from '../lib/world-map.js'

/**
 * Weltkarte (einfaches SVG): Länder nach Aufrufen eingefärbt, vier Stufen
 * plus «keine». Die Zahlen stehen in der Tabelle daneben; die Karte ist nur
 * die Übersicht (deshalb ein Bild mit Beschreibung, keine Bedienelemente).
 * Wird erst geladen, wenn die Seite «Besucher» Länder zeigt (eigener Chunk).
 *
 * Geometrie: Natural Earth 1:110 Mio. (gemeinfrei) über world-atlas (ISC).
 */

let shapes: ReturnType<typeof countryShapes> | null = null

/** Stufe 1–4 nach Anteil am stärksten Land (Wurzel: kleine Werte bleiben sichtbar) */
export function levelOf(views: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (views <= 0 || max <= 0) return 0
  const r = Math.sqrt(views / max)
  return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1
}

export default function WorldMap({ countries }: { countries: TrafficRowDto[] }) {
  shapes ??= countryShapes(topology as unknown as Topology)
  const byCode = useMemo(() => new Map(countries.map((c) => [c.key, c.views])), [countries])
  const max = Math.max(0, ...countries.map((c) => c.views))
  const top = countries.filter((c) => c.key && c.key !== 'T1').slice(0, 3).map((c) => `${countryName(c.key)} ${c.views.toLocaleString('de-CH')}`)
  return (
    <figure className="tr-map">
      <svg viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} role="img" aria-label={`Weltkarte der Aufrufe nach Land${top.length ? `: ${top.join(', ')}` : ''}. Alle Zahlen in der Tabelle.`}>
        {shapes.map((s) => {
          const v = byCode.get(s.code) ?? 0
          return (
            <path key={s.code} d={s.d} className={`tr-map-c tr-map-${levelOf(v, max)}`}>
              <title>{`${countryName(s.code)}: ${v ? `${v.toLocaleString('de-CH')} ${v === 1 ? 'Aufruf' : 'Aufrufe'}` : 'keine Aufrufe'}`}</title>
            </path>
          )
        })}
      </svg>
      <figcaption className="tr-map-legend">
        <span>weniger</span>
        {[1, 2, 3, 4].map((l) => <i key={l} className={`tr-map-swatch tr-map-${l}`} aria-hidden="true" />)}
        <span>mehr Aufrufe</span>
      </figcaption>
    </figure>
  )
}

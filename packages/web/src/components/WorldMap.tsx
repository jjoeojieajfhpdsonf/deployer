import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import topology from 'world-atlas/countries-110m.json'
import { countryName, type TrafficRowDto } from '@airlock/shared'
import { MAP_MIN_W, MAP_VIEWS, MAP_WIDTH, countryShapes, panBox, sameBox, zoomBox, type MapBox, type MapView, type Topology } from '../lib/world-map.js'
import { mapLevel, mapSteps, nf, plural, stepLabel } from '../lib/traffic-view.js'
import { IconFit, IconMinus, IconPlus } from './Icons.js'

/**
 * Weltkarte (einfaches SVG) der Karte «Woher die Besucher kommen»: Länder
 * in bis zu vier Stufen eingefärbt (Token-Skala --map-1 … --map-4, Legende
 * mit Zahlenbereichen), Tooltip mit Land und Anzahl per Maus und Tastatur
 * (Länder mit Aufrufen sind fokussierbar), grüner Punkt in der Mitte des
 * Landes des letzten Aufrufs (nur Land, nie Koordinaten des Besuchers).
 * Ausschnitt Welt oder Europa. Seit «Besucher zusammen» ist jedes Land mit
 * Aufrufen ein Link (Klick, Enter) zu den Einzelaufrufen aus diesem Land.
 * Wird erst geladen, wenn der Reiter Länder
 * zeigt (eigener Chunk).
 *
 * Zoom: Knöpfe + / − / ganzer Ausschnitt, Strg/⌘ + Scrollen oder
 * Zwei-Finger-Zoom (um den Zeiger), Ziehen verschiebt; auf einem Land
 * verschieben die Pfeiltasten, + und − zoomen, 0 setzt zurück. Ohne
 * Animation: Zoomen ist eine häufige, direkte Bedienung.
 *
 * Geometrie: Natural Earth 1:110 Mio. (gemeinfrei) über world-atlas (ISC).
 */

let shapes: ReturnType<typeof countryShapes> | null = null

/** Ab dieser Strecke (px) ist ein Druck ein Ziehen und kein Klick */
const DRAG_PX = 4

export default function WorldMap({ countries, view, last, href }: {
  countries: TrafficRowDto[]
  view: MapView
  /** Herkunft des letzten Aufrufs (Land, optional Stadt) */
  last?: { country: string; city?: string } | null
  /** Suchteil der Einzelaufrufe zu einem Land (ohne: Länder sind keine Links) */
  href?: (code: string) => string | null
}) {
  const navigate = useNavigate()
  const to = href
  const go = (code: string) => {
    const search = href?.(code)
    if (search) navigate({ search })
  }
  shapes ??= countryShapes(topology as unknown as Topology)
  const byCode = useMemo(() => new Map(countries.map((c) => [c.key, c.views])), [countries])
  const max = Math.max(0, ...countries.filter((c) => c.key && c.key !== 'T1').map((c) => c.views))
  const steps = mapSteps(max)
  const [tip, setTip] = useState<string | null>(null)
  // Land mit Tastaturfokus: sein Tooltip bleibt, wenn die Maus die Karte verlässt
  const focusedCode = useRef<string | null>(null)

  // Ausschnitt: beginnt bei Welt bzw. Europa; ein Wechsel oben setzt den Zoom zurück
  const home = MAP_VIEWS[view]
  const [shown, setShown] = useState<MapView>(view)
  const [v, setBox] = useState<MapBox>(home)
  if (shown !== view) {
    setShown(view)
    setBox(home)
  }
  const zoomed = !sameBox(v, home)
  const canPan = v.w < MAP_WIDTH - 0.1
  const canIn = v.w > MAP_MIN_W + 0.1

  const plot = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; box: MapBox; moved: boolean } | null>(null)
  const swallowClick = useRef(false)
  const [dragging, setDragging] = useState(false)

  // Strg/⌘ + Scrollen und Zwei-Finger-Zoom (kommt als Scrollen mit Strg): um den Zeiger.
  // Ohne Taste scrollt die Seite weiter. Eigener Listener, weil React onWheel passiv ist.
  useEffect(() => {
    const el = plot.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const fx = (e.clientX - r.left) / r.width
      const fy = (e.clientY - r.top) / r.height
      const dy = Math.max(-50, Math.min(50, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY))
      const f = Math.exp(-dy * 0.01)
      setBox((b) => zoomBox(b, f, b.x + fx * b.w, b.y + fy * b.h))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    swallowClick.current = false
    if (e.button !== 0 || !canPan || (e.target as Element).closest('.vs-map-zoom')) return
    drag.current = { x: e.clientX, y: e.clientY, box: v, moved: false }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_PX) return
      d.moved = true
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(true)
      setTip(null)
    }
    const r = e.currentTarget.getBoundingClientRect()
    setBox(panBox(d.box, (-dx / r.width) * d.box.w, (-dy / r.height) * d.box.h))
  }
  const endDrag = () => {
    if (drag.current?.moved) swallowClick.current = true
    drag.current = null
    setDragging(false)
  }
  // Nach dem Ziehen kein Klick auf das Land unter dem Zeiger
  const onClickCapture = (e: MouseEvent) => {
    if (!swallowClick.current) return
    swallowClick.current = false
    e.stopPropagation()
    e.preventDefault()
  }

  const zoomBy = (f: number, at?: { cx: number; cy: number }) => setBox((b) => zoomBox(b, f, at?.cx, at?.cy))
  // Tastatur auf einem Land: Pfeile verschieben (ein Sechstel des Ausschnitts), + / − zoomen um dieses Land, 0 zurück
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.target instanceof SVGPathElement) || e.altKey || e.ctrlKey || e.metaKey) return
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
    if (step && canPan) setBox((b) => panBox(b, (step[0]! * b.w) / 6, (step[1]! * b.h) / 6))
    else if (e.key === '+' || e.key === '=') zoomBy(2, tipShape)
    else if (e.key === '-') zoomBy(0.5, tipShape)
    else if (e.key === '0') setBox(home)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  const pct = (x: number, y: number) => ({ left: `${((x - v.x) / v.w) * 100}%`, top: `${((y - v.y) / v.h) * 100}%` })
  const lastShape = last?.country ? shapes.find((s) => s.code === last.country) : undefined
  const tipShape = tip ? shapes.find((s) => s.code === tip) : undefined
  const tipViews = tip ? byCode.get(tip) ?? 0 : 0
  const top = countries.filter((c) => c.key && c.key !== 'T1').slice(0, 3).map((c) => `${countryName(c.key)} ${nf(c.views)}`)
  const inView = (s: { cx: number; cy: number }) => s.cx >= v.x && s.cx <= v.x + v.w && s.cy >= v.y && s.cy <= v.y + v.h
  const where = zoomed ? 'Vergrösserte Karte' : view === 'world' ? 'Weltkarte' : 'Europakarte'
  const homeName = view === 'world' ? 'Welt' : 'Europa'

  return (
    <figure className="vs-map">
      <div
        ref={plot}
        className={`vs-map-plot vs-map-${view}${canPan ? ' vs-map-pan' : ''}${dragging ? ' vs-map-dragging' : ''}`}
        onMouseLeave={() => setTip(focusedCode.current)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={onClickCapture}
        onKeyDown={onKeyDown}
      >
        <svg
          viewBox={`${v.x} ${v.y} ${v.w} ${v.h}`}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          aria-label={`${where} der Aufrufe nach Land${top.length ? `: ${top.join(', ')}` : ''}. Länder mit Aufrufen im Ausschnitt per Tabulator erreichbar${href ? ', Enter zeigt ihre Einzelaufrufe' : ''}; dort verschieben die Pfeiltasten die Karte, Plus und Minus zoomen.`}
        >
          {shapes.map((s) => {
            const n = byCode.get(s.code) ?? 0
            const level = mapLevel(n, steps)
            return (
              <path
                key={s.code}
                d={s.d}
                className={`vs-map-c vs-map-${level}`}
                vectorEffect="non-scaling-stroke"
                onMouseEnter={() => { if (!drag.current?.moved) setTip(s.code) }}
                // Fokussierbar nur im Ausschnitt (Tab-Reihenfolge über Sichtbares); das fokussierte Land
                // bleibt es auch, wenn es beim Verschieben hinausrutscht
                {...(n > 0 && (inView(s) || s.code === tip) ? {
                  tabIndex: 0,
                  // Besucher zusammen: ein Land mit Aufrufen ist ein Link zu den Einzelaufrufen
                  role: to ? 'link' : 'img',
                  'aria-label': `${countryName(s.code)}: ${plural(n, 'Aufruf', 'Aufrufe')}${to ? ' – Einzelaufrufe zeigen' : ''}`,
                  onFocus: () => { focusedCode.current = s.code; setTip(s.code) },
                  onBlur: () => { focusedCode.current = null; setTip(null) },
                  ...(to ? {
                    className: `vs-map-c vs-map-${level} vs-map-link`,
                    onClick: () => go(s.code),
                    onKeyDown: (e: KeyboardEvent<SVGPathElement>) => { if (e.key === 'Enter') { e.preventDefault(); go(s.code) } },
                  } : {}),
                } : { 'aria-hidden': true })}
              />
            )
          })}
        </svg>
        {lastShape && inView(lastShape) && <span className="vs-map-last" style={pct(lastShape.cx, lastShape.cy)} aria-hidden="true" />}
        {tipShape && inView(tipShape) && (
          <span className={`vs-map-tip${(tipShape.cx - v.x) / v.w > 0.7 ? ' vs-map-tip-left' : ''}`} style={pct(tipShape.cx, tipShape.cy)} aria-hidden="true">
            <strong>{countryName(tipShape.code)}</strong> {tipViews ? plural(tipViews, 'Aufruf', 'Aufrufe') : 'keine Aufrufe'}
          </span>
        )}
        <div className="vs-map-zoom" role="group" aria-label="Kartenzoom" title="Auch mit Strg/⌘ + Scrollen oder zwei Fingern; Ziehen verschiebt">
          {/* aria-disabled statt disabled: der Fokus bleibt auf dem Knopf, auch an der Grenze */}
          <button type="button" className="icon-button" aria-label="Vergrössern" aria-disabled={!canIn} onClick={() => canIn && zoomBy(2)}>
            <IconPlus size={14} />
          </button>
          <button type="button" className="icon-button" aria-label="Verkleinern" aria-disabled={!canPan} onClick={() => canPan && zoomBy(0.5)}>
            <IconMinus size={14} />
          </button>
          <button type="button" className="icon-button" aria-label={`Ganzer Ausschnitt ${homeName}`} aria-disabled={!zoomed} onClick={() => zoomed && setBox(home)}>
            <IconFit size={14} />
          </button>
        </div>
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

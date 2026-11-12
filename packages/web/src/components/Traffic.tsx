import { useId, useState, type CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  TRAFFIC_CARD_RANGES, trafficRange,
  type TrafficBucket, type TrafficPointDto, type TrafficRange, type TrafficWay, type ProjectDto,
} from '@airlock/shared'
import { api } from '../api.js'
import { poll } from '../lib/live.js'
import { fmtDayMonth, fmtTime, fmtWeekday } from '../lib/dates.js'
import { ErrorState, Loading, Sk } from './States.js'

/**
 * Etappe 3 «Besucher und Herkunft»: Karte in der Übersicht, Abfragen und
 * Projektliste. Der Reiter «Besucher» selbst steht seit «Besucher neu» in
 * VisitorsTab.tsx (Kurve: VisitorsChart.tsx, Karte: WorldMap.tsx).
 *
 * Quelle sind Caddys Zugriffs-Logs – ohne Cookies, ohne Skript im Projekt,
 * ohne gespeicherte IP. Fehlt eine Quelle, fehlt das Element.
 */

const n = (v: number) => v.toLocaleString('de-CH')
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`

export function useTraffic(projectId: string, range: TrafficRange, way: TrafficWay | 'all' = 'all', enabled = true) {
  return useQuery({
    queryKey: ['traffic', projectId, range, way],
    queryFn: () => api.traffic(projectId, range, way),
    enabled,
    // Zähler kommen einmal pro Minute in die Datenbank; danach meldet der Ereignisstrom «traffic»
    // (lib/live.ts). Polling nur als Rückfall ohne Strom.
    refetchInterval: poll,
    placeholderData: (prev) => prev,
  })
}

/* --- Kurve der Übersicht --------------------------------------------------------- */

/** Obergrenze der y-Achse der kleinen Kurve: 1, 2, 5 × 10^n */
function cardMax(v: number): number {
  if (v <= 0) return 1
  const e = 10 ** Math.floor(Math.log10(v))
  const f = v / e
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e
}

const pointLabel = (p: TrafficPointDto, bucket: TrafficBucket) => (bucket === 'hour' ? `${fmtTime(p.at)} Uhr` : fmtWeekday(p.at))

/**
 * Aufrufe (Linie mit Fläche) und Besucher (gestrichelt) über den Zeitraum.
 * Muster wie der CPU/RAM-Verlauf der Übersicht (Meter): eine Kurve im SVG,
 * Wert unter dem Zeiger bzw. mit Pfeiltasten. Zwei Reihen unterscheiden
 * sich auch ohne Farbe (durchgezogen / gestrichelt, Legende mit Wort).
 */
export function TrafficChart({ series, bucket, height = 120, label }: { series: TrafficPointDto[]; bucket: TrafficBucket; height?: number; label: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 600
  const H = height
  const max = cardMax(Math.max(0, ...series.map((p) => Math.max(p.views, p.visitors))))
  const step = series.length > 1 ? W / (series.length - 1) : 0
  const x = (i: number) => (series.length > 1 ? i * step : W / 2)
  const y = (v: number) => H - (v / max) * (H - 4) - 1
  const line = (pick: (p: TrafficPointDto) => number) => series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(' ')
  const views = line((p) => p.views)
  const visitors = line((p) => p.visitors)
  const area = series.length ? `${views} L${x(series.length - 1).toFixed(1)},${H} L0,${H} Z` : ''
  const hv = hover !== null ? series[hover] : null
  const totalViews = series.reduce((s, p) => s + p.views, 0)
  const peak = series.reduce<TrafficPointDto | null>((b, p) => (!b || p.views > b.views ? p : b), null)
  const first = series[0]
  const mid = series[Math.floor(series.length / 2)]
  const axis = (p: TrafficPointDto | undefined) => (!p ? '' : bucket === 'hour' ? fmtTime(p.at) : fmtDayMonth(p.at))
  const summary = `${label}: ${plural(totalViews, 'Aufruf', 'Aufrufe')}${peak && peak.views ? `, am meisten ${pointLabel(peak, bucket)} mit ${n(peak.views)}` : ''}. Pfeiltasten zeigen einzelne Werte.`

  return (
    <figure className="tr-chart">
      <div className="tr-chart-plot">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ '--tr-h': `${H}px` } as CSSProperties}
          role="img"
          tabIndex={0}
          aria-label={summary}
          onMouseMove={(e) => {
            if (!series.length) return
            const r = e.currentTarget.getBoundingClientRect()
            const mx = ((e.clientX - r.left) / r.width) * W
            setHover(Math.max(0, Math.min(series.length - 1, Math.round(step ? mx / step : 0))))
          }}
          onMouseLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            if (!series.length) return
            const last = series.length - 1
            const next = e.key === 'ArrowRight' ? Math.min(last, (hover ?? -1) + 1)
              : e.key === 'ArrowLeft' ? Math.max(0, (hover ?? last + 1) - 1)
              : e.key === 'Home' ? 0 : e.key === 'End' ? last : e.key === 'Escape' ? null : undefined
            if (next === undefined) return
            e.preventDefault()
            setHover(next)
          }}
        >
          <line x1="0" x2={W} y1="1" y2="1" className="ov-meter-limit" vectorEffect="non-scaling-stroke" />
          <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} className="ov-meter-base" vectorEffect="non-scaling-stroke" />
          {area && <path d={area} className="ov-meter-area" />}
          {series.length > 1 && <path d={views} className="ov-meter-line" vectorEffect="non-scaling-stroke" />}
          {series.length > 1 && <path d={visitors} className="tr-chart-visitors" vectorEffect="non-scaling-stroke" />}
          {hv && <line x1={x(hover!)} x2={x(hover!)} y1="0" y2={H} className="ov-meter-cross" vectorEffect="non-scaling-stroke" />}
        </svg>
        <span className="tr-chart-max" aria-hidden="true">{n(max)}</span>
        {hv && (
          <span className={`ov-meter-tip tr-chart-tip${hover! > series.length * 0.7 ? ' tr-chart-tip-left' : ''}`} style={{ left: `${(x(hover!) / W) * 100}%` }} role="status">
            {pointLabel(hv, bucket)} · {plural(hv.views, 'Aufruf', 'Aufrufe')} · {plural(hv.visitors, 'Besucher', 'Besucher')}
          </span>
        )}
      </div>
      <div className="ov-meter-foot">
        <span>{axis(first)}</span>
        <span>{axis(mid)}</span>
        <span>{bucket === 'hour' ? 'jetzt' : 'heute'}</span>
      </div>
      <figcaption className="tr-chart-legend">
        <span><i className="tr-key tr-key-views" aria-hidden="true" />Aufrufe</span>
        <span><i className="tr-key tr-key-visitors" aria-hidden="true" />Besucher</span>
      </figcaption>
    </figure>
  )
}

/* --- Karte in der Übersicht ---------------------------------------------------- */

/**
 * Übersicht › «Besucher»: Aufrufe und Besucher im gewählten Zeitraum mit
 * Kurve. Ohne Adresse oder ohne Zugriffs-Log fehlt die Karte ganz.
 */
export function VisitorsCard({ p, onOpen }: { p: ProjectDto; onOpen: () => void }) {
  const [range, setRange] = useState<TrafficRange>('24h')
  const q = useTraffic(p.id, range, 'all', p.routes.length > 0)
  const id = useId()
  if (p.routes.length === 0) return null
  // Nicht eingerichtet (oder ältere API ohne Auswertung): Karte weglassen statt Nullen zeigen
  if (q.data && (q.data.source?.ingest ?? 'off') === 'off') return null
  const s = q.data
  const r = trafficRange(range)
  return (
    <section className="panel panel-pad ov-section" aria-labelledby={id}>
      <div className="ov-head">
        <h2 className="ov-title" id={id}>Besucher</h2>
        <button type="button" className="link-button" onClick={onOpen}>Alle Zahlen</button>
      </div>
      {!s && q.isError ? <ErrorState compact plural what="Die Besucherzahlen" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
        : !s ? <Loading label="Besucher werden geladen"><Sk w="40%" h={28} /><Sk h={90} /></Loading>
        : (
          <>
            <div className="tr-card-top">
              <dl className="tr-totals">
                <div><dt>Aufrufe</dt><dd className="num">{n(s.totals.views)}</dd></div>
                <div><dt>Besucher</dt><dd className="num">{n(s.totals.visitors)}</dd></div>
              </dl>
              <div className="segmented" role="group" aria-label="Zeitraum der Besucher">
                {TRAFFIC_CARD_RANGES.map((k) => (
                  <button key={k} type="button" aria-pressed={range === k} onClick={() => setRange(k)}>{trafficRange(k).label}</button>
                ))}
              </div>
            </div>
            {s.source.ingest === 'waiting'
              ? <p className="muted ov-empty">Wartet auf das Zugriffs-Log von Caddy. Es erscheint nach «docker compose up -d» mit dem Volume caddy_access.</p>
              : <TrafficChart series={s.series} bucket={s.bucket} height={72} label={`Aufrufe ${r.within}`} />}
            {s.totals.bots > 0 && <p className="ov-foot">Ohne {plural(s.totals.bots, 'Anfrage', 'Anfragen')} von Bots, eigene Prüfungen und Healthchecks.</p>}
          </>
        )}
    </section>
  )
}

/** Projektliste: «214 Aufrufe heute» – nur wenn Airlock mitzählt */
export function useTrafficToday() {
  return useQuery({ queryKey: ['traffic-today'], queryFn: () => api.trafficToday(), refetchInterval: poll, retry: false })
}

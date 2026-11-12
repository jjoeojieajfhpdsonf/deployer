import { useId, useMemo, useState } from 'react'
import { TRAFFIC_WAYS, TRAFFIC_WAY_LABEL, trafficRange, type TrafficPointDto, type TrafficSummaryDto, type TrafficWay } from '@airlock/shared'
import { fmtDayTime, msOf } from '../lib/dates.js'
import {
  BUCKET_WORD, METRIC_LABEL, METRIC_UNIT, axisLabels, fmtDecimal, fmtMetric, measuredFor, metricValue, niceMax, nf, plural, windowLabel, yTicks,
  type TrafficMetric,
} from '../lib/traffic-view.js'

/**
 * «Besucher neu»: Kurve unter den Kennzahlen (Vorlage diagramm-varianten.png).
 *
 * - Fläche (A, Standard): Linie mit weichem Verlauf für die gewählte
 *   Kennzahl; bei «Aufrufe» die Besucher gestrichelt als zweite Linie.
 * - Säulen (B): gestapelt nach Internet, Tailnet, Heimnetz; Legende mit Wort.
 *
 * Beide mit Fadenkreuz und Tooltip (Zeitfenster, Wert, Besucher, Aufteilung
 * nach Zugang) per Maus und Pfeiltasten; y-Achse rechts mit runden Werten.
 * Liegt der Messbeginn im Zeitraum, beginnt die Achse dort (Marke und
 * Hinweis darunter) – nie Nullen für nicht gemessene Zeit.
 *
 * Wechsel der Kennzahl oder Darstellung: kurzes Überblenden (opacity, 150 ms,
 * --ease-out), damit die Kurve nicht springt; bei reduzierter Bewegung ohne
 * Übergang (styles.css, .vs-plot).
 */

export type ChartMode = 'area' | 'bars'

const W = 1000
const H = 200

/** Wert einer Kennzahl je Zugang an einem Punkt (für Säulen); Seiten pro Besuch nicht stapelbar */
function wayValue(p: TrafficPointDto, w: TrafficWay, m: TrafficMetric): number {
  if (m === 'pagesPerVisit') return 0
  return p.ways[w][m]
}

export function VisitorsChart({ s, metric, mode, onMode }: {
  s: TrafficSummaryDto
  metric: TrafficMetric
  mode: ChartMode
  onMode: (m: ChartMode) => void
}) {
  const [hover, setHover] = useState<number | null>(null)
  const id = useId()
  const series = s.series
  const n = series.length
  const values = useMemo(() => series.map((p) => metricValue(p, metric)), [series, metric])
  const showVisitors = metric === 'views' && mode === 'area'
  const stack = mode === 'bars' && metric !== 'pagesPerVisit'
  const ways = s.way === 'all' ? TRAFFIC_WAYS : [s.way]
  const peak = Math.max(0, ...values.map((v) => v ?? 0), ...(showVisitors ? series.map((p) => p.visitors) : []))
  const decimals = metric === 'pagesPerVisit'
  const max = niceMax(peak)
  const slot = n > 0 ? W / n : W
  const x = (i: number) => (i + 0.5) * slot
  const y = (v: number) => H - (v / max) * (H - 2)

  // Linie in Teilstücken (Seiten pro Besuch: Lücke, wo niemand da war)
  const line = (vals: (number | null)[]) => {
    let d = ''
    let open = false
    vals.forEach((v, i) => {
      if (v === null) { open = false; return }
      d += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
      open = true
    })
    return d
  }
  const mainLine = line(values)
  const firstIdx = values.findIndex((v) => v !== null)
  const lastIdx = values.length - 1 - [...values].reverse().findIndex((v) => v !== null)
  const area = firstIdx >= 0 && n > 1 && metric !== 'pagesPerVisit'
    ? `${mainLine} L${x(lastIdx).toFixed(1)},${H} L${x(firstIdx).toFixed(1)},${H} Z`
    : ''
  const visitorsLine = showVisitors ? line(series.map((p) => p.visitors)) : ''

  const hv = hover !== null ? series[hover] : null
  const total = values.reduce<number>((a, v) => a + (v ?? 0), 0)
  const peakIdx = values.reduce<number>((b, v, i) => ((v ?? -1) > (values[b] ?? -1) ? i : b), 0)
  const word = `${METRIC_LABEL[metric]} ${BUCKET_WORD[s.bucket]}`
  const summary = n === 0
    ? `${word}: noch keine Werte.`
    : `${word}${metric === 'pagesPerVisit' ? '' : `: ${nf(total)} im Zeitraum`}${series[peakIdx] && (values[peakIdx] ?? 0) > 0 ? `, am meisten ${windowLabel(series[peakIdx]!, s.bucket)} mit ${fmtMetric(values[peakIdx]!, metric)}` : ''}. Pfeiltasten zeigen einzelne Werte.`
  const labels = useMemo(() => axisLabels(series, s.bucket), [series, s.bucket])
  const ticks = yTicks(max, decimals)

  const move = (i: number | null) => setHover(i === null ? null : Math.max(0, Math.min(n - 1, i)))

  return (
    <figure className="vs-chart" aria-labelledby={`${id}-t`}>
      <div className="vs-chart-head">
        <p className="vs-chart-title" id={`${id}-t`}>
          <span className="muted">Klick auf eine Kennzahl wechselt die Kurve · </span>{word}
          {s.way !== 'all' && <span className="muted"> · nur {TRAFFIC_WAY_LABEL[s.way]}</span>}
        </p>
        <div className="vs-chart-tools">
          <ul className="vs-legend" aria-label="Legende">
            {stack
              ? ways.map((w) => <li key={w}><i className={`vs-key vs-key-box vs-way-${w}`} aria-hidden="true" />{TRAFFIC_WAY_LABEL[w]}</li>)
              : (
                <>
                  <li><i className={`vs-key ${mode === 'bars' ? 'vs-key-box vs-way-public' : 'vs-key-line'}`} aria-hidden="true" />{METRIC_LABEL[metric]}</li>
                  {showVisitors && <li><i className="vs-key vs-key-dash" aria-hidden="true" />Besucher</li>}
                </>
              )}
          </ul>
          <div className="segmented segmented-sm" role="group" aria-label="Darstellung der Kurve">
            <button type="button" aria-pressed={mode === 'area'} onClick={() => onMode('area')}>Fläche</button>
            <button type="button" aria-pressed={mode === 'bars'} onClick={() => onMode('bars')}>Säulen</button>
          </div>
        </div>
      </div>

      <div className="vs-plot-wrap">
        <div className="vs-plot" key={`${metric}-${mode}`}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            tabIndex={0}
            aria-label={summary}
            onMouseMove={(e) => {
              if (!n) return
              const r = e.currentTarget.getBoundingClientRect()
              move(Math.floor(((e.clientX - r.left) / r.width) * n))
            }}
            onMouseLeave={() => setHover(null)}
            onBlur={() => setHover(null)}
            onKeyDown={(e) => {
              if (!n) return
              const last = n - 1
              const next = e.key === 'ArrowRight' ? Math.min(last, (hover ?? -1) + 1)
                : e.key === 'ArrowLeft' ? Math.max(0, (hover ?? last + 1) - 1)
                : e.key === 'Home' ? 0 : e.key === 'End' ? last : e.key === 'Escape' ? null : undefined
              if (next === undefined) return
              e.preventDefault()
              move(next)
            }}
          >
            <defs>
              <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" className="vs-fill-top" />
                <stop offset="1" className="vs-fill-bottom" />
              </linearGradient>
            </defs>
            {ticks.map((t) => (
              <line key={t} x1="0" x2={W} y1={y(t)} y2={y(t)} className={t === 0 ? 'vs-base' : 'vs-grid'} vectorEffect="non-scaling-stroke" />
            ))}
            {mode === 'area' ? (
              <>
                {area && <path d={area} fill={`url(#${id}-fill)`} />}
                {visitorsLine && <path d={visitorsLine} className="vs-line-visitors" vectorEffect="non-scaling-stroke" />}
                <path d={mainLine} className="vs-line" vectorEffect="non-scaling-stroke" />
                {n === 1 && values[0] !== null && <circle cx={x(0)} cy={y(values[0]!)} r="3" className="vs-dot" />}
              </>
            ) : (
              series.map((p, i) => {
                const bw = Math.min(slot * 0.72, 60)
                const left = x(i) - bw / 2
                if (!stack) {
                  const v = values[i] ?? 0
                  return v > 0 ? <rect key={p.at} x={left} width={bw} y={y(v)} height={H - y(v)} className="vs-bar vs-way-public" /> : null
                }
                let acc = 0
                return (
                  <g key={p.at}>
                    {ways.map((w) => {
                      const v = wayValue(p, w, metric)
                      if (v <= 0) return null
                      const top = y(acc + v)
                      const bottom = y(acc)
                      acc += v
                      return <rect key={w} x={left} width={bw} y={top} height={Math.max(0.5, bottom - top)} className={`vs-bar vs-way-${w}`} />
                    })}
                  </g>
                )
              })
            )}
            {hv && <line x1={x(hover!)} x2={x(hover!)} y1="0" y2={H} className="vs-cross" vectorEffect="non-scaling-stroke" />}
          </svg>
          {hv && mode === 'area' && values[hover!] !== null && (
            <span className="vs-hit" style={{ left: `${(x(hover!) / W) * 100}%`, top: `${(y(values[hover!]!) / H) * 100}%` }} aria-hidden="true" />
          )}
        </div>
        <div className="vs-yaxis" aria-hidden="true">
          {ticks.map((t) => <span key={t} style={{ top: `${(y(t) / H) * 100}%` }}>{decimals ? fmtDecimal(t, Number.isInteger(t) ? 0 : 1) : nf(t)}</span>)}
        </div>
        {s.measuredFrom && <span className="vs-since" aria-hidden="true">▸ Messbeginn {fmtDayTime(s.measuredFrom)}</span>}
        {hv && (
          <div className={`vs-tip${hover! > n * 0.62 ? ' vs-tip-left' : ''}`} style={{ left: `${(x(hover!) / W) * 100}%` }} role="status">
            <strong>{windowLabel(hv, s.bucket)}</strong>
            <span>
              {fmtMetric(metricValue(hv, metric), metric)} {METRIC_UNIT[metric][metricValue(hv, metric) === 1 ? 0 : 1]}
              {metric !== 'visitors' && <> · {plural(hv.visitors, 'Besucher', 'Besucher')}</>}
            </span>
            {metric !== 'pagesPerVisit' && (
              <span className="muted">
                {ways.filter((w) => wayValue(hv, w, metric) > 0).map((w) => `${TRAFFIC_WAY_LABEL[w]} ${nf(wayValue(hv, w, metric))}`).join(' · ') || 'keine'}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="vs-xaxis" aria-hidden="true">
        {[...labels.entries()].map(([i, t]) => {
          const at = (x(i) / W) * 100
          // Am Rand nicht über die Karte hinaus: links bündig bzw. rechts bündig
          return <span key={i} className={at < 4 ? 'vs-x-start' : at > 96 ? 'vs-x-end' : undefined} style={{ left: `${at}%` }}>{t}</span>
        })}
      </div>
      {s.measuredFrom && (
        <figcaption className="vs-chart-note">
          {`Zeitraum «${trafficRange(s.range).label}», aber erst seit ${measuredFor(s.measuredFrom, msOf(s.to) ?? undefined)} gemessen – die Achse beginnt beim Messbeginn statt mit leerer Zeit.`}
          {s.bucket === 'hour' && s.range !== 'today' && s.range !== '24h' && ' Ab 7 gemessenen Tagen zeigt die Kurve Tage statt Stunden.'}
          {s.range === '12m' && s.bucket !== 'hour' && s.bucket !== 'month' && ' Mit mehr Messzeit wechselt die Kurve zu Monaten.'}
        </figcaption>
      )}
    </figure>
  )
}

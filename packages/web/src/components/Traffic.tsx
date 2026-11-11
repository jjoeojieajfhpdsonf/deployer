import { Suspense, lazy, useId, useState, type CSSProperties, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  TRAFFIC_RANGES, TRAFFIC_WAYS, TRAFFIC_WAY_LABEL, TRAFFIC_DEVICE_LABEL, countryName,
  type TrafficDevice, type TrafficPointDto, type TrafficRange, type TrafficRowDto, type TrafficSummaryDto, type TrafficWay, type ProjectDto,
} from '@airlock/shared'
import { api } from '../api.js'
import { FALLBACK_MS } from '../lib/live.js'
import { fmtDate, fmtDayMonth, fmtTime, fmtWeekday } from '../lib/dates.js'
import { EmptyState, ErrorState, Loading, Sk, SkRows } from './States.js'

/**
 * Etappe 3 «Besucher und Herkunft»: Karte in der Übersicht und Reiter
 * «Besucher». Quelle sind Caddys Zugriffs-Logs – ohne Cookies, ohne Skript
 * im Projekt, ohne gespeicherte IP. Fehlt eine Quelle (Log nicht
 * eingerichtet, keine Städte-Datenbank), fehlt das Element.
 *
 * Verhältnis zum Reiter «Zugriffe» (statische Seiten): dort stehen die
 * einzelnen Aufrufe (Rohlog, wie «Logs»), hier die Auswertung über alle
 * Projektarten. Beide lesen Caddys Zugriffs-Log; die Auswertung verlinkt auf
 * die einzelnen Aufrufe.
 */

const LazyMap = lazy(() => import('./WorldMap.js'))

const n = (v: number) => v.toLocaleString('de-CH')
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`

export function useTraffic(projectId: string, range: TrafficRange, way: TrafficWay | 'all' = 'all', enabled = true) {
  return useQuery({
    queryKey: ['traffic', projectId, range, way],
    queryFn: () => api.traffic(projectId, range, way),
    enabled,
    // Zähler kommen einmal pro Minute in die Datenbank – öfter fragen bringt nichts
    refetchInterval: FALLBACK_MS,
    placeholderData: (prev) => prev,
  })
}

/* --- Kurve -------------------------------------------------------------------- */

/** Obergrenze der y-Achse: 1, 2, 5 × 10^n */
export function niceMax(v: number): number {
  if (v <= 0) return 1
  const e = 10 ** Math.floor(Math.log10(v))
  const f = v / e
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e
}

const pointLabel = (p: TrafficPointDto, bucket: 'hour' | 'day') => (bucket === 'hour' ? `${fmtTime(p.at)} Uhr` : fmtWeekday(p.at))

/**
 * Aufrufe (Linie mit Fläche) und Besucher (gestrichelt) über den Zeitraum.
 * Muster wie der CPU/RAM-Verlauf der Übersicht (Meter): eine Kurve im SVG,
 * Wert unter dem Zeiger bzw. mit Pfeiltasten. Zwei Reihen unterscheiden
 * sich auch ohne Farbe (durchgezogen / gestrichelt, Legende mit Wort).
 */
export function TrafficChart({ series, bucket, height = 120, label }: { series: TrafficPointDto[]; bucket: 'hour' | 'day'; height?: number; label: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 600
  const H = height
  const max = niceMax(Math.max(0, ...series.map((p) => Math.max(p.views, p.visitors))))
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

/* --- Zeitraum ------------------------------------------------------------------ */

function RangeSwitch({ range, onRange, label }: { range: TrafficRange; onRange: (r: TrafficRange) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {TRAFFIC_RANGES.map((r) => (
        <button key={r.key} type="button" aria-pressed={range === r.key} onClick={() => onRange(r.key)}>{r.label}</button>
      ))}
    </div>
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
  const r = TRAFFIC_RANGES.find((x) => x.key === range)!
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
              <RangeSwitch range={range} onRange={setRange} label="Zeitraum der Besucher" />
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

/* --- Reiter «Besucher» --------------------------------------------------------- */

function Bars({ rows, label, empty, total, format }: { rows: TrafficRowDto[]; label: string; empty: string; total: number; format: (k: string) => ReactNode }) {
  if (rows.length === 0) return <p className="muted ov-empty">{empty}</p>
  return (
    <table className="table tr-table">
      <thead><tr><th>{label}</th><th className="num">Aufrufe</th><th className="num">Besucher</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="tr-key-cell">
              <span className="tr-bar" style={{ width: `${total ? Math.max(1, Math.round((r.views / total) * 100)) : 0}%` }} aria-hidden="true" />
              <span className="tr-label">{format(r.key)}</span>
            </td>
            <td className="num">{n(r.views)}</td>
            <td className="num muted">{n(r.visitors)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Wort zur Statusklasse, damit die Farbe nie allein steht (wie im Reiter «Zugriffe») */
const STATUS_WORD: Record<string, string> = { '2': 'ok', '3': 'umgeleitet', '4': 'Clientfehler', '5': 'Serverfehler' }

function Statuses({ s }: { s: TrafficSummaryDto }) {
  if (s.statuses.length === 0) return <p className="muted ov-empty">Keine Aufrufe im Zeitraum.</p>
  const errors = s.statuses.filter((x) => x.status >= 400).reduce((a, x) => a + x.views, 0)
  return (
    <>
      <ul className="tr-status-list">
        {s.statuses.map((x) => {
          const k = String(Math.floor(x.status / 100))
          return (
            <li key={x.status}>
              <span className={`access-status access-status-${k}`}><span className="num">{x.status}</span> {STATUS_WORD[k] ?? ''}</span>
              <span className="num">{n(x.views)}</span>
            </li>
          )
        })}
      </ul>
      {errors > 0 && <p className="ov-foot">{plural(errors, 'Aufruf endete', 'Aufrufe endeten')} mit einem Fehler (4xx oder 5xx).</p>}
    </>
  )
}

export function TrafficTab({ p, onAccessLog }: { p: ProjectDto; onAccessLog?: () => void }) {
  const [range, setRange] = useState<TrafficRange>('7d')
  const [way, setWay] = useState<TrafficWay | 'all'>('all')
  const q = useTraffic(p.id, range, way)
  const s = q.data
  const r = TRAFFIC_RANGES.find((x) => x.key === range)!

  if (!s && q.isError) return <ErrorState plural what="Die Besucherzahlen" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
  if (!s) return <Loading label="Besucher werden geladen"><SkRows n={6} /></Loading>
  if ((s.source?.ingest ?? 'off') === 'off') {
    return (
      <EmptyState title="Besucher werden nicht gezählt">
        Airlock liest dafür das Zugriffs-Log von Caddy (Volume caddy_access, Einstellung ACCESS_LOG_DIR). Es ist auf diesem Server nicht eingerichtet.
      </EmptyState>
    )
  }
  const wayCount = (w: TrafficWay) => s.ways.find((x) => x.way === w)?.views ?? 0
  const allViews = s.ways.reduce((a, x) => a + x.views, 0)
  const showOrigin = (way === 'all' || way === 'public') && s.countries.length > 0
  const nothing = s.totals.views === 0

  return (
    <div className="tab-panel tr-page">
      <section className="panel panel-pad ov-section" aria-labelledby="tr-h">
        <div className="ov-head tr-head">
          <h2 className="ov-title" id="tr-h">Besucher</h2>
          <div className="tr-controls">
            <div className="segmented" role="group" aria-label="Nach Zugang trennen">
              <button type="button" aria-pressed={way === 'all'} onClick={() => setWay('all')}>Alle <span className="num">{n(allViews)}</span></button>
              {TRAFFIC_WAYS.map((w) => (
                <button key={w} type="button" aria-pressed={way === w} onClick={() => setWay(w)}>{TRAFFIC_WAY_LABEL[w]} <span className="num">{n(wayCount(w))}</span></button>
              ))}
            </div>
            <RangeSwitch range={range} onRange={setRange} label="Zeitraum" />
          </div>
        </div>
        {s.source.ingest === 'waiting' && (
          <div className="notice notice-info" role="status">
            <span><strong>Wartet auf das Zugriffs-Log von Caddy.</strong> Es entsteht mit dem Volume caddy_access (nach «docker compose up -d»); bis dahin gibt es keine neuen Zahlen.</span>
          </div>
        )}
        <dl className="tr-totals tr-totals-lg">
          <div><dt>Aufrufe</dt><dd className="num">{n(s.totals.views)}</dd></div>
          <div><dt>Besucher</dt><dd className="num">{n(s.totals.visitors)}</dd></div>
          {s.totals.bots > 0 && <div><dt>Bots, nicht gezählt</dt><dd className="num muted">{n(s.totals.bots)}</dd></div>}
        </dl>
        <TrafficChart series={s.series} bucket={s.bucket} label={`Aufrufe ${r.within}${way === 'all' ? '' : ` über ${TRAFFIC_WAY_LABEL[way]}`}`} />
      </section>

      {nothing ? (
        <EmptyState title={`Keine Aufrufe ${r.within}${way === 'all' ? '' : ` über ${TRAFFIC_WAY_LABEL[way]}`}`}>
          {s.source.since ? `Gezählt wird seit ${fmtDate(s.source.since)}.` : 'Sobald jemand die Seite öffnet, erscheint der Aufruf hier (spätestens nach einer Minute).'}
        </EmptyState>
      ) : (
        <>
          <div className="tr-grid">
            <section className="panel panel-pad ov-section" aria-labelledby="tr-pages">
              <h2 className="ov-title" id="tr-pages">Seiten</h2>
              <Bars rows={s.pages} total={s.totals.views} label="Pfad" empty="Keine Seiten." format={(k) => <code title={k}>{k || '/'}</code>} />
            </section>
            <section className="panel panel-pad ov-section" aria-labelledby="tr-refs">
              <h2 className="ov-title" id="tr-refs">Herkunft der Links</h2>
              <Bars rows={s.referrers} total={s.totals.views} label="Referrer" empty="Keine." format={(k) => (k ? k : <span className="muted">direkt oder unbekannt</span>)} />
            </section>
          </div>

          {showOrigin && (
            <section className="panel panel-pad ov-section" aria-labelledby="tr-geo">
              <div className="ov-head">
                <h2 className="ov-title" id="tr-geo">Länder</h2>
                <span className="muted">nur Aufrufe aus dem Internet</span>
              </div>
              <div className="tr-geo">
                <Suspense fallback={<Sk h={180} />}>
                  <LazyMap countries={s.countries} />
                </Suspense>
                <Bars rows={s.countries.slice(0, 12)} total={s.countries.reduce((a, c) => a + c.views, 0)} label="Land" empty="Keine." format={(k) => countryName(k)} />
              </div>
              {s.source.cityDb && s.cities.length > 0 && (
                <>
                  <h3 className="tr-sub">Städte</h3>
                  <Bars rows={s.cities} total={s.countries.reduce((a, c) => a + c.views, 0)} label="Stadt" empty="Keine." format={(k) => k} />
                </>
              )}
            </section>
          )}

          <div className="tr-grid">
            <section className="panel panel-pad ov-section" aria-labelledby="tr-dev">
              <h2 className="ov-title" id="tr-dev">Geräte</h2>
              <Bars rows={s.devices} total={s.totals.views} label="Gerät" empty="Keine." format={(k) => TRAFFIC_DEVICE_LABEL[k as TrafficDevice] ?? k} />
            </section>
            <section className="panel panel-pad ov-section" aria-labelledby="tr-status">
              <h2 className="ov-title" id="tr-status">Statuscodes</h2>
              <Statuses s={s} />
            </section>
          </div>
        </>
      )}

      <p className="hint tr-source">
        Aus dem Zugriffs-Log von Caddy, ohne Cookies und ohne Skript im Projekt. Gespeichert werden nur Zähler je Stunde, keine IP-Adressen;
        Besucher sind eindeutig je Tag (Hash mit täglich neuem Salz), Bots, Healthchecks, statische Dateien und eigene Prüfungen von Airlock zählen nicht.
        Aufbewahrung 13 Monate. Länder von Cloudflare; Tailnet ohne Gerätenamen.
        {s.source.cityDb && <> Städte: <a href="https://db-ip.com" target="_blank" rel="noreferrer">IP Geolocation by DB-IP</a> (CC BY 4.0, Stand {s.source.cityDb}).</>}
        {onAccessLog && <> <button type="button" className="link-button" onClick={onAccessLog}>Einzelne Aufrufe im Reiter «Zugriffe»</button></>}
      </p>
    </div>
  )
}

/** Projektliste: «214 Aufrufe heute» – nur wenn Airlock mitzählt */
export function useTrafficToday() {
  return useQuery({ queryKey: ['traffic-today'], queryFn: () => api.trafficToday(), refetchInterval: FALLBACK_MS, retry: false })
}

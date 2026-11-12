import { Suspense, lazy, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  INTERNAL_REFERRER, TRAFFIC_DEVICE_LABEL, TRAFFIC_SEP, TRAFFIC_TAB_RANGES, TRAFFIC_WAYS, TRAFFIC_WAY_LABEL, UNKNOWN_VALUE, countryName, languageName, trafficRange,
  type AccessStatusFilter, type ProjectDto, type TrafficDevice, type TrafficLiveEventDto, type TrafficRange, type TrafficRowDto, type TrafficSummaryDto, type TrafficWay,
} from '@airlock/shared'
import { api, subscribeTraffic, type MeDto } from '../api.js'
import { notifyOk } from '../lib/feedback.js'
import { fmtDayMonth, msOf } from '../lib/dates.js'
import { DIRECT, einzelnSearch, familyOf, viewFromParams, type Facets, type VisitorsView } from '../lib/access-view.js'
import {
  METRICS, METRIC_LABEL, NOT_FOUND_WARN, activeNow, deltaLabel, flagOf, fmtMetric, hasAny, nf, rangeFromSlug, rangeSlug, shareLabel,
  wayFromSlug, waySlug, type TrafficMetric,
} from '../lib/traffic-view.js'
import type { MapView } from '../lib/world-map.js'
import { Access } from './Access.js'
import { useTraffic } from './Traffic.js'
import { VisitorsChart, type ChartMode } from './VisitorsChart.js'
import { EmptyState, ErrorState, Loading, Sk, SkRows } from './States.js'

/**
 * Reiter «Besucher» (Vorlage docs/design-cal/besucher-zusammen/): seit
 * «Besucher zusammen» mit den früheren Zugriffen in einem Reiter. Eine
 * Kopfzeile für beide Ansichten – Auswertung · Einzelaufrufe, Zeitraum,
 * Zugang, rechts «gerade aktiv → live ansehen» bzw. Live und CSV. Alles
 * steht in der Adresse (?ansicht=einzeln&zeitraum=…&zugang=…); beim Wechsel
 * der Ansicht bleiben die Filter.
 *
 * Auswertung: Kennzahlen mit Kurve → Karte «Woher die Besucher kommen» mit
 * Liste (Länder · Städte · Netz · Sprachen) → Seiten · Woher · Geräte →
 * eine Zeile «Wie gezählt wird». Jede Zeile einer Liste (und jedes Land auf
 * der Karte) öffnet die Einzelaufrufe mit dem passenden Filter.
 *
 * Quelle sind Caddys Zugriffs-Logs – ohne Cookies, ohne Skript im Projekt,
 * ohne gespeicherte IP. Fehlt eine Quelle (Log nicht eingerichtet, keine
 * Städte- oder Provider-Datenbank), fehlt das Element bzw. steht ein
 * Hinweis mit dem Knopf, der sie lädt.
 */

const LazyMap = lazy(() => import('./WorldMap.js'))

/* --- Adresse und Präferenz ---------------------------------------------------- */

/** Ansicht, Zeitraum und Zugang in der Adresse; Standard Auswertung, 7 Tage, alle */
function useVisitorsState() {
  const [params, setParams] = useSearchParams()
  const view = viewFromParams(params)
  const range = rangeFromSlug(params.get('zeitraum'))
  const way = wayFromSlug(params.get('zugang'))
  const set = useCallback((key: string, value: string | null, push = false) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    }, { replace: !push })
  }, [setParams])
  return {
    params, view, range, way,
    // Ansicht: neuer Eintrag im Verlauf (Zurück wechselt zurück); Filter bleiben
    setView: (v: VisitorsView) => set('ansicht', v === 'einzeln' ? 'einzeln' : null, true),
    setRange: (r: TrafficRange) => set('zeitraum', r === '7d' ? null : rangeSlug(r)),
    setWay: (w: TrafficWay | 'all') => set('zugang', waySlug(w)),
  }
}

/** Fläche oder Säulen: Präferenz auf dem Server (wie die Darstellung), sofort wirksam */
function useChartMode(): [ChartMode, (m: ChartMode) => void] {
  const qc = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const mode: ChartMode = me.data?.trafficChart === 'bars' ? 'bars' : 'area'
  const set = useCallback((m: ChartMode) => {
    const before = qc.getQueryData<MeDto>(['me'])
    qc.setQueryData<MeDto>(['me'], (old) => (old ? { ...old, trafficChart: m } : old))
    api.setPreferences({ trafficChart: m }).catch(() => qc.setQueryData<MeDto>(['me'], before))
  }, [qc])
  return [mode, set]
}

/* --- Live: gerade aktiv ---------------------------------------------------------- */

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible
}

const eventKey = (e: TrafficLiveEventDto) => `${e.at}|${e.access}|${e.path ?? ''}|${e.status}`

/**
 * Letzte Seitenaufrufe: Stand vom Server (Speicher, GET …/traffic/recent),
 * danach neue aus dem Live-Strom – für «gerade aktiv» und den Punkt auf der
 * Karte. Bei verstecktem Tab pausiert (Strom zu); beim Zurückkommen neu
 * geladen. Keine IP, keine Kennung.
 */
function useLiveVisits(projectId: string) {
  const visible = useDocumentVisible()
  const recent = useQuery({ queryKey: ['traffic-recent', projectId], queryFn: () => api.trafficRecent(projectId), enabled: visible, staleTime: 0, retry: false })
  const [live, setLive] = useState<TrafficLiveEventDto[]>([])
  const [now, setNow] = useState(() => Date.now())
  // Strom abgebrochen (Neustart von Airlock, Netz): nach 5 s neu verbinden und den Stand neu laden
  const [attempt, setAttempt] = useState(0)
  const { refetch } = recent
  useEffect(() => {
    if (!visible) return
    setLive([])
    let retry: ReturnType<typeof setTimeout> | null = null
    const off = subscribeTraffic(projectId, (e) => {
      if (!e.page) return
      setLive((prev) => [e, ...prev].slice(0, 50))
    }, (open) => {
      if (!open && !retry) retry = setTimeout(() => setAttempt((a) => a + 1), 5_000)
    })
    void refetch()
    const tick = setInterval(() => setNow(Date.now()), 5_000)
    return () => { off(); clearInterval(tick); if (retry) clearTimeout(retry) }
  }, [projectId, visible, refetch, attempt])
  const events = useMemo(() => {
    const seen = new Set<string>()
    const all = [...live, ...(recent.data?.events ?? [])].filter((e) => {
      const k = eventKey(e)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    return all.sort((a, b) => (msOf(b.at) ?? 0) - (msOf(a.at) ?? 0))
  }, [live, recent.data])
  return { events, now, visible }
}

/** «● 4 gerade aktiv → live ansehen»: öffnet die Einzelaufrufe (Live ist dort an) */
function ActiveNow({ live, liveHref }: { live: ReturnType<typeof useLiveVisits>; liveHref: string }) {
  const n = activeNow(live.events, live.now)
  return (
    <p className="vs-active">
      <span aria-live="polite" className="vs-active-count">
        <span className={`vs-active-dot${n > 0 ? ' vs-active-on' : ''}`} aria-hidden="true" />
        <strong className="num">{nf(n)}</strong>
        <span>{' '}gerade aktiv</span>
        {!live.visible && <span className="muted"> · pausiert</span>}
      </span>
      <Link className="vs-live-link" to={{ search: liveHref }}><span aria-hidden="true">→ </span>live ansehen</Link>
    </p>
  )
}

/* --- Kopfzeile (beide Ansichten) ---------------------------------------------- */

function Segmented<T extends string>({ value, options, onChange, label, small = true }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void; label: string; small?: boolean }) {
  return (
    <div className={`segmented${small ? ' segmented-sm' : ''}`} role="group" aria-label={label}>
      {options.map(([k, text]) => <button key={k} type="button" aria-pressed={value === k} onClick={() => onChange(k)}>{text}</button>)}
    </div>
  )
}

const VIEWS: [VisitorsView, string][] = [['auswertung', 'Auswertung'], ['einzeln', 'Einzelaufrufe']]

/** Auswertung · Einzelaufrufe als Reiter (wie die Unternavigation im Reiter Security): Pfeiltasten wechseln */
function ViewTabs({ view, onView }: { view: VisitorsView; onView: (v: VisitorsView) => void }) {
  const refs = useRef<Partial<Record<VisitorsView, HTMLButtonElement | null>>>({})
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = VIEWS.findIndex(([k]) => k === view)
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? VIEWS.length - 1 : null
    if (to === null) return
    e.preventDefault()
    const next = VIEWS[(to + VIEWS.length) % VIEWS.length]![0]
    onView(next)
    requestAnimationFrame(() => refs.current[next]?.focus())
  }
  return (
    <div className="segmented vs-mode" role="tablist" aria-label="Ansicht der Besucher" onKeyDown={onKey}>
      {VIEWS.map(([k, label]) => (
        <button
          key={k} ref={(el) => { refs.current[k] = el }} type="button" role="tab" id={`vs-tab-${k}`}
          aria-selected={view === k} aria-controls="vs-view" tabIndex={view === k ? 0 : -1} onClick={() => onView(k)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/**
 * Kopfzeile: bleibt beim Wechsel der Ansicht stehen (Fokus auf dem Reiter
 * geht nicht verloren). Rechts ein Platz, den die Ansicht füllt
 * (createPortal): «gerade aktiv» bzw. Live und CSV.
 */
function Head({ view, onView, range, way, onRange, onWay, wayCounts, slotRef }: {
  view: VisitorsView; onView: (v: VisitorsView) => void
  range: TrafficRange; way: TrafficWay | 'all'; onRange: (r: TrafficRange) => void; onWay: (w: TrafficWay | 'all') => void
  wayCounts?: (w: TrafficWay) => number; slotRef: (el: HTMLDivElement | null) => void
}) {
  return (
    <div className="vs-top">
      <ViewTabs view={view} onView={onView} />
      <Segmented<TrafficRange> small={false} value={range} onChange={onRange} label="Zeitraum" options={TRAFFIC_TAB_RANGES.map((k) => [k, trafficRange(k).label])} />
      <Segmented<TrafficWay | 'all'>
        small={false} value={way} onChange={onWay} label="Nach Zugang trennen"
        options={[['all', 'Alle'], ...TRAFFIC_WAYS.map((w): [TrafficWay, ReactNode] => [w, <>{TRAFFIC_WAY_LABEL[w]}{wayCounts && <span className="num">{nf(wayCounts(w))}</span>}</>])]}
      />
      <div className="vs-top-end" ref={slotRef} />
    </div>
  )
}

/* --- Reiter ---------------------------------------------------------------------- */

export function VisitorsTab({ p, onLogs }: { p: ProjectDto; onLogs?: () => void }) {
  const st = useVisitorsState()
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  // Zahlen je Zugang nur in der Auswertung (dieselbe Abfrage wie dort, aus dem Cache)
  const s = useTraffic(p.id, st.range, st.way, st.view === 'auswertung').data
  const wayCounts = st.view === 'auswertung' && s?.ways ? (w: TrafficWay) => s.ways.find((x) => x.way === w)?.views ?? 0 : undefined
  return (
    <div className="tab-panel vs-page">
      <h2 className="sr-only">Besucher</h2>
      <Head view={st.view} onView={st.setView} range={st.range} way={st.way} onRange={st.setRange} onWay={st.setWay} wayCounts={wayCounts} slotRef={setSlot} />
      {st.view === 'einzeln'
        ? <Access projectId={p.id} slug={p.slug} toolsSlot={slot} />
        : <Evaluation p={p} range={st.range} way={st.way} params={st.params} onLogs={onLogs} slot={slot} />}
    </div>
  )
}

/* --- Bausteine ---------------------------------------------------------------- */

/** Link einer Zeile: Suchteil der Einzelaufrufe (null: Zeile ohne Link) */
type RowLink<T> = (r: T) => string | null

/**
 * Rangliste mit Balken als Fläche hinter der Zeile; «› x weitere» klappt
 * auf. Mit `href` ist jede Zeile ein Link zu den passenden Einzelaufrufen
 * (kleines «›» als Hinweis, per Tab erreichbar).
 */
function RankList<T extends TrafficRowDto>({ rows, total, label, format, initial = 5, tone, extra, empty, code, href, linkText }: {
  rows: T[]
  total: number
  label: string
  format: (r: T) => ReactNode
  initial?: number
  tone?: 'warn'
  /** Statt des Anteils (z. B. «bot?») */
  extra?: (r: T) => ReactNode
  empty: string
  code?: boolean
  href?: RowLink<T>
  /** Name der Zeile für Screenreader (ohne Flagge) */
  linkText?: (r: T) => string
}) {
  const [open, setOpen] = useState(false)
  if (rows.length === 0) return <p className="muted vs-empty">{empty}</p>
  const max = Math.max(...rows.map((r) => r.views))
  const shown = open ? rows : rows.slice(0, initial)
  const more = rows.length - initial
  return (
    <>
      <ol className={`vs-rank${tone ? ` vs-rank-${tone}` : ''}`} aria-label={label}>
        {shown.map((r) => {
          const to = href?.(r) ?? null
          const inner = (
            <>
              <span className="vs-rank-bar" style={{ width: `${Math.max(2, (r.views / max) * 100)}%` }} aria-hidden="true" />
              <span className={`vs-rank-label${code ? ' vs-rank-code' : ''}`}>{format(r)}</span>
              <span className="vs-rank-n num">{nf(r.views)}</span>
              <span className="vs-rank-share num">{extra?.(r) ?? shareLabel(r.views, total)}</span>
              <span className="vs-rank-go" aria-hidden="true">{to ? '›' : ''}</span>
            </>
          )
          return (
            <li key={r.key}>
              {to
                ? <Link className="vs-rank-row vs-rank-link" to={{ search: to }} title={linkText ? `Einzelaufrufe: ${linkText(r)}` : 'Einzelaufrufe zeigen'}>{inner}<span className="sr-only"> – Einzelaufrufe zeigen</span></Link>
                : <span className="vs-rank-row">{inner}</span>}
            </li>
          )
        })}
      </ol>
      {more > 0 && (
        <button type="button" className="vs-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? '‹ weniger' : `› ${nf(more)} weitere`}
        </button>
      )}
    </>
  )
}

/** Browser und System nach Familie zusammengefasst («Chrome 131» + «Chrome 130» → Chrome) */
function byFamily(rows: TrafficRowDto[]): TrafficRowDto[] {
  const m = new Map<string, TrafficRowDto>()
  for (const r of rows) {
    const fam = familyOf(r.key)
    const e = m.get(fam) ?? { key: fam, views: 0, visitors: 0 }
    e.views += r.views
    e.visitors += r.visitors
    m.set(fam, e)
  }
  return [...m.values()].sort((a, b) => b.views - a.views)
}

const unknownWord = (k: string) => (k === UNKNOWN_VALUE ? 'Unbekannt' : k)

/* --- Kennzahlen ---------------------------------------------------------------- */

function Kpis({ s, metric, onMetric }: { s: TrafficSummaryDto; metric: TrafficMetric; onMetric: (m: TrafficMetric) => void }) {
  const t = s.totals
  const prev = s.previous
  const share = t.requests > 0 ? t.notFound / t.requests : 0
  const value: Record<TrafficMetric, number | null> = { views: t.views, visitors: t.visitors, pagesPerVisit: t.pagesPerVisit, notFound: t.notFound, bots: t.bots }
  const since = s.source.since
  const viewsDelta = prev ? deltaLabel(t.views, prev.views) : null
  const sub: Record<TrafficMetric, ReactNode> = {
    views: viewsDelta ? <>{viewsDelta} zum Vorzeitraum</> : s.measuredFrom ? <>erst seit {fmtDayMonth(s.measuredFrom)} gemessen</> : <>seit Messbeginn{since ? ` ${fmtDayMonth(since)}` : ''}</>,
    visitors: 'eindeutig pro Tag',
    pagesPerVisit: 'Ø Aufrufe je Besucher',
    notFound: <>{shareLabel(t.notFound, t.requests)} der Anfragen · 404</>,
    bots: 'nicht mitgezählt',
  }
  const delta = (m: TrafficMetric) => (m === 'views' || !prev ? null : deltaLabel(value[m], m === 'pagesPerVisit' ? prev.pagesPerVisit : prev[m]))
  return (
    <div className="vs-kpis" role="group" aria-label="Kennzahlen – die gewählte bestimmt die Kurve">
      {METRICS.map((m) => {
        const warn = m === 'notFound' && share >= NOT_FOUND_WARN
        const d = delta(m)
        return (
          <button key={m} type="button" className="vs-kpi" aria-pressed={metric === m} onClick={() => onMetric(m)}>
            <span className="vs-kpi-label">{METRIC_LABEL[m]}</span>
            <span className={`vs-kpi-value num${warn ? ' vs-warn' : ''}`}>
              {fmtMetric(value[m], m)}
              {warn && <span className="sr-only"> – auffällig viele</span>}
              {d && <span className="vs-delta">{d}<span className="sr-only"> zum Vorzeitraum</span></span>}
            </span>
            <span className="vs-kpi-sub">{sub[m]}</span>
          </button>
        )
      })}
    </div>
  )
}

/* --- Karte «Woher die Besucher kommen» ---------------------------------------- */

type PlaceView = 'countries' | 'cities' | 'networks' | 'languages'

/** Suchteil der Einzelaufrufe für ein Merkmal (Zeitraum und Zugang bleiben) */
type ToEinzeln = (facets: Facets, status?: AccessStatusFilter) => string

function Geo({ s, last, internetInRange, to }: { s: TrafficSummaryDto; last: TrafficLiveEventDto | undefined; internetInRange: boolean; to: ToEinzeln }) {
  const hasCountries = s.countries.length > 0
  const cities = s.cities
  const withNet = internetInRange || Boolean(s.source.asnDb)
  const options: [PlaceView, string][] = [
    ...(hasCountries ? [['countries', 'Länder'] as [PlaceView, string]] : []),
    ...(hasCountries && cities.length > 0 ? [['cities', 'Städte'] as [PlaceView, string]] : []),
    ...(withNet ? [['networks', 'Netz'] as [PlaceView, string]] : []),
    ['languages', 'Sprachen'],
  ]
  const [chosen, setPlace] = useState<PlaceView>(hasCountries ? 'countries' : 'languages')
  const place = options.some(([k]) => k === chosen) ? chosen : options[0]![0]
  const [view, setView] = useState<MapView>('world')
  const internetViews = s.countries.reduce((a, c) => a + c.views, 0)
  const lastOrigin = last && last.access === 'public' && last.country ? { country: last.country, city: last.city } : null
  const countryLink = (code: string) => to({ land: code || UNKNOWN_VALUE })

  const people = s.networks.filter((n) => n.views > 0)
  const dc = s.networks.filter((n) => n.datacenter && n.bots > 0)
  const langTotal = s.languages.reduce((a, r) => a + r.views, 0)

  const list = place === 'cities' ? (
    <RankList
      rows={cities} total={internetViews} label="Städte" empty="Keine." initial={6} href={(r) => to({ stadt: r.key })} linkText={(r) => r.key}
      format={(r) => <><span className="vs-flag" aria-hidden="true">{flagOf(r.country)}</span>{r.key}</>}
    />
  ) : place === 'networks' ? (
    !s.source.asnDb
      ? <p className="muted vs-empty">Provider (Swisscom, Init7 …) und Rechenzentren zeigt Airlock mit der freien Datei «IP to ASN Lite» von DB-IP (CC BY 4.0): <DbipButton kind="asn" /></p>
      : (
        <RankList
          rows={people.map((n) => ({ key: String(n.asn), views: n.views, visitors: 0, name: n.name }))}
          total={people.reduce((a, n) => a + n.views, 0)} label="Provider" empty="Noch keine Aufrufe mit bekanntem Netz." initial={6}
          href={(r) => to({ netz: r.key })} linkText={(r) => r.name || `AS${r.key}`}
          format={(r) => <span title={`AS${r.key}`}>{r.name || `AS${r.key}`}</span>}
        />
      )
  ) : place === 'languages' ? (
    <RankList
      rows={s.languages} total={langTotal} label="Sprachen" empty="Noch keine Angaben." initial={6}
      href={(r) => to({ sprache: r.key })} linkText={(r) => (r.key === UNKNOWN_VALUE ? 'Unbekannt' : languageName(r.key))}
      format={(r) => (r.key === UNKNOWN_VALUE ? 'Unbekannt' : languageName(r.key))}
    />
  ) : (
    <RankList
      rows={s.countries} total={internetViews} label="Länder" empty="Keine." initial={6} href={(r) => countryLink(r.key)} linkText={(r) => (r.key ? countryName(r.key) : 'Unbekannt')}
      format={(r) => (r.key ? <><span className="vs-flag" aria-hidden="true">{flagOf(r.key)}</span>{countryName(r.key)}</> : 'Unbekannt')}
    />
  )

  const foot = place === 'countries' || place === 'cities' ? <CityHint s={s} />
    : place === 'languages' ? 'Erste Sprache des Browsers (Accept-Language).'
    : s.source.asnDb ? (
      <>
        {dc.length > 0 && <>Rechenzentren, als Bot gezählt (<span className="vs-bot">vermutlich Bot</span>): {dc.slice(0, 4).map((n) => `${n.name || `AS${n.asn}`} ${nf(n.bots)}`).join(' · ')}. </>}
        Netze: <a href="https://db-ip.com" target="_blank" rel="noreferrer">IP Geolocation by DB-IP<span className="sr-only"> (neues Fenster)</span></a> (CC BY 4.0, Stand {s.source.asnDb}).
      </>
    ) : null

  const side = (
    <div className="vs-geo-side">
      <div className="vs-card-head">
        {options.length > 1
          ? <Segmented<PlaceView> value={place} onChange={setPlace} label="Länder, Städte, Netz oder Sprachen" options={options} />
          : <h3 className="vs-chart-title">{options[0]![1]}</h3>}
        <span className="vs-card-note">{place === 'languages' ? 'alle Zugänge' : 'nur Internet'}</span>
      </div>
      {list}
      {foot && <p className="vs-card-foot">{foot}</p>}
    </div>
  )

  if (!hasCountries) {
    return (
      <section className="panel panel-pad vs-geo vs-geo-nomap" aria-labelledby="vs-geo-h">
        <div className="vs-card-head">
          <h2 className="vs-card-title" id="vs-geo-h">Woher die Besucher kommen</h2>
          <span className="vs-card-note">Länder, Städte und Karte nur für Aufrufe aus dem Internet</span>
        </div>
        {side}
      </section>
    )
  }
  return (
    <section className="panel panel-pad vs-geo" aria-labelledby="vs-geo-h">
      <div className="vs-geo-map">
        <div className="vs-card-head">
          <h2 className="vs-card-title" id="vs-geo-h">Woher die Besucher kommen</h2>
          <Segmented<MapView> value={view} onChange={setView} label="Kartenausschnitt" options={[['world', 'Welt'], ['europe', 'Europa']]} />
        </div>
        <Suspense fallback={<Sk h={320} />}>
          <LazyMap countries={s.countries} view={view} last={lastOrigin} href={countryLink} />
        </Suspense>
      </div>
      {side}
    </section>
  )
}

/* --- Seiten, Woher, Geräte ------------------------------------------------------ */

type PagesView = 'all' | 'entry' | 'exit' | 'notFound'

const PAGES_NOTE: Record<PagesView, string> = {
  all: 'erfolgreich aufgerufen (2xx, 3xx)',
  entry: 'erste Seite eines Besuchs',
  exit: 'letzte Seite eines Besuchs (nach 30 Min. ohne Aufruf)',
  notFound: '404 · Tippfehler, Scanner',
}

function Pages({ s, to, onLogs }: { s: TrafficSummaryDto; to: ToEinzeln; onLogs?: () => void }) {
  const [view, setView] = useState<PagesView>('all')
  const rows = view === 'all' ? s.pages : view === 'entry' ? s.entries : view === 'exit' ? s.exits : s.notFound
  const total = rows.reduce((a, r) => a + r.views, 0)
  const errors = s.totals.serverErrors
  const label = { all: 'Seiten', entry: 'Einstiegsseiten', exit: 'Ausstiegsseiten', notFound: 'Nicht gefundene Pfade' }[view]
  const empty = { all: 'Keine Seiten im Zeitraum.', entry: 'Noch keine Besuche gezählt.', exit: 'Noch kein Besuch abgeschlossen.', notFound: 'Keine 404 im Zeitraum.' }[view]
  return (
    <section className="panel panel-pad vs-card" aria-labelledby="vs-pages-h">
      <div className="vs-card-head">
        <h2 className="vs-card-title" id="vs-pages-h">Seiten</h2>
        <Segmented<PagesView> value={view} onChange={setView} label="Alle Seiten, Einstieg, Ausstieg oder nicht gefunden" options={[['all', 'Alle'], ['entry', 'Einstieg'], ['exit', 'Ausstieg'], ['notFound', '404']]} />
      </div>
      <p className="vs-card-note vs-card-lede">{PAGES_NOTE[view]}</p>
      <RankList
        rows={rows} total={total} code label={label} empty={empty} tone={view === 'notFound' ? 'warn' : undefined}
        href={(r) => (view === 'notFound' ? to({ pfad: r.key }, 'nicht-gefunden') : to({ pfad: r.key || '/' }))} linkText={(r) => r.key || '/'}
        format={(r) => <code title={r.key}>{r.key || '/'}</code>}
        extra={view === 'notFound' ? (r) => ('scanner' in r && r.scanner ? <span className="vs-bot" title="Typischer Pfad von Scannern, die Lücken suchen (WordPress, .git, phpMyAdmin …)">bot?</span> : undefined) : undefined}
      />
      {(view === 'entry' || view === 'exit') && <p className="vs-card-foot">Ohne Besucher mit «Do Not Track» oder «Global Privacy Control».</p>}
      {view === 'notFound' && (
        <p className="vs-card-foot">
          {errors > 0
            ? <>Serverfehler (5xx): <span className="num">{nf(errors)}</span> · <Link to={{ search: to({}, 'fehler') }}>Einzelaufrufe</Link>{onLogs && <> · <button type="button" className="link-button" onClick={onLogs}>Logs</button></>}</>
            : 'Keine Serverfehler (5xx).'}
        </p>
      )}
    </section>
  )
}

type SourcesView = 'links' | 'campaigns'

function Sources({ s, to }: { s: TrafficSummaryDto; to: ToEinzeln }) {
  const [view, setView] = useState<SourcesView>('links')
  const h = s.referrersHidden
  const campaigns = s.campaigns.map((c) => ({ ...c, key: [c.source, c.medium, c.campaign].join(TRAFFIC_SEP) }))
  return (
    <section className="panel panel-pad vs-card" aria-labelledby="vs-ref-h">
      <div className="vs-card-head">
        <h2 className="vs-card-title" id="vs-ref-h">Woher</h2>
        <Segmented<SourcesView> value={view} onChange={setView} label="Links oder Kampagnen" options={[['links', 'Links'], ['campaigns', 'Kampagnen']]} />
      </div>
      {view === 'links' ? (
        <>
          <p className="vs-card-note vs-card-lede">Links, die hierher führen</p>
          <RankList
            rows={s.referrers} total={s.referrers.reduce((a, r) => a + r.views, 0)} label="Referrer" empty="Keine Aufrufe von aussen."
            href={(r) => (r.key === INTERNAL_REFERRER ? null : to({ quelle: r.key || DIRECT }))} linkText={(r) => r.key || 'Direkt / Lesezeichen'}
            format={(r) => (r.key ? r.key : 'Direkt / Lesezeichen')}
          />
          <p className="vs-card-foot">
            {h.airlock > 0 && <>Eigene Airlock-Aufrufe ({nf(h.airlock)}) sind ausgeblendet. </>}
            {h.internal > 0 && <>Klicks innerhalb der Seite ({nf(h.internal)}) zählen hier nicht.</>}
            {h.airlock === 0 && h.internal === 0 && 'Nur der Name der Seite, nie Pfad oder Suchbegriff.'}
          </p>
        </>
      ) : (
        <>
          <p className="vs-card-note vs-card-lede">utm_source · medium · campaign</p>
          <RankList
            rows={campaigns} total={s.totals.views} label="Kampagnen" empty="Keine Aufrufe mit utm_source oder utm_campaign."
            href={(r) => to({ kampagne: r.key })} linkText={(r) => r.campaign || r.source}
            format={(r) => (
              <span title={[r.source, r.medium, r.campaign].filter(Boolean).join(' · ')}>
                {r.campaign || r.source}
                <span className="muted">{[r.campaign ? r.source : '', r.medium].filter(Boolean).map((x) => ` · ${x}`).join('')}</span>
              </span>
            )}
          />
          <p className="vs-card-foot">Anteil an allen Aufrufen. Der übrige Query-String wird nicht gespeichert.</p>
        </>
      )}
    </section>
  )
}

type DevicesView = 'type' | 'browsers' | 'systems'

function Devices({ s, to }: { s: TrafficSummaryDto; to: ToEinzeln }) {
  const [view, setView] = useState<DevicesView>('type')
  const rows = view === 'type' ? s.devices : byFamily(view === 'browsers' ? s.browsers : s.systems)
  const total = rows.reduce((a, r) => a + r.views, 0)
  const name = (k: string) => (view === 'type' ? TRAFFIC_DEVICE_LABEL[k as TrafficDevice] ?? unknownWord(k) : unknownWord(k))
  const versions = view === 'type' ? [] : (view === 'browsers' ? s.browsers : s.systems).filter((r) => r.key !== UNKNOWN_VALUE).slice(0, 4).map((r) => r.key)
  return (
    <section className="panel panel-pad vs-card" aria-labelledby="vs-dev-h">
      <div className="vs-card-head">
        <h2 className="vs-card-title" id="vs-dev-h">Geräte</h2>
        <Segmented<DevicesView> value={view} onChange={setView} label="Gerätetyp, Browser oder System" options={[['type', 'Typ'], ['browsers', 'Browser'], ['systems', 'System']]} />
      </div>
      <RankList
        rows={rows} total={total} label={{ type: 'Gerätetypen', browsers: 'Browser', systems: 'Betriebssysteme' }[view]} empty="Keine Aufrufe."
        href={(r) => to(view === 'type' ? { geraet: r.key } : view === 'browsers' ? { browser: r.key } : { system: r.key })} linkText={(r) => name(r.key)}
        format={(r) => name(r.key)}
      />
      <p className="vs-card-foot">
        {versions.length > 0 ? <>Häufigste Versionen: {versions.join(' · ')}</> : 'Klick auf eine Zeile zeigt die passenden Einzelaufrufe.'}
      </p>
    </section>
  )
}

/* --- Datenbanken von DB-IP -------------------------------------------------------- */

/**
 * Städte und Provider sind optional: erst nach dem Klick lädt der Server die
 * Datei von DB-IP (CC BY 4.0, monatlich neu). Vorher fragt Airlock nie dort an.
 */
export function DbipButton({ kind, label }: { kind: 'city' | 'asn'; label?: string }) {
  const qc = useQueryClient()
  const load = useMutation({
    meta: { errorTitle: kind === 'city' ? 'Städte-Datenbank nicht geladen' : 'Provider-Datenbank nicht geladen' },
    mutationFn: () => (kind === 'city' ? api.loadCityDb() : api.loadAsnDb()),
    onSuccess: (r) => {
      notifyOk(kind === 'city' ? 'Städte-Datenbank geladen' : 'Provider-Datenbank geladen', {
        description: `DB-IP «IP to ${kind === 'city' ? 'City' : 'ASN'} Lite», Stand ${r.month}. Gilt für neue Aufrufe.`,
      })
      void qc.invalidateQueries({ queryKey: ['traffic'] })
      void qc.invalidateQueries({ queryKey: ['traffic-sources'] })
    },
  })
  return (
    <button type="button" className="link-button" onClick={() => load.mutate()} disabled={load.isPending} aria-busy={load.isPending || undefined}>
      {load.isPending ? 'Wird geladen …' : label ?? (kind === 'city' ? 'Städte-Datenbank laden' : 'Provider-Datenbank laden')}
    </button>
  )
}

function CityHint({ s }: { s: TrafficSummaryDto }) {
  if (s.source.cfLocation && !s.source.cityDb) return <>Städte: von Cloudflare (Kopfzeilen «Visitor Location»).</>
  if (s.source.cityDb) return <>Städte: <a href="https://db-ip.com" target="_blank" rel="noreferrer">IP Geolocation by DB-IP<span className="sr-only"> (neues Fenster)</span></a> (CC BY 4.0, Stand {s.source.cityDb}).</>
  return <>Städte: <DbipButton kind="city" /> (DB-IP, CC BY 4.0) oder Cloudflare-Kopfzeilen (Server › Besucher).</>
}

/* --- «Wie gezählt wird» -------------------------------------------------------- */

const IconInfo = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <circle cx="8" cy="8" r="6.3" /><path d="M8 7.2v3.9M8 4.9v.1" />
  </svg>
)

/**
 * Eine Zeile mit ⓘ statt Fliesstext; der Knopf klappt die Einzelheiten als
 * Popover auf (Esc und Klick daneben schliessen, Fokus zurück auf den Knopf).
 */
function HowCounted() {
  const [open, setOpen] = useState(false)
  const id = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setOpen(false)
      btnRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <div className="vs-info" ref={rootRef}>
      <p className="vs-info-line">
        <button ref={btnRef} type="button" className="vs-info-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
          <IconInfo /><span>Wie gezählt wird</span>
        </button>
        <span>: ohne Cookies, ohne IP, Bots und Airlock-Prüfungen nicht mitgezählt · Quellen &amp; Datenbanken unter <Link to="/server/besucher">Server › Besucher</Link></span>
      </p>
      <div id={id} className="vs-pop" data-open={open ? '' : undefined} role="region" aria-label="Wie gezählt wird">
        <p>
          Aus dem Zugriffs-Log von Caddy, ohne Cookies und ohne Skript im Projekt. Gespeichert werden nur Zähler je Stunde, keine IP-Adressen;
          Besucher sind eindeutig je Tag (Hash mit täglich neuem Salz).
        </p>
        <p>
          Nicht gezählt: Bots (User-Agent oder Rechenzentrum), Healthchecks, statische Dateien und eigene Prüfungen von Airlock.
          Aufbewahrung 13 Monate; die Einzelaufrufe kommen direkt aus dem Log und reichen 2 Tage zurück.
        </p>
        <p>Länder von Cloudflare, Städte und Netze nach Wahl aus der Datenbank von DB-IP; Tailnet ohne Gerätenamen.</p>
      </div>
    </div>
  )
}

/* --- Auswertung ------------------------------------------------------------------- */

function Evaluation({ p, range, way, params, onLogs, slot }: {
  p: ProjectDto; range: TrafficRange; way: TrafficWay | 'all'; params: URLSearchParams; onLogs?: () => void
  /** Platz rechts in der Kopfzeile */
  slot: HTMLElement | null
}) {
  const [metric, setMetric] = useState<TrafficMetric>('views')
  const [mode, setMode] = useChartMode()
  const q = useTraffic(p.id, range, way)
  const live = useLiveVisits(p.id)
  const s = q.data
  const to: ToEinzeln = (facets, status) => einzelnSearch(params, facets, status)
  const liveHref = `?${(() => { const n = new URLSearchParams(params); n.set('ansicht', 'einzeln'); return n.toString() })()}`

  const panel = (body: ReactNode) => (
    <>
      {slot && createPortal(<ActiveNow live={live} liveHref={liveHref} />, slot)}
      <div id="vs-view" role="tabpanel" aria-labelledby="vs-tab-auswertung" className="vs-view">{body}</div>
    </>
  )

  if (!s && q.isError) return panel(<ErrorState plural what="Die Besucherzahlen" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />)
  if (!s) return panel(<Loading label="Besucher werden geladen"><SkRows n={6} /></Loading>)
  if ((s.source?.ingest ?? 'off') === 'off') {
    return panel(
      <EmptyState title="Besucher werden nicht gezählt">
        Airlock liest dafür das Zugriffs-Log von Caddy (Volume caddy_access, Einstellung ACCESS_LOG_DIR). Es ist auf diesem Server nicht eingerichtet.
      </EmptyState>,
    )
  }
  const r = trafficRange(range)
  const wayViews = (w: TrafficWay) => s.ways.find((x) => x.way === w)?.views ?? 0
  const allViews = s.ways.reduce((a, x) => a + x.views, 0)
  const nothing = !hasAny(s)

  return panel(
    <>
      {s.source.ingest === 'waiting' && (
        <div className="notice notice-info" role="status">
          <span><strong>Wartet auf das Zugriffs-Log von Caddy.</strong> Es entsteht mit dem Volume caddy_access (nach «docker compose up -d»); bis dahin gibt es keine neuen Zahlen.</span>
        </div>
      )}

      <section className="panel vs-main" aria-label="Kennzahlen und Verlauf">
        <Kpis s={s} metric={metric} onMetric={setMetric} />
        <div className="vs-main-chart">
          {s.series.length === 0
            ? <p className="muted vs-empty">Noch nicht gemessen – die Kurve beginnt mit dem ersten gelesenen Aufruf.</p>
            : <VisitorsChart s={s} metric={metric} mode={mode} onMode={setMode} />}
        </div>
      </section>

      {nothing ? (
        <EmptyState title={`Keine Aufrufe ${r.within}${way === 'all' ? '' : ` über ${TRAFFIC_WAY_LABEL[way]}`}`}>
          {s.source.since ? `Gezählt wird seit dem ${fmtDayMonth(s.source.since)}` : 'Sobald jemand die Seite öffnet, erscheint der Aufruf hier (spätestens nach einer Minute).'}
          {allViews > 0 && way !== 'all' && ' Andere Zugänge haben Aufrufe – «Alle» zeigt sie.'}
        </EmptyState>
      ) : (
        <>
          <Geo s={s} last={live.events[0]} internetInRange={wayViews('public') > 0} to={to} />
          <div className="vs-grid-3">
            <Pages s={s} to={to} onLogs={onLogs} />
            <Sources s={s} to={to} />
            <Devices s={s} to={to} />
          </div>
        </>
      )}

      <HowCounted />
    </>,
  )
}

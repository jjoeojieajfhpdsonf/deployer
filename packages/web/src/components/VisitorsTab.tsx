import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  TRAFFIC_TAB_RANGES, TRAFFIC_WAYS, TRAFFIC_WAY_LABEL, TRAFFIC_DEVICE_LABEL, UNKNOWN_VALUE, countryName, languageName, trafficRange,
  type ProjectDto, type TrafficDevice, type TrafficLiveEventDto, type TrafficRange, type TrafficRowDto, type TrafficSummaryDto, type TrafficWay,
} from '@airlock/shared'
import { api, subscribeTraffic, type MeDto } from '../api.js'
import { notifyOk } from '../lib/feedback.js'
import { fmtDayMonth, fmtTime, msOf } from '../lib/dates.js'
import {
  METRICS, METRIC_LABEL, NOT_FOUND_WARN, activeNow, deltaLabel, flagOf, fmtMetric, hasAny, nf, plural, rangeFromSlug, rangeSlug, shareLabel,
  wayFromSlug, waySlug, type TrafficMetric,
} from '../lib/traffic-view.js'
import type { MapView } from '../lib/world-map.js'
import { useTraffic } from './Traffic.js'
import { VisitorsChart, type ChartMode } from './VisitorsChart.js'
import { EmptyState, ErrorState, Loading, Sk, SkRows } from './States.js'

/**
 * «Besucher neu»: Reiter «Besucher» der Projektseite (Vorlage
 * docs/design-cal/besucher-neu/). Reihenfolge wie im Bild: Kopfzeile
 * (Zeitraum, Zugang, gerade aktiv) → Kennzahlen mit Kurve → Karte «Woher
 * die Besucher kommen» → Seiten / Nicht gefunden / Woher → Netz, Sprachen,
 * Kampagnen → Gerade eben.
 *
 * Quelle sind Caddys Zugriffs-Logs – ohne Cookies, ohne Skript im Projekt,
 * ohne gespeicherte IP. Fehlt eine Quelle (Log nicht eingerichtet, keine
 * Städte- oder Provider-Datenbank), fehlt das Element bzw. steht ein
 * Hinweis mit dem Knopf, der sie lädt.
 */

const LazyMap = lazy(() => import('./WorldMap.js'))

/* --- Adresse und Präferenz ---------------------------------------------------- */

/** Zeitraum und Zugang in der Adresse (?zeitraum=30-tage&zugang=internet); Standard 7 Tage, alle */
function useRangeAndWay(): [TrafficRange, TrafficWay | 'all', (r: TrafficRange) => void, (w: TrafficWay | 'all') => void] {
  const [params, setParams] = useSearchParams()
  const range = rangeFromSlug(params.get('zeitraum'))
  const way = wayFromSlug(params.get('zugang'))
  const set = useCallback((key: string, value: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    }, { replace: true })
  }, [setParams])
  return [range, way, (r) => set('zeitraum', r === '7d' ? null : rangeSlug(r)), (w) => set('zugang', waySlug(w))]
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

/* --- Live: gerade aktiv und «Gerade eben» --------------------------------------- */

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
 * danach neue aus dem Live-Strom. Bei verstecktem Tab pausiert (Strom zu);
 * beim Zurückkommen neu geladen. Keine IP, keine Kennung.
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
  const fresh = useMemo(() => new Set(live.map(eventKey)), [live])
  return { events, fresh, now, visible, loaded: recent.isSuccess, failed: recent.isError }
}

const secondsAgo = (at: string, now: number) => {
  const s = Math.max(0, Math.round((now - (msOf(at) ?? now)) / 1000))
  if (s < 60) return `vor ${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `vor ${m} Min.`
  return `vor ${Math.round(m / 60)} Std.`
}

/** Herkunft eines Aufrufs: Flagge und Stadt bzw. Land (Internet), sonst Tailnet/Heimnetz */
function Origin({ e, short }: { e: Pick<TrafficLiveEventDto, 'access' | 'country' | 'city'>; short?: boolean }) {
  if (e.access !== 'public') return <>{TRAFFIC_WAY_LABEL[e.access]}</>
  const flag = e.country ? flagOf(e.country) : ''
  const place = e.city || (e.country ? countryName(e.country) : '')
  return (
    <>
      {flag && <span className="vs-flag" aria-hidden="true">{flag}</span>}
      {short ? (place || 'Internet') : <>Internet{place && <span className="muted"> · {place}</span>}</>}
    </>
  )
}

function ActiveNow({ live }: { live: ReturnType<typeof useLiveVisits> }) {
  const n = activeNow(live.events, live.now)
  const last = live.events[0]
  return (
    <p className="vs-active" aria-live="polite">
      <span className={`vs-active-dot${n > 0 ? ' vs-active-on' : ''}`} aria-hidden="true" />
      <strong className="num">{nf(n)}</strong>
      <span>{' '}gerade aktiv</span>
      {last && <span className="muted"> · zuletzt {secondsAgo(last.at, live.now)} aus <Origin e={last} short /></span>}
      {!live.visible && <span className="muted"> · pausiert</span>}
    </p>
  )
}

function Recent({ live, accessLabel, onAccess }: { live: ReturnType<typeof useLiveVisits>; accessLabel: string; onAccess?: () => void }) {
  const rows = live.events.slice(0, 8)
  return (
    <section className="panel panel-pad vs-card" aria-labelledby="vs-recent-h">
      <div className="vs-card-head">
        <h2 className="vs-card-title" id="vs-recent-h">Gerade eben</h2>
        <span className="vs-card-note">{live.visible ? 'letzte Aufrufe, live' : 'pausiert, solange der Tab verborgen ist'}</span>
      </div>
      {rows.length === 0 ? (
        <p className="muted vs-empty">{live.failed ? 'Die letzten Aufrufe sind gerade nicht abrufbar.' : live.loaded ? 'Seit dem Start von Airlock noch kein Aufruf. Neue erscheinen hier sofort.' : 'Wird geladen …'}</p>
      ) : (
        <table className="vs-recent">
          <thead className="sr-only"><tr><th>Zeit</th><th>Herkunft</th><th>Seite</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((e) => {
              const k = eventKey(e)
              return (
                <tr key={k} className={live.fresh.has(k) ? 'vs-row-new' : undefined}>
                  <td className="vs-recent-time num">{fmtTime(e.at, true)}</td>
                  <td className="vs-recent-from"><Origin e={e} short={false} /></td>
                  <td className="vs-recent-path"><code title={e.path}>{e.path}</code></td>
                  <td className={`vs-recent-status num${e.status >= 400 ? ' vs-warn' : ''}`}>{e.status}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <p className="vs-card-foot">
        Ohne IP und ohne Kennung – nur Zeit, Herkunft, Seite, Status.
        {onAccess && <> Einzelaufrufe unter <button type="button" className="link-button" onClick={onAccess}>«{accessLabel}»</button>.</>}
      </p>
    </section>
  )
}

/* --- Bausteine ---------------------------------------------------------------- */

/** Rangliste mit Balken als Fläche hinter der Zeile; «› x weitere» klappt auf */
function RankList<T extends TrafficRowDto>({ rows, total, label, format, initial = 5, tone, extra, empty, code }: {
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
}) {
  const [open, setOpen] = useState(false)
  if (rows.length === 0) return <p className="muted vs-empty">{empty}</p>
  const max = Math.max(...rows.map((r) => r.views))
  const shown = open ? rows : rows.slice(0, initial)
  const more = rows.length - initial
  return (
    <>
      <ol className={`vs-rank${tone ? ` vs-rank-${tone}` : ''}`} aria-label={label}>
        {shown.map((r) => (
          <li key={r.key}>
            <span className="vs-rank-bar" style={{ width: `${Math.max(2, (r.views / max) * 100)}%` }} aria-hidden="true" />
            <span className={`vs-rank-label${code ? ' vs-rank-code' : ''}`}>{format(r)}</span>
            <span className="vs-rank-n num">{nf(r.views)}</span>
            <span className="vs-rank-share num">{extra?.(r) ?? shareLabel(r.views, total)}</span>
          </li>
        ))}
      </ol>
      {more > 0 && (
        <button type="button" className="vs-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? '‹ weniger' : `› ${nf(more)} weitere`}
        </button>
      )}
    </>
  )
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented segmented-sm" role="group" aria-label={label}>
      {options.map(([k, text]) => <button key={k} type="button" aria-pressed={value === k} onClick={() => onChange(k)}>{text}</button>)}
    </div>
  )
}

/** Gestapelter Balken mit Wörtern (Geräte, Browser, System): oberste vier, der Rest als «Andere» */
function StackBar({ rows, label, name }: { rows: TrafficRowDto[]; label: string; name: (k: string) => string }) {
  const total = rows.reduce((a, r) => a + r.views, 0)
  if (total === 0) return <p className="muted vs-empty">Keine Aufrufe.</p>
  const top = rows.slice(0, 4)
  const rest = total - top.reduce((a, r) => a + r.views, 0)
  const parts = [...top.map((r) => ({ k: r.key, text: name(r.key), v: r.views })), ...(rest > 0 ? [{ k: '(andere)', text: 'Andere', v: rest }] : [])]
  return (
    <div className="vs-stack">
      <p className="vs-stack-words">{parts.map((p, i) => <span key={p.k}>{i > 0 && ' · '}{p.text} <span className="num">{shareLabel(p.v, total)}</span></span>)}</p>
      <div className="vs-stack-bar" role="img" aria-label={`${label}: ${parts.map((p) => `${p.text} ${shareLabel(p.v, total)}`).join(', ')}`}>
        {parts.map((p, i) => <span key={p.k} className={`vs-seg vs-seg-${i + 1}`} style={{ flexGrow: p.v }} />)}
      </div>
    </div>
  )
}

/** Browser und System nach Familie zusammengefasst («Chrome 131» + «Chrome 130» → Chrome) */
function byFamily(rows: TrafficRowDto[]): TrafficRowDto[] {
  const m = new Map<string, TrafficRowDto>()
  for (const r of rows) {
    const fam = r.key === UNKNOWN_VALUE ? UNKNOWN_VALUE : r.key.replace(/ \d+$/, '')
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

type AgentView = 'devices' | 'browsers' | 'systems'

function Geo({ s, last, onCityDb }: { s: TrafficSummaryDto; last: TrafficLiveEventDto | undefined; onCityDb: ReactNode }) {
  const [view, setView] = useState<MapView>('world')
  const [place, setPlace] = useState<'countries' | 'cities'>('countries')
  const [agent, setAgent] = useState<AgentView>('devices')
  const internetViews = s.countries.reduce((a, c) => a + c.views, 0)
  const hasCountries = s.countries.length > 0
  const cities = s.cities
  const lastOrigin = last && last.access === 'public' && last.country ? { country: last.country, city: last.city } : null
  const agents: Record<AgentView, { rows: TrafficRowDto[]; name: (k: string) => string; label: string }> = {
    devices: { rows: s.devices, name: (k) => TRAFFIC_DEVICE_LABEL[k as TrafficDevice] ?? unknownWord(k), label: 'Geräte' },
    browsers: { rows: byFamily(s.browsers), name: unknownWord, label: 'Browser' },
    systems: { rows: byFamily(s.systems), name: unknownWord, label: 'Betriebssysteme' },
  }
  const a = agents[agent]
  const agentSwitch = <Segmented<AgentView> value={agent} onChange={setAgent} label="Geräte, Browser oder System" options={[['devices', 'Geräte'], ['browsers', 'Browser'], ['systems', 'System']]} />
  const devicePart = (
    <div className="vs-agents">
      {hasCountries && (
        <div className="vs-card-head">
          <h3 className="vs-sub">{a.label}</h3>
          {agentSwitch}
        </div>
      )}
      <StackBar rows={a.rows} label={a.label} name={a.name} />
      {agent !== 'devices' && a.rows.length > 0 && (
        <p className="vs-card-foot">
          Häufigste Versionen: {(agent === 'browsers' ? s.browsers : s.systems).filter((r) => r.key !== UNKNOWN_VALUE).slice(0, 4).map((r) => r.key).join(' · ') || '–'}
        </p>
      )}
    </div>
  )
  if (!hasCountries) {
    return (
      <section className="panel panel-pad vs-card" aria-labelledby="vs-geo-h">
        <div className="vs-card-head">
          <h2 className="vs-card-title" id="vs-geo-h">{a.label}</h2>
          {agentSwitch}
        </div>
        {devicePart}
        <p className="vs-card-foot">Länder und Karte gibt es nur für Aufrufe aus dem Internet.</p>
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
          <LazyMap countries={s.countries} view={view} last={lastOrigin} />
        </Suspense>
      </div>
      <div className="vs-geo-side">
        <div className="vs-card-head">
          {cities.length > 0
            ? <Segmented value={place} onChange={setPlace} label="Länder oder Städte" options={[['countries', 'Länder'], ['cities', 'Städte']]} />
            : <h3 className="vs-sub">Länder</h3>}
          <span className="vs-card-note">nur Internet</span>
        </div>
        {place === 'cities' && cities.length > 0
          ? <RankList rows={cities} total={internetViews} label="Städte" empty="Keine." initial={6} format={(r) => <><span className="vs-flag" aria-hidden="true">{flagOf(r.country)}</span>{r.key}</>} />
          : <RankList rows={s.countries} total={internetViews} label="Länder" empty="Keine." initial={6} format={(r) => <><span className="vs-flag" aria-hidden="true">{flagOf(r.key)}</span>{countryName(r.key)}</>} />}
        <p className="vs-card-foot">{onCityDb}</p>
        {devicePart}
      </div>
    </section>
  )
}

/* --- Seiten, Nicht gefunden, Woher ---------------------------------------------- */

type PagesView = 'all' | 'entry' | 'exit'

function Pages({ s }: { s: TrafficSummaryDto }) {
  const [view, setView] = useState<PagesView>('all')
  const rows = view === 'all' ? s.pages : view === 'entry' ? s.entries : s.exits
  const total = rows.reduce((a, r) => a + r.views, 0)
  return (
    <section className="panel panel-pad vs-card" aria-labelledby="vs-pages-h">
      <div className="vs-card-head">
        <h2 className="vs-card-title" id="vs-pages-h">Seiten</h2>
        <Segmented<PagesView> value={view} onChange={setView} label="Alle Seiten, Einstieg oder Ausstieg" options={[['all', 'Alle'], ['entry', 'Einstieg'], ['exit', 'Ausstieg']]} />
      </div>
      <p className="vs-card-note vs-card-lede">
        {view === 'all' ? 'erfolgreich aufgerufen (2xx, 3xx)' : view === 'entry' ? 'erste Seite eines Besuchs' : 'letzte Seite eines Besuchs (nach 30 Min. ohne Aufruf)'}
      </p>
      <RankList
        rows={rows} total={total} code label={view === 'all' ? 'Seiten' : view === 'entry' ? 'Einstiegsseiten' : 'Ausstiegsseiten'}
        empty={view === 'all' ? 'Keine Seiten im Zeitraum.' : view === 'entry' ? 'Noch keine Besuche gezählt.' : 'Noch kein Besuch abgeschlossen.'}
        format={(r) => <code title={r.key}>{r.key || '/'}</code>}
      />
      {view !== 'all' && <p className="vs-card-foot">Ohne Besucher mit «Do Not Track» oder «Global Privacy Control».</p>}
    </section>
  )
}

function NotFound({ s, logsLabel, onLogs }: { s: TrafficSummaryDto; logsLabel: string; onLogs?: () => void }) {
  const total = s.notFound.reduce((a, r) => a + r.views, 0)
  const errors = s.totals.serverErrors
  return (
    <section className="panel panel-pad vs-card" aria-labelledby="vs-404-h">
      <div className="vs-card-head">
        <h2 className="vs-card-title" id="vs-404-h">Nicht gefunden</h2>
        <span className="vs-card-note">404 · Tippfehler, Scanner</span>
      </div>
      <RankList
        rows={s.notFound} total={total} code tone="warn" label="Nicht gefundene Pfade" empty="Keine 404 im Zeitraum."
        format={(r) => <code title={r.key}>{r.key}</code>}
        extra={(r) => (r.scanner ? <span className="vs-bot" title="Typischer Pfad von Scannern, die Lücken suchen (WordPress, .git, phpMyAdmin …)">bot?</span> : undefined)}
      />
      <p className="vs-card-foot">
        {errors > 0
          ? <>Serverfehler (5xx): <span className="num">{nf(errors)}</span>{onLogs && <> · <button type="button" className="link-button" onClick={onLogs}>→ {logsLabel}</button></>}</>
          : 'Keine Serverfehler (5xx).'}
      </p>
    </section>
  )
}

function Referrers({ s }: { s: TrafficSummaryDto }) {
  const total = s.referrers.reduce((a, r) => a + r.views, 0)
  const h = s.referrersHidden
  return (
    <section className="panel panel-pad vs-card" aria-labelledby="vs-ref-h">
      <div className="vs-card-head">
        <h2 className="vs-card-title" id="vs-ref-h">Woher</h2>
        <span className="vs-card-note">Links, die hierher führen</span>
      </div>
      <RankList rows={s.referrers} total={total} label="Referrer" empty="Keine Aufrufe von aussen." format={(r) => (r.key ? r.key : 'Direkt / Lesezeichen')} />
      <p className="vs-card-foot">
        {h.airlock > 0 && <>Eigene Airlock-Aufrufe ({nf(h.airlock)}) sind ausgeblendet. </>}
        {h.internal > 0 && <>Klicks innerhalb der Seite ({nf(h.internal)}) zählen hier nicht.</>}
        {h.airlock === 0 && h.internal === 0 && 'Nur der Name der Seite, nie Pfad oder Suchbegriff.'}
      </p>
    </section>
  )
}

/* --- Netz, Sprachen, Kampagnen ---------------------------------------------------- */

function Networks({ s, dbButton }: { s: TrafficSummaryDto; dbButton: ReactNode }) {
  const people = s.networks.filter((n) => n.views > 0)
  const dc = s.networks.filter((n) => n.datacenter && n.bots > 0)
  const total = people.reduce((a, n) => a + n.views, 0)
  return (
    <section className="panel panel-pad vs-card" aria-labelledby="vs-net-h">
      <div className="vs-card-head">
        <h2 className="vs-card-title" id="vs-net-h">Netz</h2>
        <span className="vs-card-note">Provider, nur Internet</span>
      </div>
      {!s.source.asnDb ? (
        <p className="muted vs-empty">{dbButton}</p>
      ) : (
        <>
          <RankList rows={people.map((n) => ({ key: String(n.asn), views: n.views, visitors: 0, name: n.name }))} total={total} label="Provider" empty="Noch keine Aufrufe mit bekanntem Netz." format={(r) => <span title={`AS${r.key}`}>{r.name || `AS${r.key}`}</span>} />
          {dc.length > 0 && (
            <p className="vs-card-foot">
              Rechenzentren, als Bot gezählt (<span className="vs-bot">vermutlich Bot</span>): {dc.slice(0, 4).map((n) => `${n.name || `AS${n.asn}`} ${nf(n.bots)}`).join(' · ')}
            </p>
          )}
        </>
      )}
    </section>
  )
}

function Languages({ s }: { s: TrafficSummaryDto }) {
  const total = s.languages.reduce((a, r) => a + r.views, 0)
  return (
    <section className="panel panel-pad vs-card" aria-labelledby="vs-lang-h">
      <div className="vs-card-head">
        <h2 className="vs-card-title" id="vs-lang-h">Sprachen</h2>
        <span className="vs-card-note">erste Sprache des Browsers</span>
      </div>
      <RankList rows={s.languages} total={total} label="Sprachen" empty="Noch keine Angaben." format={(r) => (r.key === UNKNOWN_VALUE ? 'Unbekannt' : languageName(r.key))} />
    </section>
  )
}

function Campaigns({ s }: { s: TrafficSummaryDto }) {
  const rows = s.campaigns.map((c) => ({ ...c, key: [c.source, c.medium, c.campaign].join('|') }))
  const total = s.totals.views
  return (
    <section className="panel panel-pad vs-card" aria-labelledby="vs-utm-h">
      <div className="vs-card-head">
        <h2 className="vs-card-title" id="vs-utm-h">Kampagnen</h2>
        <span className="vs-card-note">utm_source · medium · campaign</span>
      </div>
      <RankList rows={rows} total={total} label="Kampagnen" empty="Keine." format={(r) => (
        <span title={[r.source, r.medium, r.campaign].filter(Boolean).join(' · ')}>
          {r.campaign || r.source}
          <span className="muted">{[r.campaign ? r.source : '', r.medium].filter(Boolean).map((x) => ` · ${x}`).join('')}</span>
        </span>
      )} />
      <p className="vs-card-foot">Anteil an allen Aufrufen. Der übrige Query-String wird nicht gespeichert.</p>
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
  if (s.source.cityDb) return <>Städte: <a href="https://db-ip.com" target="_blank" rel="noreferrer">IP Geolocation by DB-IP</a> (CC BY 4.0, Stand {s.source.cityDb}).</>
  return <>Städte: <DbipButton kind="city" /> (DB-IP, CC BY 4.0) oder Cloudflare-Kopfzeilen (Server › Besucher).</>
}

/* --- Reiter ---------------------------------------------------------------------- */

export function TrafficTab({ p, onAccessLog, onLogs }: { p: ProjectDto; onAccessLog?: () => void; onLogs?: () => void }) {
  const [range, way, setRange, setWay] = useRangeAndWay()
  const [metric, setMetric] = useState<TrafficMetric>('views')
  const [mode, setMode] = useChartMode()
  const q = useTraffic(p.id, range, way)
  const live = useLiveVisits(p.id)
  const s = q.data
  const isStatic = Boolean(onAccessLog)
  const accessLabel = isStatic ? 'Zugriffe' : 'Logs'
  const toAccess = onAccessLog ?? onLogs

  if (!s && q.isError) return <ErrorState plural what="Die Besucherzahlen" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
  if (!s) return <Loading label="Besucher werden geladen"><SkRows n={6} /></Loading>
  if ((s.source?.ingest ?? 'off') === 'off') {
    return (
      <EmptyState title="Besucher werden nicht gezählt">
        Airlock liest dafür das Zugriffs-Log von Caddy (Volume caddy_access, Einstellung ACCESS_LOG_DIR). Es ist auf diesem Server nicht eingerichtet.
      </EmptyState>
    )
  }
  const r = trafficRange(range)
  const wayViews = (w: TrafficWay) => s.ways.find((x) => x.way === w)?.views ?? 0
  const allViews = s.ways.reduce((a, x) => a + x.views, 0)
  const nothing = !hasAny(s)
  const internetInRange = wayViews('public') > 0

  return (
    <div className="tab-panel vs-page">
      <div className="vs-top">
        <Segmented<TrafficRange> value={range} onChange={setRange} label="Zeitraum" options={TRAFFIC_TAB_RANGES.map((k) => [k, trafficRange(k).label])} />
        <Segmented<TrafficWay | 'all'>
          value={way} onChange={setWay} label="Nach Zugang trennen"
          options={[['all', 'Alle'], ...TRAFFIC_WAYS.map((w): [TrafficWay, ReactNode] => [w, <>{TRAFFIC_WAY_LABEL[w]} <span className="num">{nf(wayViews(w))}</span></>])]}
        />
        <ActiveNow live={live} />
      </div>

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
          {s.source.since ? `Gezählt wird seit dem ${fmtDayMonth(s.source.since)}` :'Sobald jemand die Seite öffnet, erscheint der Aufruf hier (spätestens nach einer Minute).'}
          {allViews > 0 && way !== 'all' && ' Andere Zugänge haben Aufrufe – «Alle» zeigt sie.'}
        </EmptyState>
      ) : (
        <>
          <Geo s={s} last={live.events[0]} onCityDb={<CityHint s={s} />} />
          <div className="vs-grid-3">
            <Pages s={s} />
            <NotFound s={s} logsLabel={accessLabel} onLogs={toAccess} />
            <Referrers s={s} />
          </div>
          <div className={`vs-grid-3${s.campaigns.length ? '' : ' vs-grid-2'}`}>
            {(internetInRange || s.source.asnDb) && <Networks s={s} dbButton={<>Provider (Swisscom, Init7 …) und Rechenzentren zeigt Airlock mit der freien Datei «IP to ASN Lite» von DB-IP (CC BY 4.0): <DbipButton kind="asn" /></>} />}
            <Languages s={s} />
            {s.campaigns.length > 0 && <Campaigns s={s} />}
          </div>
        </>
      )}

      <Recent live={live} accessLabel={accessLabel} onAccess={toAccess} />

      <p className="hint vs-source">
        Aus dem Zugriffs-Log von Caddy, ohne Cookies und ohne Skript im Projekt. Gespeichert werden nur Zähler je Stunde, keine IP-Adressen;
        Besucher sind eindeutig je Tag (Hash mit täglich neuem Salz). Bots (User-Agent oder Rechenzentrum), Healthchecks, statische Dateien und
        eigene Prüfungen von Airlock zählen nicht. Aufbewahrung 13 Monate. Länder von Cloudflare; Tailnet ohne Gerätenamen.
        {s.source.asnDb && <> Netze: <a href="https://db-ip.com" target="_blank" rel="noreferrer">IP Geolocation by DB-IP</a> (CC BY 4.0, Stand {s.source.asnDb}).</>}
      </p>
    </div>
  )
}

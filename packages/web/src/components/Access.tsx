import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import {
  ACCESS_BLOCK_LABEL, ACCESS_KIND_WORD, ACCESS_MAX, ACCESS_STATUS_FILTERS, LOG_RANGES, TRAFFIC_DEVICE_LABEL, TRAFFIC_WAYS, TRAFFIC_WAY_LABEL,
  accessHints, accessKind, accessOrigin, botLabel, browserFamily, countryName, groupAccess, languageName, singleGroups,
  type AccessBlock, type AccessEntryDto, type AccessGroup, type TrafficWay,
} from '@airlock/shared'
import { api, subscribeAccess } from '../api.js'
import { accessCsv, byDay, filterAccess, fmtDuration, groupTime, readFilters, writeFilters, type AccessFilters } from '../lib/access-view.js'
import { fmtStamp, fmtTime, fmtUtc, msOf, nowIso } from '../lib/dates.js'
import { flagOf } from '../lib/traffic-view.js'
import { IconDownload, IconExternal, IconSearch } from './Icons.js'
import { Highlight, downloadText, searchPattern, useLiveFeed } from './LogTools.js'
import { EmptyState, ErrorState, Loading, SkRows } from './States.js'

/**
 * Reiter «Zugriffe» (neu, Vorlage docs/design-cal/zugriffe-neu/): einzelne
 * Anfragen aus Caddys Zugriffs-Log (visits.log, 2 Tage). Werkzeugleiste mit
 * Suche, Status, Zeitraum, Live und CSV; zweite Zeile Zugang und Schalter.
 * Tabelle mit Tagestrennern, gleiche Aufrufe zusammengefasst; rechts das
 * Detail (unter 1100 px als Schublade). Alle Filter stehen in der Adresse.
 * Pfeiltasten wechseln die Zeile, Enter öffnet das Detail.
 */

/** So lange gilt eine Zeile aus dem Live-Strom als neu (Markierung) */
const FRESH_MS = 2400
/** Zeilen auf einmal; mehr auf Wunsch */
const PAGE = 300
const NARROW = '(max-width: 1099px)'

const BLOCK_REASON: Record<AccessBlock, string> = {
  'ip-filter': 'IP-Filter: Der Absender liegt nicht in den freigegebenen Netzen (LAN, Tailnet, Cloudflare).',
  pause: 'Pause: Das Projekt ist öffentlich pausiert, Caddy zeigt die Pause-Seite.',
  'rate-limit': 'Rate-Limit: Zu viele CSP-Meldungen von diesem Absender.',
  other: 'Von Airlock abgewiesen (X-Airlock-Block).',
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(NARROW).matches)
  useEffect(() => {
    const mq = window.matchMedia(NARROW)
    const on = () => setNarrow(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return narrow
}

function StatusPill({ e, reason }: { e: AccessEntryDto; reason?: boolean }) {
  const k = accessKind(e)
  return (
    <span className={`acc-st acc-st-${k}`}>
      <span className="num">{e.status}</span> {ACCESS_KIND_WORD[k]}{reason && e.block ? ` · ${ACCESS_BLOCK_LABEL[e.block]}` : ''}
    </span>
  )
}

function Origin({ e, re }: { e: AccessEntryDto; re: RegExp | null }) {
  const o = accessOrigin(e)
  const flag = e.way === 'public' ? flagOf(e.country) : ''
  const bot = e.probe ? null : botLabel(e)
  const hinted = !bot && !e.probe && accessHints(e).length > 0
  return (
    <span className="acc-origin-in" title={o.detail ? `${o.place} · ${o.detail}` : o.place}>
      {flag && <span className="acc-flag" aria-hidden="true">{flag}</span>}
      {e.way === 'public' && e.country && <span className="sr-only">{countryName(e.country)}, </span>}
      <span className="acc-place">{o.place}</span>
      {o.detail && <span className="acc-detail-text"> · <Highlight text={o.detail} re={re} /></span>}
      {e.probe && <span className="acc-tag" title="Eigene Prüfung von Airlock (User-Agent airlock-probe)">Prüfung</span>}
      {bot && <span className="acc-tag" title={bot === 'Bot' ? 'Der User-Agent sagt: Bot' : 'Rechenzentrum oder typischer Scanner-Pfad – vermutlich Bot'}>{bot}</span>}
      {hinted && <span className="acc-tag" title="Erklärung im Detail">?<span className="sr-only"> Erklärung im Detail</span></span>}
    </span>
  )
}

export function Access({ projectId, slug }: { projectId: string; slug: string }) {
  const [params, setParams] = useSearchParams()
  const f = readFilters(params)
  const update = (patch: Partial<AccessFilters>) => setParams((p) => writeFilters(p, { ...readFilters(p), ...patch }), { replace: true })
  const searchId = useId()
  const narrow = useNarrow()

  const [live, setLive] = useState(true)
  const [streamed, setStreamed] = useState<AccessEntryDto[]>([])
  const [pending, setPending] = useState<AccessEntryDto[]>([])
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())
  const [limit, setLimit] = useState(PAGE)
  const [drawer, setDrawer] = useState(false)
  const liveRef = useRef(live)
  liveRef.current = live
  const lastAt = useRef<string | null>(null)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => () => { for (const t of timers.current) clearTimeout(t) }, [])

  // Kein Polling: der Stand des Zeitraums einmal, neue Anfragen live
  const q = useQuery({
    queryKey: ['access', projectId, f.range],
    queryFn: () => api.access(projectId, f.range),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  })
  useEffect(() => {
    if (!q.data) return
    setStreamed([])
    setPending([])
    lastAt.current = q.data.entries[0]?.at ?? nowIso()
  }, [q.data])

  const markFresh = (id: string) => {
    setFresh((s) => new Set(s).add(id))
    const t = setTimeout(() => {
      timers.current.delete(t)
      setFresh((s) => { const n = new Set(s); n.delete(id); return n })
    }, FRESH_MS)
    timers.current.add(t)
  }

  const streamOpen = useLiveFeed(
    (onState) => subscribeAccess(projectId, lastAt.current, (e) => {
      if (e.at > (lastAt.current ?? '')) lastAt.current = e.at
      if (liveRef.current) {
        setStreamed((s) => [e, ...s.filter((x) => x.id !== e.id)].slice(0, ACCESS_MAX))
        markFresh(e.id)
      } else setPending((p) => [e, ...p].slice(0, ACCESS_MAX))
    }, onState),
    [projectId, q.data],
    Boolean(q.data && !q.data.error && q.data.ingest !== 'off'),
  )

  const all = useMemo(() => {
    const seen = new Set<string>()
    const merged = [...streamed, ...(q.data?.entries ?? [])].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    // Live kann leicht ungeordnet ankommen; Zusammenfassen braucht neueste zuerst
    return merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }, [q.data, streamed])

  const search = useDeferredValue(f.search)
  const re = useMemo(() => searchPattern(search), [search])
  const sinceMs = msOf(q.data?.since) ?? 0
  const view = useMemo(
    () => filterAccess(all, { ...f, search }, sinceMs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, search, f.way, f.hideProbes, f.bots, f.status, sinceMs],
  )
  const groups = useMemo(() => (f.group ? groupAccess(view.list) : singleGroups(view.list)), [view.list, f.group])
  const shown = groups.slice(0, limit)
  const days = byDay(shown, Date.now())
  const selected = f.row ? groups.find((g) => g.id === f.row) ?? groups.find((g) => g.entries.some((e) => e.id === f.row)) ?? null : null
  const range = LOG_RANGES.find((r) => r.key === f.range)!

  // Tastatur: Pfeiltasten wechseln die Zeile, Enter öffnet das Detail
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>())
  const headingRef = useRef<HTMLHeadingElement>(null)
  const focusRow = (id: string) => requestAnimationFrame(() => rowRefs.current.get(id)?.focus())
  const select = (id: string) => update({ row: id })
  const openDetail = () => {
    if (narrow) setDrawer(true)
    requestAnimationFrame(() => headingRef.current?.focus())
  }
  const closeDrawer = () => {
    setDrawer(false)
    if (selected) focusRow(selected.id)
  }
  const onTableKey = (ev: KeyboardEvent<HTMLTableElement>) => {
    const ids = shown.map((g) => g.id)
    if (!ids.length) return
    const cur = selected ? ids.indexOf(selected.id) : -1
    const next = ev.key === 'ArrowDown' ? ids[Math.min(cur + 1, ids.length - 1)]
      : ev.key === 'ArrowUp' ? ids[Math.max(cur - 1, 0)]
      : ev.key === 'Home' ? ids[0] : ev.key === 'End' ? ids.at(-1) : null
    if (next) {
      ev.preventDefault()
      select(next)
      focusRow(next)
      return
    }
    if (ev.key === 'Enter' && selected) {
      ev.preventDefault()
      openDetail()
    }
  }

  const resume = () => {
    setStreamed((s) => [...pending, ...s].slice(0, ACCESS_MAX))
    setPending([])
    setLive(true)
  }
  const download = () => downloadText(`${slug}-zugriffe-${fmtStamp(nowIso()).replace(/[ :]/g, '-')}.csv`, accessCsv(view.list), 'text/csv')
  const reset = () => update({ status: 'alle', way: 'all', search: '', row: null })

  const data = q.data
  const toolbar = data && !data.error && data.ingest !== 'off' && (
    <div className="acc-bar" role="group" aria-label="Werkzeuge der Zugriffe">
      <div className="acc-bar-row">
        <div className="search acc-search">
          <IconSearch />
          <label htmlFor={searchId} className="sr-only">Suchen (Pfad, Land, Provider, Status)</label>
          <input
            id={searchId} type="search" value={f.search} placeholder="Suchen …" autoComplete="off" spellCheck={false}
            title="Pfad, Land, Provider oder Status" onChange={(e) => update({ search: e.target.value, row: null })}
          />
        </div>
        <div className="segmented" role="group" aria-label="Nach Status filtern">
          {ACCESS_STATUS_FILTERS.map((s) => (
            <button key={s.key} type="button" aria-pressed={f.status === s.key} title={s.hint} onClick={() => update({ status: s.key })}>
              {s.label} <span className="num">{view.counts[s.key].toLocaleString('de-CH')}</span>
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Zeitraum">
          {LOG_RANGES.map((r) => (
            <button key={r.key} type="button" aria-pressed={f.range === r.key} onClick={() => update({ range: r.key, row: null })}>{r.label}</button>
          ))}
        </div>
        <span className="acc-bar-gap" />
        {!live && <span className="logbar-paused">Pausiert{pending.length > 0 ? ` · ${pending.length.toLocaleString('de-CH')} neu` : ''}</span>}
        <button type="button" className="button-small logbar-live" aria-pressed={live} onClick={() => (live ? setLive(false) : resume())} title={live ? 'Neue Anfragen erscheinen sofort oben' : 'Neue Anfragen werden gesammelt'}>
          <span className={`logbar-dot${live ? ' logbar-dot-on' : ''}`} aria-hidden="true" />
          Live
        </button>
        <button type="button" className="button-small" onClick={download} disabled={view.list.length === 0} title="Die angezeigten Anfragen als CSV (Absender gekürzt)">
          <IconDownload /> CSV
        </button>
      </div>
      <div className="acc-bar-row">
        <div className="segmented" role="group" aria-label="Nach Zugang filtern">
          <button type="button" aria-pressed={f.way === 'all'} onClick={() => update({ way: 'all' })}>Alle Zugänge</button>
          {TRAFFIC_WAYS.map((w) => (
            <button key={w} type="button" aria-pressed={f.way === w} onClick={() => update({ way: w })}>{TRAFFIC_WAY_LABEL[w]}</button>
          ))}
        </div>
        <label className="acc-check">
          <input type="checkbox" checked={f.group} onChange={(e) => update({ group: e.target.checked })} />
          Gleiche Aufrufe zusammenfassen
        </label>
        <label className="acc-check">
          <input type="checkbox" checked={f.hideProbes} onChange={(e) => update({ hideProbes: e.target.checked })} />
          Airlock-Prüfungen ausblenden <span className="acc-check-num">({view.probes.toLocaleString('de-CH')})</span>
        </label>
        <label className="acc-check">
          <input type="checkbox" checked={f.bots} onChange={(e) => update({ bots: e.target.checked })} />
          Bots zeigen <span className="acc-check-num">({view.bots.toLocaleString('de-CH')})</span>
        </label>
      </div>
    </div>
  )

  let body: ReactNode
  if (!data && q.isError) body = <ErrorState compact what="Das Zugriffs-Log" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
  else if (!data) body = <Loading label="Zugriffe werden geladen"><SkRows n={6} /></Loading>
  else if (data.error) body = <ErrorState compact what="Das Zugriffs-Log" error={new Error(data.error)} retrying={q.isFetching} onRetry={() => void q.refetch()} />
  else if (data.ingest === 'off') {
    body = (
      <EmptyState title="Zugriffs-Log nicht eingerichtet">
        Airlock liest die Anfragen aus Caddys Zugriffs-Log im Volume <code>caddy_access</code> (<code>ACCESS_LOG_DIR</code>). Ohne das Log gibt es hier nichts.
      </EmptyState>
    )
  } else if (all.length === 0) {
    body = data.ingest === 'waiting'
      ? <EmptyState compact title="Caddy hat noch nichts ins Zugriffs-Log geschrieben">Die Datei <code>visits.log</code> fehlt noch. Sobald jemand das Projekt aufruft, erscheint die Anfrage hier.</EmptyState>
      : <EmptyState compact title={`Noch keine Anfragen ${range.within}`} action={f.range !== '24h' ? <button type="button" className="button-small" onClick={() => update({ range: '24h' })}>Letzte 24 Stunden zeigen</button> : undefined}>Öffne die Seite, dann erscheint der Aufruf hier.</EmptyState>
  } else if (view.list.length === 0) {
    body = (
      <EmptyState
        compact
        title={f.search.trim() ? `Keine Anfrage passt zu «${f.search.trim()}»` : 'Keine Anfragen mit diesen Filtern'}
        action={<button type="button" className="button-small" onClick={reset}>Filter zurücksetzen</button>}
      >
        {view.probes + view.bots > 0 && (f.hideProbes || !f.bots) ? 'Ausgeblendet sind auch Airlock-Prüfungen und Bots (Schalter oben).' : null}
      </EmptyState>
    )
  } else {
    const detailId = 'acc-detail-h'
    const detail = selected
      ? <AccessDetail g={selected} headingId={detailId} headingRef={headingRef} onWay={(w) => update({ way: w })} onPath={(p) => update({ search: p })} />
      : (
        <div className="acc-detail-empty">
          <p><strong>Zeile wählen</strong></p>
          <p className="muted">Absender, Gerät, Header und Erklärungen zur Anfrage erscheinen hier. Pfeiltasten wechseln die Zeile, Enter öffnet das Detail.</p>
        </div>
      )
    body = (
      <div className="acc-wrap">
        <div className="panel acc-list">
          <div className="table-scroll acc-scroll">
            <table className="table acc-table" aria-label="Anfragen" onKeyDown={onTableKey}>
              <thead>
                <tr><th scope="col">Zeit</th><th scope="col">Anfrage</th><th scope="col">Status</th><th scope="col">Herkunft</th><th scope="col">Browser</th></tr>
              </thead>
              {days.map((d) => (
                <tbody key={d.key}>
                  <tr className="acc-day"><th scope="colgroup" colSpan={5}>{d.label}</th></tr>
                  {d.groups.map((g, i) => {
                    const e = g.entries[0]!
                    const isSel = selected?.id === g.id
                    const tab = selected ? isSel : d === days[0] && i === 0
                    const isFresh = g.entries.some((x) => fresh.has(x.id))
                    return (
                      <tr
                        key={g.id}
                        ref={(el) => { if (el) rowRefs.current.set(g.id, el); else rowRefs.current.delete(g.id) }}
                        tabIndex={tab ? 0 : -1}
                        aria-current={isSel ? 'true' : undefined}
                        className={`acc-row${isSel ? ' acc-row-sel' : ''}${isFresh ? ' acc-row-new' : ''}`}
                        onClick={() => { select(g.id); if (narrow) setDrawer(true) }}
                        onFocus={() => { if (!selected) select(g.id) }}
                      >
                        <td className="acc-time num" title={fmtUtc(e.at)}>{groupTime(g)}</td>
                        <td className="acc-req">
                          <span className="acc-req-in" title={e.path.length > 24 ? e.path : undefined}>
                            <span className="acc-method">{e.method}</span>
                            <code className="acc-path"><Highlight text={e.path} re={re} /></code>
                            {g.entries.length > 1 && <span className="acc-count"><span aria-hidden="true">×</span>{g.entries.length}<span className="sr-only"> Aufrufe</span></span>}
                          </span>
                        </td>
                        <td><StatusPill e={e} /></td>
                        <td className="acc-origin"><Origin e={e} re={re} /></td>
                        <td className="acc-browser" title={e.browser || undefined}>{browserFamily(e.browser) || '–'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              ))}
            </table>
          </div>
          <p className="acc-foot">
            {groups.length.toLocaleString('de-CH')} {groups.length === 1 ? 'Zeile' : 'Zeilen'} · {view.list.length.toLocaleString('de-CH')} {view.list.length === 1 ? 'Anfrage' : 'Anfragen'} {range.from}
            {data.capped ? ` (die neuesten ${ACCESS_MAX.toLocaleString('de-CH')})` : ''} · Absender gekürzt
            {groups.length > shown.length && <> · <button type="button" className="link-button" onClick={() => setLimit((l) => l + PAGE)}>Weitere {Math.min(PAGE, groups.length - shown.length)} zeigen</button></>}
          </p>
        </div>
        {narrow ? (
          <>
            <div className="acc-scrim" data-open={drawer && Boolean(selected)} onClick={closeDrawer} aria-hidden="true" />
            <div
              className="panel acc-detail acc-drawer"
              data-open={drawer && Boolean(selected)}
              role="dialog"
              aria-modal="true"
              aria-labelledby={detailId}
              onKeyDown={(ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); closeDrawer() } }}
            >
              <div className="acc-drawer-top"><button type="button" className="button-small" onClick={closeDrawer}>Schliessen</button></div>
              {selected && detail}
            </div>
          </>
        ) : (
          <aside className="panel acc-detail" aria-label="Einzelheiten der Anfrage">{detail}</aside>
        )}
      </div>
    )
  }

  return (
    <div className="tab-panel acc">
      <h2 className="sr-only">Zugriffe</h2>
      <p className="sr-only" role="status">{live && streamOpen === false ? 'Live-Verbindung unterbrochen, verbinde neu.' : ''}</p>
      {toolbar}
      {live && streamOpen === false && <p className="acc-offline logs-offline">Live-Verbindung unterbrochen, verbinde neu …</p>}
      {body}
    </div>
  )
}

function AccessDetail({ g, headingId, headingRef, onWay, onPath }: {
  g: AccessGroup; headingId: string; headingRef: RefObject<HTMLHeadingElement | null>
  onWay: (w: TrafficWay) => void; onPath: (p: string) => void
}) {
  const e = g.entries[0]!
  const n = g.entries.length
  const hints = accessHints(e)
  const time = groupTime(g)
  const title = n > 1 ? `${e.method} ${e.path} – ${n} Aufrufe${time.includes('–') ? `, ${time}` : ` um ${time}`}` : `${e.method} ${e.path} um ${time}`
  const place = e.dockerNet ? 'Docker-Netz (Gateway)'
    : e.way === 'public' ? [TRAFFIC_WAY_LABEL.public, [e.city, e.country ? countryName(e.country) : ''].filter(Boolean).join(', ')].filter(Boolean).join(' · ')
    : TRAFFIC_WAY_LABEL[e.way]
  const device = e.browser || e.system ? [e.browser, e.system, TRAFFIC_DEVICE_LABEL[e.device]].filter(Boolean).join(' · ') : '–'
  const guide = hints.find((h) => h.link)?.link
  const kv: [string, ReactNode][] = [
    ['Host', <code key="h">{e.host}</code>],
    ['Absender', <code key="a">{e.ip}</code>],
    ['Zugang', place],
    ...(e.network ? [['Provider', `${e.network.name} · AS${e.network.asn}${e.network.datacenter ? ' · Rechenzentrum' : ''}`] as [string, ReactNode]] : []),
    ['Gerät', device],
    ['Sprache', e.language ? languageName(e.language) : '–'],
    ['Referrer', e.referrer ? <span key="r" className="acc-wrap-any">{e.referrer}</span> : '–'],
    ['Protokoll', [e.proto, e.tls].filter(Boolean).join(' · ') || '–'],
    ['Dauer', fmtDuration(e.durationMs)],
    ...(e.block ? [['Grund der Sperre', BLOCK_REASON[e.block]] as [string, ReactNode]] : []),
  ]
  return (
    <div className="acc-detail-body">
      <StatusPill e={e} reason />
      <h3 id={headingId} ref={headingRef} tabIndex={-1} className="acc-detail-title">{title}</h3>
      <dl className="acc-kv">
        {kv.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
      {hints.map((h) => (
        <div key={h.kind} className={`acc-hint acc-hint-${h.tone}`} role="note">
          <p className="acc-hint-title">
            {h.tone === 'warn' ? 'Prüfen: ' : ''}
            {/* Den Namen der Regel nicht am Bindestrich trennen */}
            {h.title.split(/(ts-docker-nosnat)/).map((part, i) => (part === 'ts-docker-nosnat' ? <span key={i} className="nowrap">{part}</span> : part))}
          </p>
          <p>{h.text}</p>
        </div>
      ))}
      {e.headers.length > 0 && (
        <dl className="acc-headers" aria-label="Ausgewählte Header (gekürzt)">
          {e.headers.map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
      )}
      {n > 1 && (
        <div className="acc-times">
          <h4>Einzelzeiten</h4>
          <ol>
            {g.entries.slice(0, 60).map((x) => <li key={x.id} title={fmtUtc(x.at)}>{fmtTime(x.at, true)}</li>)}
          </ol>
          {n > 60 && <p className="muted">und {n - 60} weitere</p>}
        </div>
      )}
      <div className="acc-actions">
        <button type="button" className="button-small" onClick={() => onWay(e.way)}>Alle von diesem Zugang</button>
        <button type="button" className="button-small" onClick={() => onPath(e.path)}>Nur dieser Pfad</button>
        {guide && <a className="button button-small" href={guide.href} target="_blank" rel="noreferrer">{guide.label} <IconExternal /><span className="sr-only"> (öffnet in neuem Fenster)</span></a>}
      </div>
    </div>
  )
}

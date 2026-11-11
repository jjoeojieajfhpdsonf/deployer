import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LOG_RANGES, type LogRange, type SiteAccessEntryDto } from '@airlock/shared'
import { api, subscribeAccess } from '../api.js'
import { fmtStamp, fmtTime, fmtUtc, nowIso } from '../lib/dates.js'
import { EmptyState, ErrorState, Loading, SkRows } from './States.js'
import { LogToolbar, Highlight, downloadText } from './LogTools.js'

/**
 * Reiter «Zugriffe» einer statischen Seite: Aufrufe aus Caddys Zugriffs-Log
 * (Zeit, Methode, Pfad, Status, Dauer, IP gekürzt). UI-Qualität 4: im
 * gleichen Muster wie «Logs» – Suche mit Hervorhebung, Filter nach
 * Statusklasse, Zeitraum, Live/Pausieren, Herunterladen; Ortszeit, UTC im
 * Tooltip. Statische Seiten haben kein Container-Log.
 */

type Klass = 'alle' | '2' | '3' | '4' | '5'
const KLASS: [Klass, string][] = [['alle', 'Alle'], ['2', '2xx'], ['3', '3xx'], ['4', '4xx'], ['5', '5xx']]
const klassOf = (s: number): Klass => (s >= 500 ? '5' : s >= 400 ? '4' : s >= 300 ? '3' : '2')
/** Wort zur Statusklasse, damit die Farbe nie allein steht */
const KLASS_WORD: Record<Exclude<Klass, 'alle'>, string> = { '2': 'ok', '3': 'umgeleitet', '4': 'Clientfehler', '5': 'Serverfehler' }
const MAX = 2000

function ms(v: number | null): string {
  if (v === null) return '–'
  return v < 1 ? '< 1 ms' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toLocaleString('de-CH', { maximumFractionDigits: 1 })} s`
}

export function SiteAccess({ projectId, slug }: { projectId: string; slug: string }) {
  const [klass, setKlass] = useState<Klass>('alle')
  const [range, setRange] = useState<LogRange>('24h')
  const [search, setSearch] = useState('')
  const [live, setLive] = useState(true)
  const [streamed, setStreamed] = useState<SiteAccessEntryDto[]>([])
  const [pending, setPending] = useState<SiteAccessEntryDto[]>([])
  const liveRef = useRef(live)
  liveRef.current = live

  // Kein Polling mehr: der Stand der Zeitspanne einmal, neue Aufrufe live über den Strom
  const q = useQuery({ queryKey: ['site-access', projectId, range], queryFn: () => api.siteAccess(projectId, range) })
  useEffect(() => {
    setStreamed([])
    setPending([])
    if (!q.data || q.data.error) return
    return subscribeAccess(projectId, (e) => {
      if (liveRef.current) setStreamed((s) => [e, ...s].slice(0, MAX))
      else setPending((p) => [e, ...p].slice(0, MAX))
    })
  }, [projectId, q.data])

  // Neueste zuerst (wie bisher)
  const all = useMemo(() => [...streamed, ...(q.data?.entries ?? [])].slice(0, MAX), [q.data, streamed])
  const needle = search.trim().toLowerCase()
  const matches = (e: SiteAccessEntryDto) => !needle || `${e.method} ${e.path} ${e.status} ${e.ip} ${e.host}`.toLowerCase().includes(needle)
  const searched = all.filter(matches)
  const count = (k: Klass) => (k === 'alle' ? searched.length : searched.filter((e) => klassOf(e.status) === k).length)
  const list = klass === 'alle' ? searched : searched.filter((e) => klassOf(e.status) === klass)
  const rangeLabel = LOG_RANGES.find((r) => r.key === range)!.label

  const download = () => {
    const rows = list.map((e) => [fmtStamp(e.at), e.method, e.host, e.path, e.status, e.durationMs ?? '', e.ip].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    downloadText(`${slug}-zugriffe-${fmtStamp(nowIso()).replace(/[ :]/g, '-')}.csv`, `${['Zeit', 'Methode', 'Host', 'Pfad', 'Status', 'Dauer (ms)', 'IP'].join(',')}\n${rows.join('\n')}\n`, 'text/csv')
  }
  const resume = () => {
    setStreamed((s) => [...pending, ...s].slice(0, MAX))
    setPending([])
    setLive(true)
  }

  return (
    <div className="tab-panel">
      <section className="panel panel-pad ov-section" aria-labelledby="access-h">
        <div className="ov-head">
          <h2 className="ov-title" id="access-h">Zugriffe</h2>
          <span className="muted access-since" role="status">
            {q.data && !q.data.error && <>{list.length.toLocaleString('de-CH')} {list.length === 1 ? 'Aufruf' : 'Aufrufe'} · letzte {rangeLabel} · IP gekürzt</>}
          </span>
        </div>
        <LogToolbar
          search={search}
          onSearch={setSearch}
          searchLabel="Aufrufe durchsuchen"
          filter={
            <div className="segmented" role="group" aria-label="Nach Status filtern">
              {KLASS.map(([k, label]) => (
                <button key={k} type="button" aria-pressed={klass === k} onClick={() => setKlass(k)}>
                  {label} <span className="num">{count(k).toLocaleString('de-CH')}</span>
                </button>
              ))}
            </div>
          }
          range={range}
          onRange={setRange}
          live={live}
          onLive={(on) => (on ? resume() : setLive(false))}
          pending={pending.length}
          onDownload={download}
          canDownload={list.length > 0}
        />
        {!q.data && q.isError ? <ErrorState compact what="Das Zugriffslog" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
          : !q.data ? <Loading label="Zugriffe werden geladen"><SkRows n={6} card={false} /></Loading>
          : q.data.error ? <ErrorState compact what="Das Zugriffslog" error={new Error(q.data.error)} retrying={q.isFetching} onRetry={() => void q.refetch()} />
          : list.length === 0 ? (all.length === 0
            ? <EmptyState compact title={`Noch keine Aufrufe in den letzten ${rangeLabel}`} action={range !== '24h' ? <button type="button" className="button-small" onClick={() => setRange('24h')}>Letzte 24 Std. zeigen</button> : undefined}>Öffne die Seite, dann erscheint der Aufruf hier.</EmptyState>
            : <EmptyState compact title={needle ? `Kein Aufruf enthält «${search.trim()}»` : 'Keine Aufrufe mit diesem Status'} action={<button type="button" className="button-small" onClick={() => { setKlass('alle'); setSearch('') }}>Filter zurücksetzen</button>} />)
          : (
            <div className="table-scroll" role="region" aria-label="Liste der Aufrufe" tabIndex={0}>
              <table className="table access-table">
                <thead><tr><th>Zeit</th><th>Methode</th><th>Pfad</th><th>Status</th><th className="num">Dauer</th><th>IP</th></tr></thead>
                <tbody>
                  {list.map((e, i) => {
                    const k = klassOf(e.status) as Exclude<Klass, 'alle'>
                    return (
                      <tr key={`${e.at}-${i}`}>
                        <td className="num nowrap" title={fmtUtc(e.at)}>{fmtTime(e.at, true)}</td>
                        <td><code className="access-method"><Highlight text={e.method} query={search} /></code></td>
                        <td className="access-path"><code title={e.host}><Highlight text={e.path} query={search} /></code></td>
                        <td><span className={`access-status access-status-${k}`}><span className="num">{e.status}</span> {KLASS_WORD[k]}</span></td>
                        <td className="num nowrap">{ms(e.durationMs)}</td>
                        <td className="num nowrap muted"><Highlight text={e.ip} query={search} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </div>
  )
}

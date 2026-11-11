import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LOG_LINES_MAX, LOG_RANGES, type LogLineDto, type LogRange } from '@airlock/shared'
import { api, subscribeLogs } from '../api.js'
import { fmtStamp, fmtTime, fmtUtc, nowIso } from '../lib/dates.js'
import { EmptyState, ErrorState, Loading, SkLog } from './States.js'
import { LogToolbar, Highlight, atBottom, downloadText } from './LogTools.js'

/**
 * UI-Qualität 4: Reiter «Logs». Zeilen der gewählten Zeitspanne (Server,
 * mit Zeit, Dienst und Stufe), danach live über den Strom. Suche mit
 * Hervorhebung, Filter nach Stufe, Live/Pausieren, Umbruch, Zeilennummern,
 * Herunterladen. Zeit in Ortszeit, UTC im Tooltip. Compose: Dienst wählen,
 * Dienstname als Spalte.
 */

type LevelFilter = 'alle' | 'warn' | 'error'
const LEVELS: [LevelFilter, string][] = [['alle', 'Alle'], ['warn', 'Warnungen und Fehler'], ['error', 'Nur Fehler']]
const LEVEL_WORD = { error: 'ERROR', warn: 'WARN' } as const

const keep = (l: LogLineDto, f: LevelFilter) => f === 'alle' || l.level === 'error' || (f === 'warn' && l.level === 'warn')

/** Ansicht pro Browser merken (Umbruch, Zeilennummern) */
function usePref(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => { try { const s = localStorage.getItem(key); return s === null ? initial : s === '1' } catch { return initial } })
  return [v, (next) => { setV(next); try { localStorage.setItem(key, next ? '1' : '0') } catch { /* egal */ } }]
}

export function LogsTab({ projectId, slug }: { projectId: string; slug: string }) {
  const [range, setRange] = useState<LogRange>('15m')
  const [service, setService] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [level, setLevel] = useState<LevelFilter>('alle')
  const [live, setLive] = useState(true)
  const [wrap, setWrap] = usePref('airlock.logs.wrap', true)
  const [numbers, setNumbers] = usePref('airlock.logs.numbers', false)
  const [streamed, setStreamed] = useState<LogLineDto[]>([])
  const [pending, setPending] = useState<LogLineDto[]>([])
  const [streamOpen, setStreamOpen] = useState<boolean | null>(null)
  const liveRef = useRef(live)
  liveRef.current = live
  const box = useRef<HTMLDivElement>(null)
  const follow = useRef(true)

  const q = useQuery({ queryKey: ['log-lines', projectId, range, service], queryFn: () => api.logLines(projectId, range, service) })

  // Neue Zeilen live; pausiert werden sie gesammelt und beim Fortsetzen angehängt
  useEffect(() => {
    setStreamed([])
    setPending([])
    if (!q.data || q.data.hint) return
    return subscribeLogs(projectId, service, (l) => {
      if (liveRef.current) setStreamed((s) => [...s, l].slice(-LOG_LINES_MAX))
      else setPending((p) => [...p, l].slice(-LOG_LINES_MAX))
    }, setStreamOpen)
  }, [projectId, service, q.data])

  const resume = () => {
    setStreamed((s) => [...s, ...pending].slice(-LOG_LINES_MAX))
    setPending([])
    setLive(true)
    follow.current = true
  }

  const all = useMemo(() => [...(q.data?.lines ?? []), ...streamed].slice(-LOG_LINES_MAX), [q.data, streamed])
  const needle = search.trim().toLowerCase()
  const shown = useMemo(
    () => all.map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => keep(l, level) && (!needle || l.text.toLowerCase().includes(needle) || (l.service ?? '').toLowerCase().includes(needle))),
    [all, level, needle],
  )
  const services = q.data?.services ?? []
  const multi = services.length > 1 && !service

  // Am Ende bleiben, solange live und unten (wer hochscrollt, wird nicht zurückgerissen)
  useLayoutEffect(() => {
    if (live && follow.current && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [shown.length, live])

  const download = () => {
    const text = shown.map(({ l }) => [l.at ? fmtStamp(l.at) : '', l.service ? `[${l.service}]` : '', l.level ? l.level.toUpperCase() : '', l.text].filter(Boolean).join(' ')).join('\n')
    downloadText(`${slug}-logs-${fmtStamp(nowIso()).replace(/[ :]/g, '-')}.log`, `${text}\n`)
  }

  const rangeLabel = LOG_RANGES.find((r) => r.key === range)!.label
  const toolbar = (
    <LogToolbar
      search={search}
      onSearch={setSearch}
      searchLabel="Im Log suchen"
      filter={
        <div className="segmented" role="group" aria-label="Nach Stufe filtern">
          {LEVELS.map(([k, label]) => <button key={k} type="button" aria-pressed={level === k} onClick={() => setLevel(k)}>{label}</button>)}
        </div>
      }
      range={range}
      onRange={setRange}
      live={live}
      onLive={(on) => (on ? resume() : setLive(false))}
      pending={pending.length}
      view={
        <>
          <button type="button" className="button-small" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Zeilenumbruch</button>
          <button type="button" className="button-small" aria-pressed={numbers} onClick={() => setNumbers(!numbers)}>Zeilennummern</button>
        </>
      }
      onDownload={download}
      canDownload={shown.length > 0}
      extra={services.length > 1 ? (
        <label className="logbar-service">
          <span className="sr-only">Dienst</span>
          <select value={service ?? ''} onChange={(e) => setService(e.target.value || null)}>
            <option value="">Alle Dienste</option>
            {services.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      ) : undefined}
    />
  )

  return (
    <div className="tab-panel">
      <section className="panel panel-pad ov-section logs" aria-labelledby="logs-h">
        <div className="ov-head">
          <h2 className="ov-title" id="logs-h">Container-Log</h2>
          <span className="muted logs-meta" role="status">
            {q.data && !q.data.hint && (
              <>{shown.length.toLocaleString('de-CH')} {shown.length === 1 ? 'Zeile' : 'Zeilen'} · letzte {rangeLabel}{live && streamOpen === false ? ' · Live-Verbindung unterbrochen' : ''}</>
            )}
          </span>
        </div>
        {toolbar}
        {!q.data && q.isError ? <ErrorState what="Das Log" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
          : !q.data ? <Loading label="Log wird geladen"><SkLog n={12} /></Loading>
          : q.data.hint ? (
            <EmptyState title="Noch keine Ausgabe">{q.data.hint} Läuft er nicht, starte ihn über «⋯» oben rechts.</EmptyState>
          ) : all.length === 0 ? (
            <EmptyState
              title={`Keine Ausgabe in den letzten ${rangeLabel}`}
              action={range !== '24h' ? <button type="button" className="button-small" onClick={() => setRange('24h')}>Letzte 24 Std. zeigen</button> : undefined}
            >
              Neue Zeilen erscheinen hier live, sobald der Container etwas schreibt.
            </EmptyState>
          ) : shown.length === 0 ? (
            <EmptyState
              title={needle ? `Keine Zeile enthält «${search.trim()}»` : 'Keine Zeilen mit dieser Stufe'}
              action={<button type="button" className="button-small" onClick={() => { setSearch(''); setLevel('alle') }}>Filter zurücksetzen</button>}
            />
          ) : (
            <div
              ref={box}
              className={`logv${wrap ? ' logv-wrap' : ''}${numbers ? ' logv-numbers' : ''}${multi ? ' logv-services' : ''}`}
              role="region"
              aria-label="Zeilen des Container-Logs"
              tabIndex={0}
              onScroll={() => { follow.current = atBottom(box.current) }}
            >
              {shown.map(({ l, n }) => (
                <div key={n} className={`logv-row${l.level === 'error' ? ' logv-error' : l.level === 'warn' ? ' logv-warn' : ''}`}>
                  {numbers && <span className="logv-n" aria-hidden="true">{n}</span>}
                  <span className="logv-time" title={l.at ? fmtUtc(l.at) : undefined}>{l.at ? fmtTime(l.at, true) : ''}</span>
                  {multi && <span className="logv-service">{l.service}</span>}
                  {/* Stufe als Wort, Farbe nur zusätzlich */}
                  {l.level === 'error' || l.level === 'warn' ? <span className={`logv-level logv-level-${l.level}`}>{LEVEL_WORD[l.level]}</span> : <span className="logv-level" />}
                  <span className="logv-text"><Highlight text={l.text} query={search} /></span>
                </div>
              ))}
            </div>
          )}
      </section>
    </div>
  )
}

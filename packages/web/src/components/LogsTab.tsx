import { memo, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LOG_LINES_MAX, LOG_RANGES, type LogLineDto, type LogRange } from '@airlock/shared'
import { api, subscribeLogs } from '../api.js'
import { fmtStamp, fmtTime, fmtUtc, nowIso } from '../lib/dates.js'
import { IconDownload, IconSearch } from './Icons.js'
import { EmptyState, ErrorState, Loading, SkLog } from './States.js'
import { Highlight, downloadText, searchPattern, useLiveFeed } from './LogTools.js'

/**
 * UI-Qualität 4: Reiter «Logs». Zeilen der gewählten Zeitspanne (Server,
 * mit Zeit, Dienst und Stufe), danach live über den Strom – angeschlossen an
 * die letzte Zeile des Stands (nichts doppelt, nichts verloren) und mit
 * Wiederverbinden. Suche mit Hervorhebung, Filter nach Stufe, Live folgen/
 * Pausieren, Umbruch, Zeilennummern, Herunterladen. Ortszeit, UTC im Tooltip.
 * Compose: Dienst wählen, Dienstname als Spalte.
 */

type LevelFilter = 'alle' | 'warn' | 'error'
const LEVELS: [LevelFilter, string][] = [['alle', 'Alle'], ['warn', 'Warnungen und Fehler'], ['error', 'Nur Fehler']]
const LEVEL_WORD = { error: 'ERROR', warn: 'WARN' } as const

/** Zeile mit fester Nummer (bleibt auch, wenn vorne gekürzt wird) */
type Row = { n: number; l: LogLineDto }

const keep = (l: LogLineDto, f: LevelFilter) => f === 'alle' || l.level === 'error' || (f === 'warn' && l.level === 'warn')

/** Ganz unten? (dann folgt die Liste neuen Zeilen) */
const atBottom = (el: HTMLElement | null) => !el || el.scrollHeight - el.scrollTop - el.clientHeight < 24

/**
 * UI-Qualität 4: Werkzeugleiste des Reiters «Logs»: Suche, Filter, Zeitraum,
 * Live folgen/Pausieren, Ansicht, Herunterladen. (Die Einzelaufrufe im
 * Reiter «Besucher» haben seit «Besucher zusammen» ihre eigene Zeile.)
 */
function LogToolbar({
  label, search, onSearch, searchLabel, filter, range, onRange, live, onLive, pending, view, onDownload, canDownload, extra,
}: {
  /** Name der Gruppe für Screenreader, z.B. «Log-Werkzeuge» */
  label: string
  search: string
  onSearch: (v: string) => void
  searchLabel: string
  /** Filter nach Stufe (Segmente) */
  filter: ReactNode
  range: LogRange
  onRange: (r: LogRange) => void
  live: boolean
  onLive: (on: boolean) => void
  /** Neue Zeilen, solange pausiert */
  pending: number
  /** Ansicht (Umbruch, Zeilennummern) */
  view?: ReactNode
  onDownload: () => void
  canDownload: boolean
  /** z. B. Auswahl des Compose-Dienstes */
  extra?: ReactNode
}) {
  const searchId = useId()
  return (
    <div className="logbar" role="group" aria-label={label}>
      <div className="logbar-row">
        <div className="search logbar-search">
          <IconSearch />
          <label htmlFor={searchId} className="sr-only">{searchLabel}</label>
          <input id={searchId} type="search" value={search} placeholder={`${searchLabel} …`} autoComplete="off" spellCheck={false} onChange={(e) => onSearch(e.target.value)} />
        </div>
        {extra}
        {filter}
        <div className="segmented" role="group" aria-label="Zeitraum">
          {LOG_RANGES.map((r) => (
            <button key={r.key} type="button" aria-pressed={range === r.key} onClick={() => onRange(r.key)}>{r.label}</button>
          ))}
        </div>
      </div>
      <div className="logbar-row logbar-row-end">
        {/* Fester Name, Zustand über aria-pressed; «Pausiert · n neu» steht daneben als Text */}
        <button type="button" className="button-small logbar-live" aria-pressed={live} onClick={() => onLive(!live)}>
          <span className={`logbar-dot${live ? ' logbar-dot-on' : ''}`} aria-hidden="true" />
          Live folgen
        </button>
        {!live && <span className="logbar-paused">Pausiert{pending > 0 ? ` · ${pending.toLocaleString('de-CH')} neu` : ''}</span>}
        {view}
        <button type="button" className="button-small" onClick={onDownload} disabled={!canDownload} title="Die angezeigten (gefilterten) Zeilen herunterladen">
          <IconDownload /> Herunterladen
        </button>
      </div>
    </div>
  )
}

/** Ansicht pro Browser merken (Umbruch, Zeilennummern) */
function usePref(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => { try { const s = localStorage.getItem(key); return s === null ? initial : s === '1' } catch { return initial } })
  return [v, (next) => { setV(next); try { localStorage.setItem(key, next ? '1' : '0') } catch { /* egal */ } }]
}

const LogRowView = memo(function LogRowView({ row, numbers, multi, re }: { row: Row; numbers: boolean; multi: boolean; re: RegExp | null }) {
  const { l, n } = row
  return (
    <div className={`logv-row${l.level === 'error' ? ' logv-error' : l.level === 'warn' ? ' logv-warn' : ''}`}>
      {numbers && <span className="logv-n" aria-hidden="true">{n}</span>}
      <span className="logv-time" title={l.at ? fmtUtc(l.at) : undefined}>{l.at ? fmtTime(l.at, true) : ''}</span>
      {multi && <span className="logv-service" title={l.service ?? undefined}>{l.service}</span>}
      {/* Stufe als Wort, Farbe nur zusätzlich */}
      {l.level === 'error' || l.level === 'warn' ? <span className={`logv-level logv-level-${l.level}`}>{LEVEL_WORD[l.level]}</span> : <span className="logv-level" />}
      <span className="logv-text"><Highlight text={l.text} re={re} /></span>
    </div>
  )
})

export function LogsTab({ projectId, slug, activeDeploymentId, service: serviceProp, onService }: {
  projectId: string; slug: string; activeDeploymentId: string | null
  /** Gewählter Dienst aus der Adresse (?dienst=, z. B. «Alle Logs» im Reiter «Aufbau»); mit onService gesteuert */
  service?: string | null
  onService?: (service: string | null) => void
}) {
  const [range, setRange] = useState<LogRange>('15m')
  const [own, setOwn] = useState<string | null>(null)
  const service = onService ? (serviceProp ?? null) : own
  const setService = (s: string | null) => (onService ? onService(s) : setOwn(s))
  const [search, setSearch] = useState('')
  const [level, setLevel] = useState<LevelFilter>('alle')
  const [live, setLive] = useState(true)
  const [wrap, setWrap] = usePref('airlock.logs.wrap', true)
  const [numbers, setNumbers] = usePref('airlock.logs.numbers', false)
  const [rows, setRows] = useState<Row[]>([])
  const [pending, setPending] = useState<Row[]>([])
  const [announce, setAnnounce] = useState('')
  const liveRef = useRef(live)
  liveRef.current = live
  const box = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const seq = useRef(0)
  const lastAt = useRef<string | null>(null)
  const inbox = useRef<Row[]>([])
  const frame = useRef<number | null>(null)

  // Stand der Zeitspanne – ein neuer Container (Deploy) lädt neu; kein Nachladen beim Fokus
  // (das ersetzte die Zeilen und verlöre die gesammelten, solange pausiert)
  const q = useQuery({
    queryKey: ['log-lines', projectId, range, service, activeDeploymentId],
    queryFn: () => api.logLines(projectId, range, service),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  })

  // Neuer Stand: Zeilen nummerieren, Anschlusspunkt merken
  useEffect(() => {
    if (!q.data) return
    seq.current = 0
    const base = q.data.lines.map((l) => ({ n: ++seq.current, l }))
    setRows(base)
    setPending([])
    lastAt.current = [...q.data.lines].reverse().find((l) => l.at)?.at ?? nowIso()
    follow.current = true
  }, [q.data])

  // Neue Zeilen gesammelt einmal pro Bild übernehmen (nicht jede einzeln rendern)
  const flush = () => {
    frame.current = null
    const batch = inbox.current
    inbox.current = []
    if (!batch.length) return
    if (liveRef.current) setRows((r) => [...r, ...batch].slice(-LOG_LINES_MAX))
    else setPending((p) => [...p, ...batch].slice(-LOG_LINES_MAX))
  }
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current) }, [])

  const streamOpen = useLiveFeed(
    (onState) => subscribeLogs(projectId, { service, since: lastAt.current }, (l) => {
      if (l.at) lastAt.current = l.at
      inbox.current.push({ n: ++seq.current, l })
      if (frame.current === null) frame.current = requestAnimationFrame(flush)
    }, onState),
    [projectId, service, q.data],
    Boolean(q.data && !q.data.hint),
  )

  const resume = () => {
    setRows((r) => [...r, ...pending].slice(-LOG_LINES_MAX))
    setPending([])
    setLive(true)
    follow.current = true
  }

  // Suche und Filter ohne Ruckeln beim Tippen (bei 2000 Zeilen)
  const deferredSearch = useDeferredValue(search)
  const needle = deferredSearch.trim().toLowerCase()
  const re = useMemo(() => searchPattern(deferredSearch), [deferredSearch])
  const shown = useMemo(
    () => rows.filter(({ l }) => keep(l, level) && (!needle || l.text.toLowerCase().includes(needle))),
    [rows, level, needle],
  )
  const services = q.data?.services ?? []
  const multi = services.length > 1 && !service
  const lastN = rows.at(-1)?.n ?? 0

  // Am Ende bleiben, solange live und unten (wer hochscrollt, wird nicht zurückgerissen)
  useLayoutEffect(() => {
    if (live && follow.current && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [lastN, shown.length, live])

  // Ergebnis von Suche und Filter ansagen – nicht jede neue Live-Zeile
  useEffect(() => {
    if (!needle && level === 'alle') { setAnnounce(''); return }
    setAnnounce(`${shown.length.toLocaleString('de-CH')} ${shown.length === 1 ? 'Zeile' : 'Zeilen'} gefunden`)
  }, [needle, level]) // eslint-disable-line react-hooks/exhaustive-deps

  const download = () => {
    const text = shown.map(({ l }) => [l.at ? fmtStamp(l.at) : '', l.service ? `[${l.service}]` : '', l.level ? l.level.toUpperCase() : '', l.text].filter(Boolean).join(' ')).join('\n')
    downloadText(`${slug}-logs-${fmtStamp(nowIso()).replace(/[ :]/g, '-')}.log`, `${text}\n`)
  }

  const r = LOG_RANGES.find((x) => x.key === range)!
  const unknownService = Boolean(service && q.data && !q.data.hint && !services.includes(service))

  return (
    <div className="tab-panel">
      <section className="panel panel-pad ov-section logs" aria-labelledby="logs-h">
        <div className="ov-head">
          <h2 className="ov-title" id="logs-h">Container-Log</h2>
          <span className="muted logs-meta">
            {q.data && !q.data.hint && rows.length > 0 && <>{shown.length.toLocaleString('de-CH')} {shown.length === 1 ? 'Zeile' : 'Zeilen'} {r.from}</>}
            {live && streamOpen === false && <> · <span className="logs-offline">Live-Verbindung unterbrochen, verbinde neu</span></>}
          </span>
        </div>
        <p className="sr-only" role="status">{announce}{live && streamOpen === false ? ' Live-Verbindung unterbrochen.' : ''}</p>
        <LogToolbar
          label="Log-Werkzeuge"
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
        {!q.data && q.isError ? <ErrorState what="Das Log" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
          : !q.data ? <Loading label="Log wird geladen"><SkLog n={12} /></Loading>
          : unknownService ? (
            <EmptyState title={`Den Dienst «${service}» gibt es nicht mehr`} action={<button type="button" className="button-small" onClick={() => setService(null)}>Alle Dienste zeigen</button>}>
              Nach einem Deploy kann sich die Liste der Dienste ändern.
            </EmptyState>
          ) : q.data.hint ? (
            <EmptyState title="Kein laufender Container">Es gibt noch keine Ausgabe. Läuft das Projekt nicht, starte es über «⋯» oben rechts.</EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState
              title={`Keine Ausgabe ${r.within}`}
              action={range !== '24h' ? <button type="button" className="button-small" onClick={() => setRange('24h')}>Letzte 24 Stunden zeigen</button> : undefined}
            >
              Neue Zeilen erscheinen hier live, sobald der Container etwas schreibt.
            </EmptyState>
          ) : shown.length === 0 ? (
            <EmptyState
              title={needle ? `Keine Zeile enthält «${deferredSearch.trim()}»` : 'Keine Zeilen mit dieser Stufe'}
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
              {shown.map((row) => <LogRowView key={row.n} row={row} numbers={numbers} multi={multi} re={re} />)}
            </div>
          )}
      </section>
    </div>
  )
}

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { LOG_RANGES, type LogRange } from '@airlock/shared'
import { IconDownload, IconSearch } from './Icons.js'

/**
 * UI-Qualität 4: Werkzeugleiste der Reiter «Logs» und «Zugriffe» – gleiches
 * Muster für beide: Suche, Filter, Zeitraum, Live folgen/Pausieren, Ansicht,
 * Herunterladen.
 */
export function LogToolbar({
  label, search, onSearch, searchLabel, filter, range, onRange, live, onLive, pending, view, onDownload, canDownload, extra,
}: {
  /** Name der Gruppe für Screenreader, z.B. «Log-Werkzeuge» */
  label: string
  search: string
  onSearch: (v: string) => void
  searchLabel: string
  /** Filter nach Stufe bzw. Status (Segmente) */
  filter: ReactNode
  range: LogRange
  onRange: (r: LogRange) => void
  live: boolean
  onLive: (on: boolean) => void
  /** Neue Zeilen, solange pausiert */
  pending: number
  /** Ansicht (Umbruch, Zeilennummern) – nur im Reiter «Logs» */
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

/** Suchmuster einmal bauen (nicht je Zeile); Eingabe wird als Text behandelt, nicht als RegExp */
export const searchPattern = (query: string): RegExp | null => {
  const q = query.trim()
  return q ? new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig') : null
}

/** Fundstellen hervorheben (Gross-/Kleinschreibung egal) */
export function Highlight({ text, re }: { text: string; re: RegExp | null }) {
  if (!re) return <>{text}</>
  const parts = text.split(re)
  return <>{parts.map((p, i) => (i % 2 === 1 ? <mark key={i} className="log-hit">{p}</mark> : p))}</>
}

/** Text als Datei speichern (im Browser, ohne Server) */
export function downloadText(name: string, text: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** CSV-Zelle; Werte, die eine Tabellenkalkulation als Formel läse (= + - @), werden entschärft */
export const csvCell = (v: unknown): string => {
  const s = String(v ?? '')
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

/** Ganz unten? (dann folgt die Liste neuen Zeilen) */
export const atBottom = (el: HTMLElement | null) => !el || el.scrollHeight - el.scrollTop - el.clientHeight < 24

/**
 * Live-Strom mit Wiederverbinden: bricht er ab (Netz, Neustart, neuer
 * Container), wird mit wachsender Pause neu verbunden – `open` bekommt dann
 * den aktuellen Anschlusspunkt. Gibt zurück, ob der Strom gerade offen ist
 * (null = noch nicht bekannt).
 */
export function useLiveFeed(open: (onState: (ok: boolean) => void) => () => void, deps: unknown[], enabled: boolean): boolean | null {
  const [state, setState] = useState<boolean | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    setState(null)
    if (!enabled) return
    let stop: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let tries = 0
    let dead = false
    const start = () => {
      stop = openRef.current((ok) => {
        if (dead) return
        setState(ok)
        if (ok) { tries = 0; return }
        stop?.()
        tries++
        timer = setTimeout(start, Math.min(30_000, 2_000 * 2 ** Math.min(tries, 4)))
      })
    }
    start()
    return () => { dead = true; if (timer) clearTimeout(timer); stop?.() }
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}

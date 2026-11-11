import { useId, type ReactNode } from 'react'
import { LOG_RANGES, type LogRange } from '@airlock/shared'
import { IconDownload, IconSearch } from './Icons.js'

/**
 * UI-Qualität 4: Werkzeugleiste der Reiter «Logs» und «Zugriffe» – gleiches
 * Muster für beide: Suche, Filter, Zeitraum, Live/Pausieren, Ansicht,
 * Herunterladen.
 */
export function LogToolbar({
  search, onSearch, searchLabel, filter, range, onRange, live, onLive, pending, view, onDownload, canDownload, extra,
}: {
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
    <div className="logbar" role="toolbar" aria-label={`Werkzeuge: ${searchLabel}`}>
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
        <button type="button" className="button-small logbar-live" aria-pressed={live} onClick={() => onLive(!live)}>
          {/* Zustand in Worten, nicht nur der Punkt */}
          <span className={`logbar-dot${live ? ' logbar-dot-on' : ''}`} aria-hidden="true" />
          {live ? 'Live' : pending > 0 ? `Pausiert · ${pending.toLocaleString('de-CH')} neu` : 'Pausiert'}
        </button>
        {view}
        <button type="button" className="button-small" onClick={onDownload} disabled={!canDownload}>
          <IconDownload /> Herunterladen
        </button>
      </div>
    </div>
  )
}

/** Fundstellen hervorheben (Gross-/Kleinschreibung egal) */
export function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim()
  if (!q) return <>{text}</>
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'))
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

/** Ganz unten? (dann folgt die Liste neuen Zeilen) */
export const atBottom = (el: HTMLElement | null) => !el || el.scrollHeight - el.scrollTop - el.clientHeight < 24

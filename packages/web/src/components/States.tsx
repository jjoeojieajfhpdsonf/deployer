import type { ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { ApiError } from '../api.js'
import { IconWarn } from './Icons.js'
import { isUnreachable } from '../lib/connection.js'

/**
 * Die fünf Zustände jeder Ansicht an einem Ort:
 *   Laden     – Skeletons in der Form des Inhalts (kein «wird geladen…»-Text)
 *   Leer      – <EmptyState> mit nächstem Schritt
 *   Fehler    – <ErrorState> mit Grund und «Erneut versuchen»
 *   Teilweise – <PartialNote> neben dem, was da ist
 *   Veraltet  – <StaleBar> in der Shell (lib/connection.ts): letzte Daten bleiben stehen
 *
 * <QueryView> verbindet das mit einer Abfrage: Daten gehen immer vor – auch
 * wenn ein späteres Nachladen scheitert (dann ist der Zustand «veraltet»,
 * nicht «Fehler»).
 */

/* --- Laden ------------------------------------------------------------------ */

type SkProps = { w?: number | string; h?: number | string; r?: 'xs' | 'sm' | 'pill' | 'round'; className?: string }

/** Ein Skeleton-Block. Breite in px oder %. */
export function Sk({ w = '100%', h = 12, r = 'xs', className }: SkProps) {
  return <span className={`sk sk-r-${r}${className ? ` ${className}` : ''}`} style={{ width: w, height: h }} aria-hidden="true" />
}

/** Rahmen für Skeletons: für Screenreader «Wird geladen», sichtbar nur die Formen. */
export function Loading({ label = 'Wird geladen', children, className }: { label?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`sk-wrap${className ? ` ${className}` : ''}`} role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

/** Textzeilen unterschiedlicher Länge */
export function SkLines({ n = 3, widths }: { n?: number; widths?: (number | string)[] }) {
  const w = widths ?? ['92%', '78%', '64%', '84%', '55%']
  return <div className="sk-lines">{Array.from({ length: n }, (_, i) => <Sk key={i} w={w[i % w.length]} />)}</div>
}

/** Kennzahlen-Reihe wie oben auf «Projekte» */
export function SkStats({ n = 4 }: { n?: number }) {
  return (
    <div className="stats">
      {Array.from({ length: n }, (_, i) => (
        <div className="stat" key={i}>
          <Sk w="45%" h={13} />
          <Sk w={i % 2 ? 72 : 96} h={40} r="sm" className="sk-gap-lg" />
          <Sk w="60%" h={11} className="sk-gap" />
        </div>
      ))}
    </div>
  )
}

/** Projektkarten im Raster */
export function SkProjectCards({ n = 6 }: { n?: number }) {
  return (
    <ul className="pcards" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <li className="pcard" key={i}>
          <div className="sk-row"><Sk w={32} h={32} r="sm" /><div className="sk-col"><Sk w={['55%', '40%', '62%'][i % 3]} h={15} /><Sk w="70%" h={11} /></div></div>
          <Sk w={88} h={22} r="sm" />
          <div className="sk-lines"><Sk w="80%" /><Sk w="66%" /><Sk w="74%" /></div>
          <div className="sk-row sk-row-end"><Sk w={92} h={32} r="sm" /><Sk w={32} h={32} r="sm" /></div>
        </li>
      ))}
    </ul>
  )
}

/** Eine Karte mit Titel und Zeilen (Übersichtskarten, Einstellungen) */
export function SkCard({ lines = 4, title = true, className }: { lines?: number; title?: boolean; className?: string }) {
  return (
    <div className={`sk-card${className ? ` ${className}` : ''}`}>
      {title && <Sk w="34%" h={18} className="sk-title" />}
      <SkLines n={lines} />
    </div>
  )
}

/** Zeilen einer Liste oder Tabelle: Punkt, Text, Zeit */
export function SkRows({ n = 6, card = true }: { n?: number; card?: boolean }) {
  const rows = (
    <div className="sk-rows">
      {Array.from({ length: n }, (_, i) => (
        <div className="sk-row" key={i}>
          <Sk w={10} h={10} r="round" />
          <div className="sk-col sk-grow"><Sk w={['58%', '44%', '66%', '50%'][i % 4]} h={13} /><Sk w={['32%', '40%', '24%'][i % 3]} h={10} /></div>
          <Sk w={56} h={11} />
        </div>
      ))}
    </div>
  )
  return card ? <div className="sk-card">{rows}</div> : rows
}

/** Log-Ausgabe */
export function SkLog({ n = 8 }: { n?: number }) {
  return (
    <div className="sk-log" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => <Sk key={i} w={`${[86, 72, 94, 60, 80, 68, 90, 54][i % 8]}%`} h={10} />)}
    </div>
  )
}

/** Seitentitel mit Unterzeile */
export function SkHead() {
  return (
    <div className="sk-head" aria-hidden="true">
      <Sk w={260} h={36} r="sm" />
      <Sk w={360} h={13} />
    </div>
  )
}

/** Projektseite: Kopf, Reiter, Karten */
export function SkProjectDetail() {
  return (
    <>
      <SkHead />
      <div className="sk-tabs" aria-hidden="true">{[96, 120, 64, 84, 110].map((w, i) => <Sk key={i} w={w} h={14} />)}</div>
      <div className="sk-grid-2">
        <SkCard lines={5} />
        <SkCard lines={5} />
        <SkCard lines={3} />
        <SkCard lines={3} />
      </div>
    </>
  )
}

/* --- Leer ------------------------------------------------------------------- */

/** Leerer Zustand: was fehlt, und der nächste Schritt (Knopf oder Link). */
export function EmptyState({ title, children, action, compact }: { title: string; children?: ReactNode; action?: ReactNode; compact?: boolean }) {
  if (compact) {
    return (
      <div className="empty-inline">
        <p><strong>{title}</strong>{children ? <> {children}</> : null}</p>
        {action}
      </div>
    )
  }
  return (
    <div className="state state-empty">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

/* --- Fehler ----------------------------------------------------------------- */

export { isUnreachable }

/** Verständlicher Grund in einem Satz. */
export function errorReason(e: unknown): string {
  if (isUnreachable(e)) return 'Der Airlock-Server antwortet gerade nicht.'
  if (e instanceof ApiError) {
    if (e.status === 401) return 'Die Anmeldung ist abgelaufen. Lade die Seite neu und melde dich an.'
    if (e.status === 403) return 'Dafür fehlt die Berechtigung.'
    if (e.status === 404) return 'Das gibt es nicht (mehr).'
    return e.message
  }
  if (e instanceof Error && e.message) return e.message
  return 'Unbekannter Fehler.'
}

/**
 * Fehler beim Laden: «<was> konnte nicht geladen werden.» + Grund + «Erneut
 * versuchen». `compact` für Karten und Abschnitte innerhalb einer Seite.
 */
export function ErrorState({ what, error, onRetry, compact, retrying, plural }: {
  what: string; error: unknown; onRetry?: () => void; compact?: boolean; retrying?: boolean
  /** «Die Deployments konnten …» statt «… konnte …» */
  plural?: boolean
}) {
  return (
    // Seitenfehler als Alarm; Fehler in Karten nur als Status (mehrere Karten = sonst mehrere Alarme)
    <div className={compact ? 'error-state error-state-compact' : 'error-state'} role={compact ? 'status' : 'alert'}>
      <span className="error-state-icon" aria-hidden="true"><IconWarn size={16} /></span>
      <div className="error-state-body">
        <p className="error-state-title">{what} {plural ? 'konnten' : 'konnte'} nicht geladen werden.</p>
        <p className="error-state-reason">{errorReason(error)}</p>
      </div>
      {onRetry && (
        <button type="button" className={compact ? 'button-small' : undefined} onClick={() => { if (!retrying) onRetry() }} aria-disabled={retrying || undefined}>
          Erneut versuchen
        </button>
      )}
    </div>
  )
}

/* --- Teilweise -------------------------------------------------------------- */

/** Ein Teil fehlt, der Rest ist da: kurzer Hinweis an der Stelle des fehlenden Teils. */
export function PartialNote({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <p className="partial-note" role="status">
      <IconWarn size={14} />
      <span>{children}</span>
      {onRetry && <button type="button" className="link-button" onClick={onRetry}>Erneut versuchen</button>}
    </p>
  )
}

/* --- Abfrage → Zustand ------------------------------------------------------ */

/**
 * Zeigt Daten, sobald es welche gibt; sonst Fehler oder Skeleton. Leer
 * entscheidet die Ansicht selbst (sie kennt den nächsten Schritt).
 */
export function QueryView<T>({ q, what, skeleton, compact, children }: {
  q: Pick<UseQueryResult<T>, 'data' | 'isError' | 'error' | 'refetch' | 'isFetching'>
  what: string
  skeleton: ReactNode
  compact?: boolean
  children: (data: T) => ReactNode
}) {
  if (q.data !== undefined) return <>{children(q.data)}</>
  if (q.isError) return <ErrorState what={what} error={q.error} compact={compact} retrying={q.isFetching} onRetry={() => void q.refetch()} />
  return <Loading>{skeleton}</Loading>
}

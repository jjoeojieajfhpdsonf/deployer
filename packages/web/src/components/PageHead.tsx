import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { PRODUCT_NAME } from '@airlock/shared'

/**
 * Brotkrumen leben in der globalen Kopfzeile (links, rechts das
 * Profil-Menü). Jede Seite meldet ihre Krumen über PageHead an.
 */
type Crumb = { label: string; to?: string }
type Ctx = { crumbs: Crumb[]; set: (c: Crumb[]) => void; page: string | null; setPage: (t: string | null) => void; setPageSoon: () => void }
const CrumbsContext = createContext<Ctx>({ crumbs: [], set: () => {}, page: null, setPage: () => {}, setPageSoon: () => {} })

export function CrumbsProvider({ children }: { children: ReactNode }) {
  const [crumbs, set] = useState<Crumb[]>([])
  // UI-Qualität 3: Name der Seite für document.title («Wetterstation · Airlock»)
  const [page, setPageState] = useState<string | null>(null)
  // Jede Anmeldung zählt hoch; das verzögerte Löschen greift nur, wenn sich seither keine Seite gemeldet hat
  const gen = useRef(0)
  const setPage = useCallback((t: string | null) => { gen.current++; setPageState(t) }, [])
  const setPageSoon = useCallback(() => {
    const at = gen.current
    setTimeout(() => { if (gen.current === at) setPageState(null) }, 800)
  }, [])
  return <CrumbsContext.Provider value={{ crumbs, set, page, setPage, setPageSoon }}>{children}</CrumbsContext.Provider>
}

/** Name der aktuellen Seite (aus PageHead), für den Titel des Tabs */
export const usePageName = () => useContext(CrumbsContext).page

/**
 * UI-Qualität 6: Brotkrumen erst ab der zweiten Ebene («Airlock › Projekte ›
 * Wetterstation»), mit echten Namen und klickbaren Vorgängern. Auf den
 * Hauptseiten (Projekte, Security, Audit, System) steht nichts – dort sagt die
 * Seitenleiste, wo man ist. Die Kopfzeile behält ihren Platz.
 */
export function Crumbs() {
  const { crumbs } = useContext(CrumbsContext)
  if (crumbs.length < 2) return <div className="crumbs" aria-hidden="true" />
  return (
    <nav className="crumbs" aria-label="Pfad">
      <ol>
        <li><Link to="/projekte">{PRODUCT_NAME}</Link></li>
        {crumbs.map((c, i) => (
          <li key={i}>
            <span className="crumbs-sep" aria-hidden="true">›</span>
            {c.to && i < crumbs.length - 1 ? <Link to={c.to}>{c.label}</Link> : <span aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{c.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  )
}

/** Titel und Aktionen einer Seite; meldet die Brotkrumen an. */
export function PageHead({
  crumbs,
  title,
  name,
  actions,
  children,
}: {
  crumbs: Crumb[]
  title: ReactNode
  /** Name für den Tab-Titel, wenn title kein Text ist (z. B. Projektname mit Pille) */
  name?: string
  actions?: ReactNode
  children?: ReactNode
}) {
  const { set, setPage, setPageSoon } = useContext(CrumbsContext)
  const key = JSON.stringify(crumbs)
  useEffect(() => {
    set(crumbs)
    return () => set([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const page = name ?? (typeof title === 'string' ? title : null)
  useEffect(() => {
    setPage(page)
    // Beim Seitenwechsel bleibt der alte Name kurz stehen (kein Aufblitzen von «Airlock»);
    // meldet sich keine neue Seite an (Seite ohne Kopf), fällt er danach weg
    return () => setPageSoon()
  }, [page, setPage, setPageSoon])
  return (
    <header className="page-head">
      <div>
        <div className="title-line">{typeof title === 'string' ? <h1>{title}</h1> : title}</div>
        {children}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  )
}

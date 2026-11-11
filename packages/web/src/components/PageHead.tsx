import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useServerName } from './ServerName.js'

/**
 * Brotkrumen leben in der globalen Kopfzeile (links, rechts das
 * Profil-Menü). Jede Seite meldet ihre Krumen über PageHead an.
 */
type Crumb = { label: string; to?: string }
const CrumbsContext = createContext<{ crumbs: Crumb[]; set: (c: Crumb[]) => void; page: string | null; setPage: (t: string | null) => void }>({
  crumbs: [], set: () => {}, page: null, setPage: () => {},
})

export function CrumbsProvider({ children }: { children: ReactNode }) {
  const [crumbs, set] = useState<Crumb[]>([])
  // UI-Qualität 3: Name der Seite für document.title («Wetterstation · Airlock»)
  const [page, setPage] = useState<string | null>(null)
  return <CrumbsContext.Provider value={{ crumbs, set, page, setPage }}>{children}</CrumbsContext.Provider>
}

/** Name der aktuellen Seite (aus PageHead), für den Titel des Tabs */
export const usePageName = () => useContext(CrumbsContext).page

export function Crumbs() {
  const { crumbs } = useContext(CrumbsContext)
  const server = useServerName()
  return (
    <nav className="crumbs" aria-label="Pfad">
      <Link to="/projekte">{server}</Link>
      {crumbs.map((c, i) => (
        <span key={i}>
          <span className="crumbs-sep" aria-hidden="true"> / </span>
          {c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{c.label}</span>}
        </span>
      ))}
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
  const { set, setPage } = useContext(CrumbsContext)
  const key = JSON.stringify(crumbs)
  useEffect(() => {
    set(crumbs)
    return () => set([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const page = name ?? (typeof title === 'string' ? title : null)
  useEffect(() => {
    setPage(page)
    return () => setPage(null)
  }, [page, setPage])
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

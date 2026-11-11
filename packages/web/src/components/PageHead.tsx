import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useServerName } from './ServerName.js'
import { useEnv } from '../lib/env.js'

/**
 * Brotkrumen leben in der globalen Kopfzeile (links, rechts das
 * Profil-Menü). Jede Seite meldet ihre Krumen über PageHead an.
 */
type Crumb = { label: string; to?: string }
const CrumbsContext = createContext<{ crumbs: Crumb[]; set: (c: Crumb[]) => void }>({ crumbs: [], set: () => {} })

export function CrumbsProvider({ children }: { children: ReactNode }) {
  const [crumbs, set] = useState<Crumb[]>([])
  return <CrumbsContext.Provider value={{ crumbs, set }}>{children}</CrumbsContext.Provider>
}

export function Crumbs() {
  const { crumbs } = useContext(CrumbsContext)
  const server = useServerName()
  // M9: Auf Seiten einer Umgebung beginnt der Pfad mit ihr (der Umschalter zeigt nur das Kürzel)
  const { env, fromUrl } = useEnv()
  return (
    <nav className="crumbs" aria-label="Pfad">
      {fromUrl && env
        ? <Link to={`/u/${env.slug}/projekte`} aria-label={`Umgebung ${env.name}`}>{env.name.toLocaleLowerCase('de-CH')}</Link>
        : <Link to="/server">{server}</Link>}
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
  actions,
  children,
}: {
  crumbs: Crumb[]
  title: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  const { set } = useContext(CrumbsContext)
  const key = JSON.stringify(crumbs)
  useEffect(() => {
    set(crumbs)
    return () => set([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
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

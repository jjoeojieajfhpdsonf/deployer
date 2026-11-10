import { useEffect, useState, type ReactNode } from 'react'
import { applyTheme, readLocalTheme } from './lib/theme.js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, Route, Routes, Navigate, Link, useLocation } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { Loading, Sk, SkHead, SkStats } from './components/States.js'
import { StaleBar } from './components/StaleBar.js'
import { ActivityIndicator } from './components/ActivityIndicator.js'
import { api } from './api.js'
import { Login } from './pages/Login.js'
import { Projects } from './pages/Projects.js'
import { NewProject } from './pages/NewProject.js'
import { ProjectDetail } from './pages/ProjectDetail.js'
import { Audit } from './pages/Audit.js'
import { System } from './pages/System.js'
import { Tokens } from './pages/Tokens.js'
import { ExternalTargets } from './pages/ExternalTargets.js'
import { SecurityOverview } from './pages/SecurityOverview.js'
import { Domains } from './pages/Domains.js'
import { useSystem } from './components/ServerName.js'
import { useProjects } from './lib/projects.js'
import { Account } from './pages/Account.js'
import { ProfileMenu } from './components/ProfileMenu.js'
import { CrumbsProvider, Crumbs } from './components/PageHead.js'
import { IconProjects, IconShield, IconGlobe, IconTarget, IconKey, IconList, IconServer } from './components/Icons.js'

export function App() {
  const qc = useQueryClient()
  const location = useLocation()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false })

  // Darstellung: die Wahl vom Server gewinnt über die lokale Kopie (anderes Gerät, neuer Browser)
  const serverTheme = me.data?.theme
  useEffect(() => {
    if (serverTheme && serverTheme !== readLocalTheme()) applyTheme(serverTheme)
  }, [serverTheme])

  if (me.isLoading) {
    // Skeleton der Shell: Seitenleiste und Inhalt in ihrer Form, kein «Einen Moment…»
    return (
      <Loading label="Airlock wird geladen" className="shell">
        <aside className="rail sk-rail" aria-hidden="true">
          <Sk w={120} h={20} />
          <div className="sk-lines">{[70, 64, 58, 76, 52, 60, 66].map((w, i) => <Sk key={i} w={`${w}%`} h={14} />)}</div>
        </aside>
        <main className="main"><div className="page"><SkHead /><SkStats /></div></main>
      </Loading>
    )
  }

  // "API nicht erreichbar" ist ein eigener Zustand, nicht derselbe wie
  // "nicht angemeldet". Mit Daten von vorher bleibt die Oberfläche stehen
  // (Zustand «Veraltet», Leiste in der Shell).
  if (me.isError && !me.data) {
    return (
      <main className="state state-offline" role="alert">
        <h1>Keine Verbindung zur API</h1>
        <p>Der Airlock-Dienst antwortet nicht. Läuft der Container noch?</p>
        <button onClick={() => void me.refetch()}>Erneut versuchen</button>
      </main>
    )
  }

  if (!me.data?.loggedIn) {
    return <Login onDone={() => void qc.invalidateQueries({ queryKey: ['me'] })} />
  }

  return (
    <CrumbsProvider>
    <div className="shell">
      <Rail />
      <main className="main">
        <div className="topbar">
          <Crumbs />
          <div className="topbar-actions">
            <ActivityIndicator />
            <ProfileMenu me={me.data} />
          </div>
        </div>
        <StaleBar />
        {/* Pro Seite: ein Fehler legt nur diese Seite still; Seitenwechsel versucht es neu */}
        <ErrorBoundary scope="page" resetKey={location.pathname}>
        <Routes>
          <Route path="/" element={<Navigate to="/projekte" replace />} />
          <Route path="/projekte" element={<Projects />} />
          <Route path="/projekte/neu" element={<NewProject />} />
          <Route path="/projekte/:id" element={<ProjectDetail />} />
          <Route path="/security" element={<SecurityOverview />} />
          <Route path="/domains" element={<Domains />} />
          <Route path="/extern" element={<ExternalTargets />} />
          <Route path="/system" element={<System section="uebersicht" />} />
          <Route path="/system/cloudflare" element={<System section="cloudflare" />} />
          <Route path="/system/veroeffentlichung" element={<System section="veroeffentlichung" />} />
          <Route path="/system/benachrichtigungen" element={<System section="benachrichtigungen" />} />
          <Route path="/system/github" element={<System section="github" />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/tokens" element={<Tokens />} />
          <Route path="/konto" element={<Account />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        </ErrorBoundary>
      </main>
    </div>
    </CrumbsProvider>
  )
}

const RAIL_KEY = 'airlock.rail.collapsed'
/** Schlüssel vor der Umbenennung; wird beim Lesen einmalig übernommen. */
const OLD_RAIL_KEY = 'deployer.rail.collapsed'
const readCollapsed = () => {
  try { return (localStorage.getItem(RAIL_KEY) ?? localStorage.getItem(OLD_RAIL_KEY)) === '1' } catch { return false }
}

function Rail() {
  const projects = useProjects()
  const system = useSystem()
  const list = projects.data?.projects ?? []
  // Zähler «Security»: offene kritische und hohe Befunde über alle Projekte
  const critical = list.reduce((n, p) => n + (p.security?.open.critical ?? 0), 0)
  const urgent = list.reduce((n, p) => n + (p.security ? p.security.open.critical + p.security.open.high : 0), 0)
  // Klick aufs Icon klappt die Seitenleiste ein und aus; gemerkt pro Browser.
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const toggle = () => {
    setCollapsed((c) => {
      try { localStorage.setItem(RAIL_KEY, c ? '0' : '1') } catch { /* privat: nur für diese Sitzung */ }
      return !c
    })
  }

  const items: { to: string; label: string; icon: ReactNode; count?: ReactNode }[] = [
    { to: '/projekte', label: 'Projekte', icon: <IconProjects />, count: projects.data ? <span className="rail-count">{list.length}</span> : null },
    {
      to: '/security', label: 'Security', icon: <IconShield />,
      count: urgent > 0 ? <span className={`rail-count ${critical ? 'rail-count-bad' : 'rail-count-warn'}`} aria-label={`${urgent} offene kritische oder hohe Befunde`}>{urgent}</span> : null,
    },
    { to: '/domains', label: 'Domains', icon: <IconGlobe /> },
    { to: '/extern', label: 'Externe Ziele', icon: <IconTarget /> },
    { to: '/tokens', label: 'Tokens', icon: <IconKey /> },
    { to: '/audit', label: 'Audit', icon: <IconList /> },
    { to: '/system', label: 'System', icon: <IconServer /> },
  ]

  return (
    <aside className={collapsed ? 'rail rail-collapsed' : 'rail'}>
      <div className="brand">
        <button
          type="button"
          className="brand-mark"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-controls="rail-nav"
          aria-label={collapsed ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen'}
          title={collapsed ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen'}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
        </button>
        <Link to="/projekte" className="brand-name">Airlock</Link>
      </div>
      <nav className="rail-nav" id="rail-nav" aria-label="Hauptnavigation">
        {items.map((it) => (
          <NavLink key={it.to} to={it.to} title={collapsed ? it.label : undefined} aria-label={collapsed ? it.label : undefined}>
            <span className="rail-item">{it.icon}<span className="rail-label">{it.label}</span></span>
            {it.count}
          </NavLink>
        ))}
      </nav>
      <div className="rail-foot">
        <span>Server {system.data ? <strong>{system.data.server.name}</strong> : <Sk w={64} h={11} className="sk-inline" />}</span>
        <span>Version {system.data ? <strong className="num">{system.data.version}</strong> : <Sk w={40} h={11} className="sk-inline" />}</span>
      </div>
    </aside>
  )
}

function NotFound() {
  return (
    <div className="page">
      <div className="state state-empty">
        <h2>Diese Seite gibt es nicht</h2>
        <p>Vielleicht wurde das Projekt gelöscht oder die Adresse ist veraltet.</p>
        <Link className="button" to="/projekte">Zu den Projekten</Link>
      </div>
    </div>
  )
}

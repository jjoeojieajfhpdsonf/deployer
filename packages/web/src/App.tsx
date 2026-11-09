import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, Route, Routes, Navigate, Link } from 'react-router-dom'
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
import { DemoToggle } from './components/DemoToggle.js'
import { ProfileMenu } from './components/ProfileMenu.js'
import { isPrototype } from './prototype/flag.js'
import { ProtoBar } from './prototype/ProtoBar.js'
import { CrumbsProvider, Crumbs } from './components/PageHead.js'
import { IconProjects, IconShield, IconGlobe, IconTarget, IconKey, IconList, IconServer } from './components/Icons.js'

export function App() {
  const qc = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false })

  if (me.isLoading) {
    return <main className="state state-loading" aria-busy="true">Einen Moment…</main>
  }

  // "API nicht erreichbar" ist ein eigener Zustand, nicht derselbe wie
  // "nicht angemeldet".
  if (me.isError) {
    return (
      <main className="state state-offline" role="alert">
        <h1>Keine Verbindung zur API</h1>
        <p>Der deployer-Dienst antwortet nicht. Läuft der Container noch?</p>
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
          {isPrototype() ? (
            <div className="topbar-end"><ProtoBar /><ProfileMenu me={me.data} /></div>
          ) : (
            <ProfileMenu me={me.data} />
          )}
        </div>
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
          <Route path="/system/benachrichtigungen" element={<System section="benachrichtigungen" />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/tokens" element={<Tokens />} />
          <Route path="/konto" element={<Account />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <DemoToggle />
    </div>
    </CrumbsProvider>
  )
}

const RAIL_KEY = 'deployer.rail.collapsed'
const readCollapsed = () => {
  try { return localStorage.getItem(RAIL_KEY) === '1' } catch { return false }
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
        <Link to="/projekte" className="brand-name">deployer</Link>
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
        <span>Server <span className="mono">{system.data?.server.name ?? '…'}</span></span>
        <span>Version <span className="mono">{system.data?.version ?? '…'}</span></span>
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

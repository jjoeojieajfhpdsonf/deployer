import { useEffect, useState, type ReactNode } from 'react'
import { applyTheme, readLocalTheme } from './lib/theme.js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, Route, Routes, Navigate, Link, useLocation, useParams } from 'react-router-dom'
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
import { EnvironmentSettings } from './pages/EnvironmentSettings.js'
import { Environments } from './pages/Environments.js'
import { NewEnvironment, EnvironmentSetup } from './pages/NewEnvironment.js'
import { useSystem } from './components/ServerName.js'
import { useProjects } from './lib/projects.js'
import { EnvProvider, useEnv, useEnvPath } from './lib/env.js'
import { Account } from './pages/Account.js'
import { ProfileMenu } from './components/ProfileMenu.js'
import { EnvSwitcher } from './components/EnvSwitcher.js'
import { CrumbsProvider, Crumbs } from './components/PageHead.js'
import { IconProjects, IconShield, IconGlobe, IconTarget, IconKey, IconList, IconServer, IconSliders } from './components/Icons.js'

export function App() {
  const qc = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false })

  // Darstellung: die Wahl vom Server gewinnt über die lokale Kopie (anderes Gerät, neuer Browser)
  const serverTheme = me.data?.theme
  useEffect(() => {
    if (serverTheme && serverTheme !== readLocalTheme()) applyTheme(serverTheme)
  }, [serverTheme])

  if (me.isLoading) {
    return <main className="state state-loading" aria-busy="true">Einen Moment…</main>
  }

  // "API nicht erreichbar" ist ein eigener Zustand, nicht derselbe wie
  // "nicht angemeldet".
  if (me.isError) {
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
    <EnvProvider lastEnvironment={me.data.lastEnvironment}>
      <CrumbsProvider>
        <div className="shell">
          <Rail />
          <main className="main">
            <div className="topbar">
              <Crumbs />
              <ProfileMenu me={me.data} />
            </div>
            <Routes>
              {/* M9: alles unter einer Umgebung */}
              <Route path="/u/:env/*" element={<EnvRoutes />} />
              {/* Für alle Umgebungen */}
              <Route path="/server" element={<System section="uebersicht" />} />
              <Route path="/server/benachrichtigungen" element={<System section="benachrichtigungen" />} />
              <Route path="/server/github" element={<System section="github" />} />
              <Route path="/umgebungen" element={<Environments />} />
              <Route path="/umgebungen/neu" element={<NewEnvironment />} />
              <Route path="/konto" element={<Account />} />
              {/* Alte Adressen ohne Umgebung: in die zuletzt gewählte, sonst die Standard-Umgebung */}
              <Route path="/" element={<ToEnv path="/projekte" />} />
              <Route path="/projekte/*" element={<ToEnv keepPath />} />
              <Route path="/security" element={<ToEnv keepPath />} />
              <Route path="/domains" element={<ToEnv keepPath />} />
              <Route path="/extern" element={<ToEnv keepPath />} />
              <Route path="/tokens" element={<ToEnv keepPath />} />
              <Route path="/audit" element={<ToEnv keepPath />} />
              <Route path="/system" element={<Navigate to="/server" replace />} />
              <Route path="/system/cloudflare" element={<ToEnv path="/einstellungen/cloudflare" />} />
              <Route path="/system/veroeffentlichung" element={<ToEnv path="/einstellungen/standards" />} />
              <Route path="/system/benachrichtigungen" element={<Navigate to="/server/benachrichtigungen" replace />} />
              <Route path="/system/github" element={<Navigate to="/server/github" replace />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </main>
        </div>
      </CrumbsProvider>
    </EnvProvider>
  )
}

/** Seiten einer Umgebung; eine unbekannte Umgebung in der Adresse ergibt «gibt es nicht». */
function EnvRoutes() {
  const { env, unknown, loading } = useEnv()
  const { env: slug } = useParams()
  if (loading && !env) return <p className="state state-loading" aria-busy="true">Einen Moment…</p>
  if (unknown || !env) return <UnknownEnvironment slug={slug ?? ''} />
  return (
    <Routes>
      <Route path="" element={<Navigate to="projekte" replace />} />
      <Route path="projekte" element={<Projects />} />
      <Route path="projekte/neu" element={<NewProject />} />
      <Route path="projekte/:id" element={<ProjectDetail />} />
      <Route path="security" element={<SecurityOverview />} />
      <Route path="domains" element={<Domains />} />
      <Route path="extern" element={<ExternalTargets />} />
      <Route path="tokens" element={<Tokens />} />
      <Route path="audit" element={<Audit />} />
      <Route path="einstellungen" element={<EnvironmentSettings section="allgemein" />} />
      <Route path="einstellungen/cloudflare" element={<EnvironmentSettings section="cloudflare" />} />
      <Route path="einstellungen/standards" element={<EnvironmentSettings section="standards" />} />
      <Route path="einrichtung" element={<EnvironmentSetup />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

/** Weiterleitung in die gültige Umgebung (alte Adressen, Startseite). */
function ToEnv({ path, keepPath }: { path?: string; keepPath?: boolean }) {
  const { slug, loading } = useEnv()
  const location = useLocation()
  if (loading || !slug) return <p className="state state-loading" aria-busy="true">Einen Moment…</p>
  const target = keepPath ? `${location.pathname}${location.search}${location.hash}` : path ?? '/projekte'
  return <Navigate to={`/u/${slug}${target}`} replace />
}

function UnknownEnvironment({ slug }: { slug: string }) {
  return (
    <div className="page">
      <div className="state state-empty">
        <h2>Diese Umgebung gibt es nicht</h2>
        <p>«{slug}» ist keine Umgebung von Airlock – vielleicht wurde sie gelöscht oder umbenannt.</p>
        <Link className="button" to="/umgebungen">Umgebungen ansehen</Link>
      </div>
    </div>
  )
}

const RAIL_KEY = 'airlock.rail.collapsed'
/** Schlüssel vor der Umbenennung; wird beim Lesen einmalig übernommen. */
const OLD_RAIL_KEY = 'deployer.rail.collapsed'
const readCollapsed = () => {
  try { return (localStorage.getItem(RAIL_KEY) ?? localStorage.getItem(OLD_RAIL_KEY)) === '1' } catch { return false }
}

function Rail() {
  const { env } = useEnv()
  const ep = useEnvPath()
  const projects = useProjects()
  const system = useSystem()
  const list = projects.data?.projects ?? []
  // Zähler «Security»: offene kritische und hohe Befunde über alle Projekte der Umgebung
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

  // M9: Alles in dieser Liste gilt nur für die gewählte Umgebung
  const items: { to: string; label: string; icon: ReactNode; count?: ReactNode }[] = env ? [
    { to: ep('/projekte'), label: 'Projekte', icon: <IconProjects />, count: projects.data ? <span className="rail-count">{list.length}</span> : null },
    {
      to: ep('/security'), label: 'Security', icon: <IconShield />,
      count: urgent > 0 ? <span className={`rail-count ${critical ? 'rail-count-bad' : 'rail-count-warn'}`} aria-label={`${urgent} offene kritische oder hohe Befunde`}>{urgent}</span> : null,
    },
    { to: ep('/domains'), label: 'Domains', icon: <IconGlobe /> },
    { to: ep('/extern'), label: 'Externe Ziele', icon: <IconTarget /> },
    { to: ep('/tokens'), label: 'Tokens', icon: <IconKey /> },
    { to: ep('/audit'), label: 'Audit', icon: <IconList /> },
    { to: ep('/einstellungen'), label: 'Einstellungen', icon: <IconSliders /> },
  ] : []

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
        <Link to={env ? ep('/projekte') : '/'} className="brand-name">Airlock</Link>
        <span className="env-sep" aria-hidden="true">/</span>
        <EnvSwitcher />
      </div>
      <nav className="rail-nav" id="rail-nav" aria-label={env ? `Umgebung ${env.name}` : 'Hauptnavigation'}>
        {items.map((it) => (
          <NavLink key={it.to} to={it.to} end={it.to.endsWith('/einstellungen') ? false : undefined} title={collapsed ? it.label : undefined} aria-label={collapsed ? it.label : undefined}>
            <span className="rail-item">{it.icon}<span className="rail-label">{it.label}</span></span>
            {it.count}
          </NavLink>
        ))}
      </nav>
      <nav className="rail-nav rail-nav-server" aria-labelledby="rail-server-label">
        <div className="rail-divider" id="rail-server-label">
          <span>Server</span>
          <span className="rail-divider-note">für alle Umgebungen</span>
        </div>
        <NavLink to="/server" title={collapsed ? 'Server' : undefined} aria-label={collapsed ? 'Server, für alle Umgebungen' : undefined}>
          <span className="rail-item"><IconServer /><span className="rail-label">Server</span></span>
        </NavLink>
      </nav>
      <div className="rail-foot">
        <span>Server <strong>{system.data?.server.name ?? '…'}</strong></span>
        <span>Version <strong className="num">{system.data?.version ?? '…'}</strong></span>
      </div>
    </aside>
  )
}

function NotFound() {
  const ep = useEnvPath()
  return (
    <div className="page">
      <div className="state state-empty">
        <h2>Diese Seite gibt es nicht</h2>
        <p>Vielleicht wurde das Projekt gelöscht oder die Adresse ist veraltet.</p>
        <Link className="button" to={ep('/projekte')}>Zu den Projekten</Link>
      </div>
    </div>
  )
}

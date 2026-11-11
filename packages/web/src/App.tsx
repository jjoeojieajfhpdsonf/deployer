import { useEffect, useRef, useState, type ReactNode } from 'react'
import { markSessionExpired, markSessionOk, useLoggedOut } from './lib/session.js'
import { SessionDialog } from './components/SessionDialog.js'
import { LeaveGuard } from './components/LeaveGuard.js'
import { Bell } from './components/Bell.js'
import { applyTheme, readLocalTheme } from './lib/theme.js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, Route, Routes, Navigate, Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { openUrgent, sumCounts } from '@airlock/shared'
import { Loading, Sk, SkHead, SkStats } from './components/States.js'
import { StaleBar } from './components/StaleBar.js'
import { ActivityIndicator } from './components/ActivityIndicator.js'
import { Shortcuts } from './components/Shortcuts.js'
import { api, type MeDto } from './api.js'
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
import { Design } from './pages/Design.js'
import { Setup } from './pages/Setup.js'
import { useSetup } from './lib/setup.js'
import { ProfileMenu } from './components/ProfileMenu.js'
import { CrumbsProvider, Crumbs } from './components/PageHead.js'
import { ShellLive } from './components/DocumentTitle.js'
import { IconProjects, IconShield, IconList, IconServer } from './components/Icons.js'

export function App() {
  const qc = useQueryClient()
  const location = useLocation()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false })
  // UI-Qualität 8: Wer schon in der Oberfläche war, bekommt bei Sitzungsende einen Dialog über der
  // Seite statt der Anmeldeseite (die Seite und Eingaben bleiben)
  const hadShell = useRef(false)
  // Profil der letzten gültigen Sitzung: bleibt im Kopf stehen, solange der Dialog offen ist
  const lastMe = useRef<MeDto | null>(null)
  const loggedOut = useLoggedOut()
  if (me.data?.loggedIn) { hadShell.current = true; lastMe.current = me.data }
  useEffect(() => {
    if (me.data && !me.data.loggedIn && hadShell.current) markSessionExpired()
  }, [me.data])

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
      <main className="state state-offline">
        {/* Alarm auf dem Inhalt, nicht auf <main> (sonst geht der Landmark verloren) */}
        <div role="alert">
          <h1>Keine Verbindung zur API</h1>
          <p>Der Airlock-Dienst antwortet nicht. Läuft der Container noch?</p>
        </div>
        <button onClick={() => void me.refetch()}>Erneut versuchen</button>
      </main>
    )
  }

  // Anmeldeseite: beim ersten Öffnen ohne Sitzung und nach bewusstem Abmelden; sonst Dialog über der Seite
  if (!me.data?.loggedIn && (!hadShell.current || loggedOut)) {
    return <Login onDone={() => { markSessionOk(); void qc.invalidateQueries({ queryKey: ['me'] }) }} />
  }

  return (
    <CrumbsProvider>
    <div className="shell">
      <Rail />
      <main className="main">
        <div className="topbar">
          <Crumbs />
          <div className="topbar-actions">
            <ErrorBoundary scope="part"><ActivityIndicator /></ErrorBoundary>
            <ErrorBoundary scope="part"><Bell me={me.data?.loggedIn ? me.data : lastMe.current!} /></ErrorBoundary>
            <ProfileMenu me={me.data?.loggedIn ? me.data : lastMe.current!} />
          </div>
        </div>
        <StaleBar />
        {/* Sitzung abgelaufen: Anmeldung über der Seite (UI-Qualität 8) */}
        <SessionDialog />
        {/* Ungespeicherte Änderungen: Rückfrage vor dem Verlassen (UI-Qualität 8) */}
        <LeaveGuard />
        {/* Tab-Titel, Favicon-Punkt und Ereignisstrom (UI-Qualität 3) */}
        <ErrorBoundary scope="part"><ShellLive /></ErrorBoundary>
        <ErrorBoundary scope="part"><SetupRedirect /></ErrorBoundary>
        {/* ⌘K, «/», «g p/s/a», «?» */}
        <ErrorBoundary scope="part"><Shortcuts /></ErrorBoundary>
        {/* Pro Seite: ein Fehler legt nur diese Seite still; Seitenwechsel versucht es neu */}
        <ErrorBoundary scope="page" resetKey={location.pathname}>
        <Routes>
          <Route path="/" element={<Navigate to="/projekte" replace />} />
          <Route path="/projekte" element={<Projects />} />
          <Route path="/projekte/neu" element={<NewProject />} />
          <Route path="/projekte/:id" element={<ProjectDetailRoute />} />
          <Route path="/security" element={<SecurityOverview section="projekte" />} />
          <Route path="/security/extern" element={<SecurityOverview section="extern" />} />
          {/* UI-Qualität 6: alte Adressen leiten weiter (Lesezeichen, Links in Meldungen) */}
          <Route path="/domains" element={<Navigate to="/system/cloudflare#domains" replace />} />
          <Route path="/extern" element={<Navigate to="/security/extern" replace />} />
          <Route path="/system" element={<System section="uebersicht" />} />
          <Route path="/system/cloudflare" element={<System section="cloudflare" />} />
          <Route path="/system/veroeffentlichung" element={<System section="veroeffentlichung" />} />
          <Route path="/system/benachrichtigungen" element={<System section="benachrichtigungen" />} />
          <Route path="/system/github" element={<System section="github" />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/tokens" element={<Tokens />} />
          <Route path="/konto" element={<Account />} />
          {/* Interne Komponenten-Übersicht (nur angemeldet, nicht in der Navigation) */}
          <Route path="/design" element={<Design />} />
          <Route path="/einrichtung" element={<Setup />} />
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
  const all = sumCounts(list.map((p) => p.security?.open))
  const critical = all.critical
  const urgent = openUrgent(all)
  // Klick aufs Icon klappt die Seitenleiste ein und aus; gemerkt pro Browser.
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const toggle = () => {
    setCollapsed((c) => {
      try { localStorage.setItem(RAIL_KEY, c ? '0' : '1') } catch { /* privat: nur für diese Sitzung */ }
      return !c
    })
  }

  // Zahl sichtbar (aria-hidden), Bedeutung als Text: auch im eingeklappten Zustand Teil des Namens
  const urgentText = urgent > 0
    ? `${urgent} ${urgent === 1 ? 'offener kritischer oder hoher Befund' : 'offene kritische oder hohe Befunde'}${critical && urgent > 1 ? `, davon ${critical} kritisch` : ''}`
    : undefined
  const items: { to: string; label: string; icon: ReactNode; count?: ReactNode; countText?: string }[] = [
    { to: '/projekte', label: 'Projekte', icon: <IconProjects />, count: projects.data ? <span className="rail-count" aria-hidden="true">{list.length}</span> : null, countText: projects.data ? `${list.length} ${list.length === 1 ? 'Projekt' : 'Projekte'}` : undefined },
    {
      to: '/security', label: 'Security', icon: <IconShield />,
      // Zahl = offene kritische + hohe Befunde; bei 0 keine Zahl. Tooltip und Name sagen, was sie zählt
      // Kritisch dabei: gefüllt; nur hohe: rot getönt (Farbregel, UI-Qualität 7)
      count: urgent > 0 ? <span className={`rail-count ${critical ? 'rail-count-critical' : 'rail-count-bad'}`} aria-hidden="true" title={urgentText}>{urgent}</span> : null,
      countText: urgentText,
    },
    // UI-Qualität 6: vier Bereiche. Domains → System › Cloudflare & HTTPS, Externe Ziele → Reiter unter Security
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
          <NavLink key={it.to} to={it.to} title={collapsed ? it.label : undefined} aria-label={collapsed ? (it.countText ? `${it.label}, ${it.countText}` : it.label) : undefined}>
            <span className="rail-item">{it.icon}<span className="rail-label">{it.label}</span></span>
            {it.count}
            {it.countText && !collapsed && <span className="sr-only">, {it.countText}</span>}
          </NavLink>
        ))}
      </nav>
      {/* Unten fixiert: «Server <Name> · Version <x>» */}
      <div className="rail-foot">
        {/* Zwei Zeilen mit Absicht: «Server … · Version …» passt bei 192 px nicht in eine Zeile,
            und ein Punkt am Zeilenende hinge in der Luft */}
        <span>Server {system.data ? <strong>{system.data.server.name}</strong> : <Sk w={64} h={11} className="sk-inline" />}</span>
        <span className="nowrap">Version {system.data ? <strong className="num">{system.data.version}</strong> : <Sk w={40} h={11} className="sk-inline" />}</span>
      </div>
    </aside>
  )
}

const SETUP_SHOWN = 'airlock.setup.shown'
/** Merker für diesen Seitenaufruf – auch ohne sessionStorage höchstens einmal */
let setupShownThisLoad = false

/**
 * Erster Start: Fehlt noch etwas und ist der Assistent nicht mit «Später»
 * ausgeblendet, öffnet er sich einmal pro Sitzung von selbst – nur von der
 * Startseite aus, nie über einen direkten Link hinweg.
 */
function SetupRedirect() {
  const s = useSetup()
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    if (!s.ready || s.dismissed || s.open === 0) return
    if (location.pathname !== '/' && location.pathname !== '/projekte') return
    if (setupShownThisLoad) return
    setupShownThisLoad = true
    try {
      if (sessionStorage.getItem(SETUP_SHOWN)) return
      sessionStorage.setItem(SETUP_SHOWN, '1')
    } catch { /* ohne Speicher: der Merker oben sorgt für «einmal pro Aufruf» */ }
    navigate('/einrichtung', { replace: true })
  }, [s.ready, s.dismissed, s.open, location.pathname, navigate])
  return null
}

/**
 * Eine Projektseite pro Projekt (key): Aktionen und «Rückgängig» behalten
 * ihr Projekt, auch wenn inzwischen ein anderes offen ist.
 */
function ProjectDetailRoute() {
  const { id = '' } = useParams()
  return <ProjectDetail key={id} />
}

function NotFound() {
  return (
    <div className="page">
      <div className="state state-empty">
        <h2 aria-level={1}>Diese Seite gibt es nicht</h2>
        <p>Vielleicht wurde das Projekt gelöscht oder die Adresse ist veraltet.</p>
        <Link className="button" to="/projekte">Zu den Projekten</Link>
      </div>
    </div>
  )
}

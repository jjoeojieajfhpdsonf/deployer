import { useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, Route, Routes, Navigate } from 'react-router-dom'
import { api } from './api.js'
import { Login } from './pages/Login.js'
import { Projects } from './pages/Projects.js'
import { NewProject } from './pages/NewProject.js'
import { ProjectDetail } from './pages/ProjectDetail.js'
import { Audit } from './pages/Audit.js'
import { System } from './pages/System.js'
import { Tokens } from './pages/Tokens.js'
import { ExternalTargets } from './pages/ExternalTargets.js'

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
    <div className="app">
      <header className="app-header">
        <span className="brand">deployer</span>
        <nav className="app-nav">
          <NavLink to="/projekte">Projekte</NavLink>
          <NavLink to="/extern">Externe Ziele</NavLink>
          <NavLink to="/system">System</NavLink>
          <NavLink to="/tokens">Tokens</NavLink>
          <NavLink to="/audit">Audit</NavLink>
        </nav>
        <button
          className="link-button"
          onClick={async () => {
            await api.logout()
            await qc.invalidateQueries({ queryKey: ['me'] })
          }}
        >
          Abmelden
        </button>
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/projekte" replace />} />
          <Route path="/projekte" element={<Projects />} />
          <Route path="/projekte/neu" element={<NewProject />} />
          <Route path="/projekte/:id" element={<ProjectDetail />} />
          <Route path="/extern" element={<ExternalTargets />} />
          <Route path="/system" element={<System />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/tokens" element={<Tokens />} />
          <Route path="*" element={<p className="state">Diese Seite gibt es nicht.</p>} />
        </Routes>
      </main>
    </div>
  )
}

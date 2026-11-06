import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { StatusBadge, relativeTime } from '../components/Status.js'

export function Projects() {
  const qc = useQueryClient()
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.listProjects, refetchInterval: 5_000 })

  const act = useMutation({
    mutationFn: async ({ id, what }: { id: string; what: 'deploy' | 'stop' | 'start' }) => {
      if (what === 'deploy') return api.deploy(id)
      if (what === 'stop') return api.stop(id)
      return api.start(id)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  })

  if (projects.isLoading) return <p className="state state-loading">Projekte werden geladen…</p>
  if (projects.isError) return <p className="state state-error" role="alert">Projekte konnten nicht geladen werden.</p>

  const list = projects.data?.projects ?? []

  return (
    <section className="page page-projects">
      <header className="page-header">
        <h1>Projekte</h1>
        <Link className="button button-primary" to="/projekte/neu">Neues Projekt</Link>
      </header>

      {list.length === 0 ? (
        <div className="state state-empty">
          <h2>Noch kein Projekt</h2>
          <p>
            Deploye ein fertiges Image aus einer Registry oder lade eine statische
            Seite als ZIP hoch. Beides ist in unter zwei Minuten erreichbar.
          </p>
          <Link className="button button-primary" to="/projekte/neu">Erstes Projekt anlegen</Link>
        </div>
      ) : (
        <ul className="project-list">
          {list.map((p) => {
            const url = p.routes[0]?.urls[0]
            return (
              <li key={p.id} className="project-row">
                <div className="project-main">
                  <Link to={`/projekte/${p.id}`} className="project-name">{p.name}</Link>
                  <StatusBadge status={p.status} />
                </div>

                <div className="project-meta">
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer" className="project-url">{url}</a>
                  ) : (
                    <span className="muted">keine Adresse</span>
                  )}
                  <span className="muted">{p.sourceType === 'image' ? 'Image' : 'statisch'}</span>
                  <span className="muted">{relativeTime(p.activeDeployment?.startedAt ?? null)}</span>
                </div>

                <div className="project-actions">
                  <button
                    onClick={() => act.mutate({ id: p.id, what: 'deploy' })}
                    disabled={act.isPending || p.status === 'deploying'}
                  >
                    Neu deployen
                  </button>
                  {p.desiredState === 'running' ? (
                    <button onClick={() => act.mutate({ id: p.id, what: 'stop' })} disabled={act.isPending}>
                      Stoppen
                    </button>
                  ) : (
                    <button onClick={() => act.mutate({ id: p.id, what: 'start' })} disabled={act.isPending}>
                      Starten
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {act.isError && (
        <p role="alert" className="error">{(act.error as Error).message}</p>
      )}
    </section>
  )
}

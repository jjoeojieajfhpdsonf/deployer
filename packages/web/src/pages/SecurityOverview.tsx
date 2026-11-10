import { useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { ProjectDto } from '@airlock/shared'
import { api, ApiError } from '../api.js'
import { PageHead } from '../components/PageHead.js'
import { useProjects } from '../lib/projects.js'
import { relativeTime } from '../lib/format.js'

/**
 * Security über alle Projekte: Note, offene Befunde nach Schwere, letzter
 * Scan. Sortiert nach Dringlichkeit – oben, was zuerst angeschaut werden soll.
 */
export function SecurityOverview() {
  const qc = useQueryClient()
  const projects = useProjects()
  const list = projects.data?.projects ?? []
  const rank = (p: ProjectDto) => {
    const o = p.security?.open
    if (!p.security || p.security.grade === null) return 1e9
    return -((o?.critical ?? 0) * 1e6 + (o?.high ?? 0) * 1e4 + (o?.medium ?? 0) * 100 + (o?.low ?? 0)) + (p.security.score ?? 0) / 1000
  }
  const sorted = useMemo(() => [...list].sort((a, b) => rank(a) - rank(b)), [list])
  const sum = (k: 'critical' | 'high' | 'medium' | 'low') => list.reduce((n, p) => n + (p.security?.open[k] ?? 0), 0)
  const scanned = list.filter((p) => p.security?.grade).length

  const scan = useMutation({
    mutationFn: (id: string) => api.startScan(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['projects'] }),
  })

  return (
    <section className="page">
      <PageHead crumbs={[{ label: 'security' }]} title="Security">
        <p className="lede">Nach jedem Deploy prüfen Trivy, ein Header-Check, OWASP ZAP und Nuclei das Projekt. Öffentlich schalten geht nur ohne offenen kritischen Befund.</p>
      </PageHead>

      <div className="stats">
        <div className="stat">
          <div className="label">Kritisch</div>
          <div className={`stat-value${sum('critical') ? ' tone-bad' : ''}`}>{sum('critical')}</div>
          <div className="stat-sub">verhindern «öffentlich»</div>
        </div>
        <div className="stat">
          <div className="label">Hoch</div>
          <div className={`stat-value${sum('high') ? ' tone-warn' : ''}`}>{sum('high')}</div>
          <div className="stat-sub">zeitnah beheben</div>
        </div>
        <div className="stat">
          <div className="label">Mittel · Niedrig</div>
          <div className="stat-value">{sum('medium')} <small>· {sum('low')}</small></div>
          <div className="stat-sub">bei Gelegenheit</div>
        </div>
        <div className="stat">
          <div className="label">Gescannt</div>
          <div className="stat-value">{scanned} <small>/ {list.length}</small></div>
          <div className="stat-sub">Rescan wöchentlich</div>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h2>Projekte nach Dringlichkeit</h2>
          <Link to="/extern" className="muted">Externe Ziele</Link>
        </div>
        {projects.isLoading ? (
          <p className="state state-loading">Wird geladen…</p>
        ) : list.length === 0 ? (
          <div className="state state-empty"><p>Noch kein Projekt – also auch nichts zu prüfen.</p></div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr><th>Projekt</th><th>Note</th><th>Offen</th><th>Letzter Scan</th><th><span className="visually-hidden">Aktion</span></th></tr>
              </thead>
              <tbody>
                {sorted.map((p) => {
                  const s = p.security
                  const running = s?.status === 'running' || s?.status === 'queued'
                  return (
                    <tr key={p.id}>
                      <td className="cell-main"><Link to={`/projekte/${p.id}?tab=security`}>{p.name}</Link></td>
                      <td>
                        {s?.grade
                          ? <div className="grade-cell"><span className={`grade grade-${s.grade}`}>{s.grade}</span>{s.score} / 100</div>
                          : <div className="grade-cell"><span className="grade grade-none" aria-hidden="true">–</span>{running ? 'scannt' : 'kein Scan'}</div>}
                      </td>
                      <td>
                        {s ? (
                          <div className="counts">
                            {(['critical', 'high', 'medium', 'low'] as const).map((k) => (
                              <span key={k} className={`count ${s.open[k] ? `count-${k}` : 'count-zero'}`}>
                                {s.open[k]} {{ critical: 'kritisch', high: 'hoch', medium: 'mittel', low: 'niedrig' }[k]}
                              </span>
                            ))}
                          </div>
                        ) : <span className="muted">–</span>}
                      </td>
                      <td>{running ? 'läuft gerade' : relativeTime(s?.finishedAt)}</td>
                      <td className="row-actions">
                        <button className="button-small" disabled={running || scan.isPending || p.status !== 'running'} onClick={() => scan.mutate(p.id)}>Scannen</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {scan.isError && <p role="alert" className="error">{scan.error instanceof ApiError ? scan.error.message : 'Scan nicht gestartet'}</p>}
      </div>
    </section>
  )
}

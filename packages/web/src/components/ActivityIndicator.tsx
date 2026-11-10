import { useEffect, useId, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { useActivities, type RunningActivity } from '../lib/activities.js'
import { useProjects } from '../lib/projects.js'
import { notifyError, notifyOk } from '../lib/feedback.js'
import { relativeTime } from '../lib/format.js'
import { useMenu } from './useMenu.js'

/**
 * Kleine Aktivitätsanzeige im Kopf: Zahl laufender Vorgänge (Deploy, Scan,
 * Zertifikat, Tunnel); Klick öffnet die Liste mit Fortschritt und Link.
 * Ohne laufenden Vorgang verschwindet sie. Endet ein Vorgang, solange die
 * Oberfläche offen ist, meldet ein Toast das Ergebnis.
 */
export function ActivityIndicator() {
  const list = useActivities()
  const id = useId()
  const { open, toggle, close, rootRef, triggerRef, listProps } = useMenu()
  useFinishedToasts(list)
  const n = list.length
  if (n === 0 && !open) return null
  return (
    <div className="menu activity-indicator" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="activity-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={n === 1 ? '1 laufender Vorgang' : `${n} laufende Vorgänge`}
        onClick={toggle}
      >
        <span className="activity-spinner" aria-hidden="true" />
        <span className="num">{n}</span>
        <span className="activity-trigger-label">{n === 1 ? 'Vorgang' : 'Vorgänge'}</span>
      </button>
      <div {...listProps} role="menu" id={id} aria-label="Laufende Vorgänge">
        <div className="menu-group-label" aria-hidden="true">Läuft gerade</div>
        {n === 0 ? (
          <p className="activity-empty">Alles erledigt.</p>
        ) : (
          list.map((a) => <ActivityRow key={a.key} a={a} onPick={close} />)
        )}
      </div>
    </div>
  )
}

function ActivityRow({ a, onPick }: { a: RunningActivity; onPick: () => void }) {
  // Scan: Fortschritt aus den Stufen des laufenden Scans (nur geladen, solange die Liste offen ist)
  const scan = useQuery({
    queryKey: ['scan', a.projectId, 'live'],
    queryFn: () => api.latestScan(a.projectId!),
    enabled: a.kind === 'scan' && Boolean(a.projectId),
    refetchInterval: 4_000,
  })
  let { detail, progress } = a
  const stages = scan.data?.report?.scan.stages
  if (a.kind === 'scan' && stages && scan.data?.report?.scan.status === 'running') {
    const all = Object.values(stages)
    const done = all.filter((v) => v.state === 'done' || v.state === 'skipped' || v.state === 'failed' || v.state === 'timeout' || (v.state === undefined && (v.ran || v.failed))).length
    detail = `Stufe ${Math.min(done + 1, all.length)} von ${all.length}`
    progress = all.length ? done / all.length : null
  }
  return (
    <Link role="menuitem" to={a.to} onClick={onPick} className="activity-row">
      <span className="activity-row-title">{a.title}</span>
      <span className="activity-row-detail">
        {detail}
        {a.startedAt ? <span className="muted"> · seit {relativeTime(a.startedAt).replace(/^vor /, '')}</span> : null}
      </span>
      {progress !== null ? (
        <span className="activity-bar" aria-hidden="true"><span style={{ width: `${Math.round(progress * 100)}%` }} /></span>
      ) : (
        <span className="activity-bar activity-bar-open" aria-hidden="true"><span /></span>
      )}
    </Link>
  )
}

/** Vorgang verschwunden → Ergebnis als Toast (nur Übergänge, die diese Sitzung gesehen hat). */
function useFinishedToasts(list: RunningActivity[]) {
  const prev = useRef<Map<string, RunningActivity> | null>(null)
  const projects = useProjects()
  const navigate = useNavigate()
  useEffect(() => {
    const now = new Map(list.map((a) => [a.key, a]))
    const before = prev.current
    prev.current = now
    if (!before) return
    for (const [key, a] of before) {
      if (now.has(key)) continue
      const p = projects.data?.projects.find((x) => x.id === a.projectId)
      if (a.kind === 'deploy' && p) {
        const d = p.lastDeployment
        if (d?.status === 'failed') {
          notifyError(`Deploy gescheitert · ${p.name}`, new Error(d.errorMessage ?? 'Der neue Stand ist nicht live gegangen.'), {
            id: key, action: { label: 'Log ansehen', onClick: () => navigate(`/projekte/${p.id}?tab=deployments`) },
          })
        } else if (d?.status === 'active') {
          notifyOk(`Deploy fertig · ${p.name}`, { id: key, description: 'Der neue Stand ist live.', action: { label: 'Öffnen', onClick: () => navigate(`/projekte/${p.id}`) } })
        }
      } else if (a.kind === 'scan' && p?.security) {
        const s = p.security
        if (s.status === 'failed') notifyError(`Scan gescheitert · ${p.name}`, new Error('Der Scan ist abgebrochen.'), { id: key, action: { label: 'Ansehen', onClick: () => navigate(`/projekte/${p.id}?tab=security`) } })
        else if (s.status === 'done') {
          const open = s.open.critical + s.open.high + s.open.medium + s.open.low
          notifyOk(`Scan fertig · ${p.name}`, {
            id: key,
            description: `${s.grade ? `Note ${s.grade} · ` : ''}${open === 0 ? 'keine offenen Befunde' : open === 1 ? '1 offener Befund' : `${open} offene Befunde`}`,
            action: { label: 'Ansehen', onClick: () => navigate(`/projekte/${p.id}?tab=security`) },
          })
        }
      }
    }
  }, [list, projects.data, navigate])
}

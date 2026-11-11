import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DeploymentDto } from '@airlock/shared'
import { deployReasonTitle } from '@airlock/shared'
import { api, ApiError } from '../api.js'
import { relativeTime, shortVersion, deployDuration } from '../lib/format.js'
import { deployState, groupDeployments, groupSummary, type DeployItem } from '../lib/deployments.js'
import { Actor } from './Actor.js'

/**
 * Deployments als Liste (Übersicht: Karte mit fünf Einträgen; Reiter: alle,
 * mit Log). Jede Zeile: warum (Titel), Stand, Auslöser, wann, wie lange.
 * Die aktive Version steht abgesetzt oben. Zurückrollen nur dort, wo es den
 * Code-Stand ändert.
 */

const svg = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
const IconCheck = () => <svg {...svg}><path d="m3.8 8.4 2.8 2.8 5.6-6" /></svg>
const IconX = () => <svg {...svg}><path d="m4.8 4.8 6.4 6.4M11.2 4.8l-6.4 6.4" /></svg>
const IconUp = () => <svg {...svg}><path d="M8 13V3.5M4.2 7.2 8 3.4l3.8 3.8" /></svg>
const IconRedo = () => <svg {...svg}><path d="M12.6 8.6A4.7 4.7 0 1 1 11 4.4" /><path d="M12.4 2.4v2.9H9.5" /></svg>
const IconUndo = () => <svg {...svg}><path d="M3.4 8.6A4.7 4.7 0 1 0 5 4.4" /><path d="M3.6 2.4v2.9h2.9" /></svg>
const IconWait = () => <svg {...svg}><circle cx="8" cy="8" r="5" strokeDasharray="2.4 2.2" /></svg>
const IconChevron = () => <svg {...svg} width={14} height={14}><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>

const STATUS_WORD: Record<string, string> = {
  pending: 'wartet', pulling: 'holt Quelle', starting: 'startet', healthchecking: 'Healthcheck',
  superseded: 'abgelöst', rolled_back: 'zurückgerollt',
}

function markFor(d: DeploymentDto) {
  const s = deployState(d)
  if (s === 'active') return <IconCheck />
  if (s === 'failed') return <IconX />
  if (s === 'busy') return <IconWait />
  if (d.reason?.kind === 'rollback') return <IconUndo />
  if (d.reason?.kind === 'first' || d.reason?.kind === 'code' || d.reason?.kind === 'auto_merge') return <IconUp />
  return <IconRedo />
}

export function useDeployments(projectId: string) {
  return useQuery({ queryKey: ['deployments', projectId], queryFn: () => api.listDeployments(projectId), refetchInterval: 10_000 })
}

export function DeployList({
  projectId, rows, limit, withLog = false, onRollback,
}: {
  projectId: string
  rows: DeploymentDto[]
  /** Höchstens so viele Einträge (eine Sammelzeile zählt als einer) */
  limit?: number
  /** Reiter: Log je Zeile aufklappbar */
  withLog?: boolean
  onRollback: (deploymentId: string) => void
}) {
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState<string | null>(null)
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const [openLog, setOpenLog] = useState<string | null>(null)
  const rollback = useMutation({
    mutationFn: (id: string) => api.rollback(projectId, id),
    onSuccess: (r) => {
      setConfirming(null)
      void qc.invalidateQueries({ queryKey: ['deployments', projectId] })
      onRollback(r.deployment.id)
    },
  })
  const all = groupDeployments(rows)
  const items = limit ? all.slice(0, limit) : all
  const anySame = items.some((it) => it.type === 'row' && it.sameAsActive)

  /** nested: Zeile in einer Sammelzeile; Zurückrollen nur auf der neuesten (gleicher Code) */
  const row = (d: DeploymentDto, sameAsActive: boolean, nested = false, firstInGroup = false) => {
    const s = deployState(d)
    const title = deployReasonTitle(d.reason, d.message)
    const showMessage = d.message && d.reason?.kind !== 'code' && d.message !== title
    const dur = s === 'active' || s === 'past' ? deployDuration(d.durationMs) : null
    const canRoll = d.canRollback && !sameAsActive && s === 'past' && (!nested || firstInGroup)
    return (
      <li key={d.id} className={`dl dl-${s}${nested ? ' dl-nested' : ''}`}>
        <span className="dl-mark" aria-hidden="true">{markFor(d)}</span>
        <div className="dl-body">
          <div className="dl-title">
            <span className="dl-name">{title}</span>
            {s === 'active' && <span className="dl-pill dl-pill-ok">aktiv</span>}
            {s === 'failed' && <span className="dl-pill dl-pill-bad">fehlgeschlagen</span>}
            {s === 'busy' && <span className="dl-pill dl-pill-info">{STATUS_WORD[d.status] ?? d.status}</span>}
            {sameAsActive && <span className="dl-pill dl-pill-same">gleicher Stand</span>}
          </div>
          <div className="dl-meta">
            {d.version ? <code className="dl-version" title={d.version}>{shortVersion(d.version)}</code> : <span>ohne Fassung</span>}
            {showMessage && <span className="dl-msg">«{d.message}»</span>}
            {d.actor !== undefined && <Actor actor={d.actor} />}
            <time dateTime={d.startedAt} title={new Date(d.startedAt).toLocaleString('de-CH')}>{relativeTime(d.startedAt)}</time>
            {dur && <span className="num">{dur}</span>}
          </div>
          {s === 'failed' && d.errorMessage && <p className="dl-error">{d.errorMessage.split('\n')[0]}</p>}
          {withLog && openLog === d.id && <DeployLog id={d.id} />}
        </div>
        <div className="dl-aside">
          {withLog && (
            <button type="button" className="button-small button-ghost" aria-expanded={openLog === d.id} onClick={() => setOpenLog(openLog === d.id ? null : d.id)}>
              {openLog === d.id ? 'Log schliessen' : 'Log'}
            </button>
          )}
          {canRoll && confirming !== d.id && <button type="button" className="button-small" onClick={() => setConfirming(d.id)}>Zurückrollen</button>}
          {confirming === d.id && (
            <span className="confirm-inline" role="group" aria-label="Rollback bestätigen">
              <button type="button" className="button-small button-primary" onClick={() => rollback.mutate(d.id)} disabled={rollback.isPending} autoFocus>{rollback.isPending ? 'Startet…' : 'Ja, diese Fassung'}</button>
              <button type="button" className="button-small" onClick={() => setConfirming(null)}>Abbrechen</button>
            </span>
          )}
          {d.seq !== undefined && <span className="dl-seq num" aria-label={`Deployment Nummer ${d.seq}`}>#{d.seq}</span>}
        </div>
      </li>
    )
  }

  const group = (it: Extract<DeployItem, { type: 'group' }>) => {
    const key = it.rows[0]!.id
    const open = openGroups.has(key)
    const toggle = () => setOpenGroups((g) => { const n = new Set(g); if (n.has(key)) n.delete(key); else n.add(key); return n })
    return (
      <li key={`g-${key}`} className="dl-group" data-open={open || undefined}>
        <button type="button" className="dl-group-toggle" aria-expanded={open} onClick={toggle}>
          <IconChevron />
          <span>{it.rows.length} weitere Deployments mit Stand <code className="dl-version">{shortVersion(it.version)}</code> <span className="dl-group-why">({groupSummary(it.rows)})</span></span>
        </button>
        <div className="dl-group-body">
          <ol className="dl-list dl-group-list" inert={!open || undefined}>{it.rows.map((d, idx) => row(d, false, true, idx === 0))}</ol>
        </div>
      </li>
    )
  }

  return (
    <>
      <ol className="dl-list">
        {items.map((it) => it.type === 'row' ? row(it.d, it.sameAsActive) : group(it))}
      </ol>
      {anySame && <p className="dl-note">Zurückrollen erscheint nur bei Versionen mit anderem Code-Stand.</p>}
      {rollback.isError && <p role="alert" className="error-inline">{rollback.error instanceof ApiError && rollback.error.status === 409 ? 'Für dieses Projekt läuft bereits ein Deploy.' : (rollback.error as Error).message}</p>}
    </>
  )
}

function DeployLog({ id }: { id: string }) {
  const d = useQuery({ queryKey: ['deployment', id], queryFn: () => api.getDeployment(id) })
  return <pre className="log dl-log" aria-label="Deployment-Log">{d.isLoading ? 'Log wird geladen…' : d.data?.log || 'Kein Log vorhanden.'}</pre>
}

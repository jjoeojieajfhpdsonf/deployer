import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type { AuditEventDto } from '@deployer/shared'
import { api } from '../api.js'
import { PageHead } from '../components/PageHead.js'
import { actorLabel, describeAudit } from '../lib/format.js'
import { IconSearch } from '../components/Icons.js'
import { useProjects } from '../lib/projects.js'

type Kind = 'alle' | 'fehler' | 'deploys'

const isDeploy = (e: AuditEventDto) => /deploy|rollback|public|start|stop/.test(e.action)
const isLogin = (e: AuditEventDto) => e.action === 'auth.login'

/**
 * Audit-Log: lesbare Sätze wie in der Übersicht, darunter der Schlüssel der
 * Aktion. Anmeldungen sind standardmässig ausgeblendet – sie überdeckten
 * sonst die echten Ereignisse (Critique).
 */
export function Audit() {
  const [filter, setFilter] = useState('')
  const [kind, setKind] = useState<Kind>('alle')
  const [logins, setLogins] = useState(false)
  const [limit, setLimit] = useState(100)
  const events = useQuery({ queryKey: ['audit', limit], queryFn: () => api.audit(limit), placeholderData: (prev) => prev })
  const projects = useProjects()
  const byId = useMemo(() => new Map((projects.data?.projects ?? []).map((p) => [p.id, p])), [projects.data])

  const all = events.data?.events ?? []
  const q = filter.trim().toLowerCase()
  const list = all
    .filter((e) => logins || !isLogin(e))
    .filter((e) => kind === 'alle' || (kind === 'fehler' ? e.result === 'error' : isDeploy(e)))
    .filter((e) => !q || describeAudit(e, byId).toLowerCase().includes(q) || e.action.includes(q) || e.actor.toLowerCase().includes(q) || JSON.stringify(e.paramsMasked ?? '').toLowerCase().includes(q))
  const hiddenLogins = logins ? 0 : all.filter(isLogin).length

  const details = (e: AuditEventDto) => {
    if (e.error) return e.error
    const p = e.paramsMasked
    if (!p || (typeof p === 'object' && Object.keys(p as object).length === 0)) return ''
    return JSON.stringify(p)
  }

  return (
    <section className="page">
      <PageHead
        crumbs={[{ label: 'audit' }]}
        title="Audit"
        actions={
          <div className="search">
            <IconSearch />
            <input type="search" aria-label="Audit-Log durchsuchen" placeholder="Projekt, Aktion oder Akteur" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        }
      />

      <div className="section-head">
        <div className="segmented" role="group" aria-label="Filter">
          {([['alle', 'Alle'], ['fehler', 'Fehler'], ['deploys', 'Deploys und Betrieb']] as const).map(([k, label]) => (
            <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>
          ))}
        </div>
        <label className="choice audit-logins">
          <input type="checkbox" checked={logins} onChange={(e) => setLogins(e.target.checked)} />
          <span>Anmeldungen zeigen{hiddenLogins > 0 ? <small> {hiddenLogins} ausgeblendet</small> : null}</span>
        </label>
      </div>

      {events.isLoading ? (
        <p className="state state-loading">Audit-Log wird geladen…</p>
      ) : events.isError ? (
        <p className="state state-error" role="alert">Audit-Log nicht lesbar.</p>
      ) : list.length === 0 ? (
        <p className="state state-empty">{q ? <>Nichts passt zu «{filter}».</> : kind === 'fehler' ? 'Keine Fehler in diesem Zeitraum.' : 'Keine Einträge.'}</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Zeit</th><th>Ereignis</th><th>Wer</th><th>Ergebnis</th><th>Details</th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id} className={e.result === 'error' ? 'row-error' : undefined}>
                  <td className="mono nowrap">{new Date(e.at).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                  <td>
                    <div>{describeAudit(e, byId)}</div>
                    <div className="cell-sub mono">{e.action}</div>
                  </td>
                  <td className="nowrap">{actorLabel(e.actor)}</td>
                  <td>{e.result === 'ok' ? <span className="status status-running"><span className="status-dot" aria-hidden="true" />ok</span> : <span className="status status-failed"><span className="status-dot" aria-hidden="true" />Fehler</span>}</td>
                  <td className="cell-detail">
                    {details(e) ? <span className="clamp-2" title={details(e)}>{details(e)}</span> : <span className="muted">–</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {all.length >= limit && (
        <div className="load-more">
          <span>{limit} neueste Einträge geladen</span>
          <button onClick={() => setLimit((l) => l + 200)} disabled={events.isFetching}>{events.isFetching ? 'Lädt…' : 'Ältere laden'}</button>
        </div>
      )}
    </section>
  )
}

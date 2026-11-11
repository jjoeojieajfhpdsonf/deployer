import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState, Loading, SkRows } from '../components/States.js'
import type { AuditEventDto } from '@airlock/shared'
import { api } from '../api.js'
import { PageHead } from '../components/PageHead.js'
import { ActivityList } from '../components/ActivityList.js'
import { actorText } from '../components/Actor.js'
import { bundle } from '../lib/activity.js'
import { IconSearch } from '../components/Icons.js'
import { IconWarn } from '../components/Security.js'
import { useProjects } from '../lib/projects.js'

type Kind = 'alle' | 'fehler' | 'deploys'

const isDeploy = (e: AuditEventDto) => /deploy|rollback|public|start|stop/.test(e.action)
const isLogin = (e: AuditEventDto) => e.action === 'auth.login'
/** Fehlgeschlagene Anmeldungen sind ein Sicherheitsereignis: nie ausblenden. */
const isHiddenLogin = (e: AuditEventDto) => isLogin(e) && e.result !== 'error'

/**
 * Audit-Log: dieselbe Zeitleiste wie die Aktivität eines Projekts, mit
 * Projektnamen und aufklappbaren Rohdaten (Schlüssel, Parameter) je Eintrag.
 * Anmeldungen sind standardmässig ausgeblendet – sie überdeckten sonst die
 * echten Ereignisse (Critique). ?projekt=<id> zeigt nur ein Projekt.
 */
export function Audit() {
  const [params, setParams] = useSearchParams()
  const projectFilter = params.get('projekt')
  const [filter, setFilter] = useState('')
  const [kind, setKind] = useState<Kind>('alle')
  const [logins, setLogins] = useState(false)
  const [limit, setLimit] = useState(100)
  const events = useQuery({
    queryKey: ['audit', limit, projectFilter],
    queryFn: () => api.audit(limit, projectFilter ?? undefined),
    placeholderData: (prev) => prev,
  })
  const projects = useProjects()
  const byId = useMemo(() => new Map((projects.data?.projects ?? []).map((p) => [p.id, p])), [projects.data])
  const filteredProject = projectFilter ? byId.get(projectFilter) : undefined

  const all = events.data?.events ?? []
  const q = filter.trim().toLowerCase()
  // Erst bündeln (Zusammengehöriges zusammen), dann filtern
  const items = useMemo(() => bundle(all.filter((e) => logins || !isHiddenLogin(e))), [all, logins])
  const list = items
    .filter((it) => kind === 'alle' || (kind === 'fehler' ? it.events.some((e) => e.result === 'error') : it.events.some(isDeploy)))
    .filter((it) => {
      if (!q) return true
      const p = it.targetId ? byId.get(it.targetId) : undefined
      const hay = [it.info.title, ...it.info.sub, actorText(it.actor), p?.name ?? '', p?.slug ?? '', ...it.events.map((e) => `${e.action} ${JSON.stringify(e.paramsMasked ?? '')}`)].join(' ').toLowerCase()
      return hay.includes(q)
    })
  const hiddenLogins = logins ? 0 : all.filter(isHiddenLogin).length
  const failedLogins = all.filter((e) => isLogin(e) && e.result === 'error').length

  return (
    <section className="page">
      <PageHead
        crumbs={[{ label: 'audit' }]}
        title="Audit"
        actions={
          <div className="search">
            <IconSearch />
            <input data-page-search aria-keyshortcuts="/" type="search" aria-label="Audit-Log durchsuchen (Taste /)" placeholder="Projekt, Aktion oder Akteur" value={filter} onChange={(e) => setFilter(e.target.value)} />
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
          <span>
            Anmeldungen zeigen
            {(hiddenLogins > 0 || (!logins && failedLogins > 0)) && (
              <small className="audit-logins-note">
                {hiddenLogins > 0 && <>{hiddenLogins} erfolgreiche ausgeblendet</>}
                {!logins && failedLogins > 0 && (
                  <span className="audit-logins-failed">
                    <IconWarn /> {failedLogins} {failedLogins === 1 ? 'fehlgeschlagene bleibt' : 'fehlgeschlagene bleiben'} sichtbar
                  </span>
                )}
              </small>
            )}
          </span>
        </label>
      </div>
      {projectFilter && (
        <p className="audit-project-filter">
          Nur <strong>{filteredProject?.name ?? 'ein Projekt'}</strong>
          <button type="button" className="link-button" onClick={() => setParams({})}>Alle Projekte zeigen</button>
        </p>
      )}

      {!events.data && events.isError ? (
        <ErrorState what="Das Audit-Log" error={events.error} retrying={events.isFetching} onRetry={() => void events.refetch()} />
      ) : !events.data ? (
        <Loading label="Audit-Log wird geladen"><SkRows n={8} /></Loading>
      ) : list.length === 0 ? (
        q ? (
          <EmptyState title={`Nichts passt zu «${filter}»`} action={<button type="button" onClick={() => setFilter('')}>Suche leeren</button>}>
            Gesucht wird in Titel, Projekt, Akteur und Rohdaten der geladenen Einträge.
          </EmptyState>
        ) : kind !== 'alle' ? (
          <EmptyState title={kind === 'fehler' ? 'Keine Fehler in diesem Zeitraum' : 'Keine Deploys in diesem Zeitraum'} action={<button type="button" onClick={() => setKind('alle')}>Alle Einträge zeigen</button>} />
        ) : (
          <EmptyState title="Noch keine Einträge" action={<Link className="button" to="/projekte/neu">Projekt anlegen</Link>}>
            Hier landet jede Änderung: Deploys, Scans, Einstellungen und Anmeldungen.
          </EmptyState>
        )
      ) : (
        <div className="panel panel-pad audit-panel">
          <ActivityList items={list} projects={projectFilter ? undefined : byId} details />
        </div>
      )}
      {all.length >= limit && (
        <div className="load-more">
          <span>{limit} neueste Einträge geladen</span>
          <button onClick={() => setLimit((l) => l + 200)} disabled={events.isFetching} aria-busy={events.isFetching || undefined}>Ältere laden</button>
        </div>
      )}
    </section>
  )
}

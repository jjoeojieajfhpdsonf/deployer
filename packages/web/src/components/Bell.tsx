import { useId, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AuditEventDto, ProjectDto } from '@airlock/shared'
import { api, type MeDto } from '../api.js'
import { useMenu } from './useMenu.js'
import { useProjects } from '../lib/projects.js'
import { auditTone, describeAudit, actorLabel } from '../lib/format.js'
import { fmtDateTime, fmtTime, msOf, nowIso, sameDay, fmtDayMonth } from '../lib/dates.js'
import { isReadOnly } from '../lib/activity.js'
import { poll } from '../lib/live.js'

/**
 * UI-Qualität 8: Glocke im Kopf. Zeigt Ereignisse, die nicht von dir in der
 * Oberfläche ausgelöst wurden (Claude, Airlock selbst, Auto-Deploy) oder die
 * gescheitert sind – also, was passiert ist, während du nicht hingeschaut
 * hast. Ungelesen = neuer als «gelesen bis» (auf dem Server gespeichert, gilt
 * auf jedem Gerät). Welche Ereignisse genau hineingehören, ist offen (Frage 11).
 */
const MAX = 8

export function isBellEvent(e: AuditEventDto): boolean {
  if (isReadOnly(e)) return false
  if (e.action === 'ui.prefs' || e.action.startsWith('auth.')) return false
  return e.result === 'error' || !e.actor.startsWith('ui:')
}

export function Bell({ me }: { me: MeDto }) {
  const { open, toggle, close, rootRef, triggerRef, listProps } = useMenu()
  const id = useId()
  const qc = useQueryClient()
  // Dieselbe Abfrage wie «Letzte Aktivität» der Projektliste: eine Anfrage, nicht zwei
  const audit = useQuery({ queryKey: ['audit', 'recent'], queryFn: () => api.audit(40), refetchInterval: poll })
  const projects = useProjects()
  const byId = useMemo(() => new Map((projects.data?.projects ?? []).map((p): [string, ProjectDto] => [p.id, p])), [projects.data])
  const events = (audit.data?.events ?? []).filter(isBellEvent).slice(0, MAX)
  const seen = msOf(me.bellSeenAt) ?? 0
  const unread = events.filter((e) => (msOf(e.at) ?? 0) > seen).length

  async function markRead() {
    const at = nowIso()
    qc.setQueryData<MeDto>(['me'], (old) => (old ? { ...old, bellSeenAt: at } : old))
    try { await api.setPreferences({ bellSeenAt: at }) } catch { /* beim nächsten Laden gilt der Server */ }
  }

  const label = unread > 0 ? `Ereignisse, ${unread} ungelesen` : 'Ereignisse, keine ungelesenen'
  // Gescheitert in Worten, wenn der Titel es nicht schon sagt
  const text = (e: AuditEventDto) => {
    const t = describeAudit(e, byId)
    return e.result === 'error' && !/fehlgeschlagen|gescheitert/i.test(t) ? `${t} – fehlgeschlagen` : t
  }
  const linkFor = (e: AuditEventDto) => (e.targetType === 'project' && e.targetId && byId.has(e.targetId) ? `/projekte/${e.targetId}` : '/audit')

  return (
    <div className="menu bell" ref={rootRef}>
      <button
        ref={triggerRef}
        className="bell-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        title={label}
        onClick={toggle}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1.5H3z" /><path d="M6.5 14.5a1.6 1.6 0 0 0 3 0" />
        </svg>
        {/* Zahl als Zusatz; die Bedeutung steht im Namen des Knopfs */}
        {unread > 0 && <span className="bell-count" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
      </button>
      <div {...listProps} role="menu" id={id} aria-label="Ereignisse" className={`${listProps.className} bell-menu`}>
        <div className="menu-head bell-head">
          <strong>Ereignisse</strong>
          <span>{unread > 0 ? `${unread} ungelesen` : 'alles gelesen'}</span>
        </div>
        <div className="menu-sep" />
        {events.length === 0 ? (
          <p className="bell-empty">Noch nichts passiert, das du nicht selbst ausgelöst hast.</p>
        ) : events.map((e) => {
          const fresh = (msOf(e.at) ?? 0) > seen
          const tone = auditTone(e)
          return (
            <Link key={e.id} role="menuitem" to={linkFor(e)} onClick={close} className={`bell-item${fresh ? ' bell-item-new' : ''}`}>
              <span className={`bell-dot bell-dot-${tone}`} aria-hidden="true" />
              <span className="bell-text">
                <span>{text(e)}</span>
                <span className="bell-meta">
                  {fresh && <span className="bell-new">neu · </span>}
                  <time dateTime={e.at} title={fmtDateTime(e.at)}>{sameDay(e.at, nowIso()) ? fmtTime(e.at) : fmtDayMonth(e.at)}</time> · {actorLabel(e.actor)}
                </span>
              </span>
            </Link>
          )
        })}
        <div className="menu-sep" />
        <div className="bell-actions">
          <button role="menuitem" disabled={unread === 0} onClick={() => void markRead()}>Alle als gelesen markieren</button>
          <Link role="menuitem" to="/audit" onClick={close}>Alle im Audit-Log</Link>
        </div>
      </div>
    </div>
  )
}

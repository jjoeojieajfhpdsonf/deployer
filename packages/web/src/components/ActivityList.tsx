import { useState, type ReactElement } from 'react'
import { Link } from 'react-router-dom'
import type { ProjectDto } from '@airlock/shared'
import { byDay, type ActivityItem, type Category } from '../lib/activity.js'
import { Actor, IconSpark } from './Actor.js'
import { useEnvPath } from '../lib/env.js'

/**
 * Aktivität als Zeitleiste: Tagestrenner, Symbol nach Kategorie (eigene Form
 * je Kategorie, Farbe nur zusätzlich), Satz als Titel, darunter Auslöser und
 * Ergänzungen, Ergebnis als Chip, Uhrzeit rechts. Dieselbe Darstellung im
 * Projekt (ohne Projektnamen) und im globalen Audit-Log (mit Projekt, Details).
 */

const svg = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
const ICON: Record<Category, () => ReactElement> = {
  deploy: () => <svg {...svg}><path d="M8 13V3.5M4.2 7.2 8 3.4l3.8 3.8" /></svg>,
  code: () => <svg {...svg}><path d="m5.5 4.5-3 3.5 3 3.5M10.5 4.5l3 3.5-3 3.5" /></svg>,
  header: () => <svg {...svg}><path d="M8 1.8 13 3.6v4c0 3.1-2.1 5.4-5 6.6-2.9-1.2-5-3.5-5-6.6v-4Z" /><path d="M8 5.6v4M6 7.6h4" /></svg>,
  scan: () => <svg {...svg}><circle cx="7" cy="7" r="4.3" /><path d="m10.3 10.3 3.2 3.2" /></svg>,
  public: () => <svg {...svg}><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c1.8 2 1.8 10 0 12M8 2c-1.8 2-1.8 10 0 12" /></svg>,
  paused: () => <svg {...svg}><path d="M5.8 3.5v9M10.2 3.5v9" /></svg>,
  config: () => <svg {...svg}><path d="M2.5 5h7M12.5 5h1M2.5 11h1M6.5 11h7" /><circle cx="11" cy="5" r="1.6" /><circle cx="5" cy="11" r="1.6" /></svg>,
  access: () => <svg {...svg}><circle cx="5.5" cy="10.5" r="3" /><path d="m7.6 8.4 5.9-5.9M11.5 4.5l1.6 1.6" /></svg>,
  claude: () => <IconSpark />,
  danger: () => <svg {...svg}><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" /></svg>,
  error: () => <svg {...svg}><path d="m4.8 4.8 6.4 6.4M11.2 4.8l-6.4 6.4" /></svg>,
}
/** Wort zur Kategorie für Screenreader (das Symbol ist aria-hidden) */
const CATEGORY_WORD: Record<Category, string> = {
  deploy: 'Deployment', code: 'Code', header: 'Header', scan: 'Scan', public: 'Veröffentlichung', paused: 'Pause',
  config: 'Einstellung', access: 'Zugang', claude: 'Claude', danger: 'Löschen', error: 'Fehler',
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })

export function ActivityList({
  items, projects, details = false, emptyText = 'Noch nichts passiert.',
}: {
  items: ActivityItem[]
  /** Globales Audit-Log: Projektnamen zeigen */
  projects?: Map<string, ProjectDto>
  /** Rohdaten je Eintrag aufklappbar (Audit-Log) */
  details?: boolean
  emptyText?: string
}) {
  const [open, setOpen] = useState<string | null>(null)
  const ep = useEnvPath()
  if (items.length === 0) return <p className="muted ov-empty">{emptyText}</p>
  return (
    <div className="act">
      {byDay(items).map((g) => (
        <section key={g.day} className="act-day" aria-label={g.day}>
          <h3 className="act-day-label">{g.day}</h3>
          <ol className="act-list">
            {g.items.map((it) => {
              const Icon = ICON[it.info.category]
              const project = projects && it.targetType === 'project' && it.targetId ? projects.get(it.targetId) : undefined
              const isOpen = open === it.id
              return (
                <li key={it.id} className={`act-item act-${it.info.category}`}>
                  <span className="act-mark"><Icon /><span className="visually-hidden">{CATEGORY_WORD[it.info.category]}:</span></span>
                  <div className="act-body">
                    <p className="act-title">{it.info.title}</p>
                    <p className="act-meta">
                      {project && <Link className="act-project" to={ep(`/projekte/${project.id}`)}>{project.name}</Link>}
                      {it.events.some((e) => e.server) && <span className="badge badge-neutral" title="Server-Ereignis: gilt für alle Umgebungen">Server</span>}
                      <Actor actor={it.actor} />
                      {it.info.sub.map((s, i) => <span key={i} className="act-sub">{s}</span>)}
                      {it.info.chip && <span className={`act-chip act-chip-${it.info.chip.tone}`}>{it.info.chip.text}</span>}
                    </p>
                    {details && (
                      <>
                        <button type="button" className="act-details-toggle link-button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : it.id)}>
                          {isOpen ? 'Details ausblenden' : 'Details'}
                        </button>
                        {isOpen && (
                          <dl className="act-details">
                            {it.events.map((e) => (
                              <div key={e.id}>
                                <dt><code>{e.action}</code> · {new Date(e.at).toLocaleString('de-CH')} · {e.result === 'ok' ? 'ok' : 'Fehler'}</dt>
                                <dd><code>{e.error ?? JSON.stringify(e.paramsMasked ?? {})}</code></dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </>
                    )}
                  </div>
                  <time className="act-time num" dateTime={it.at} title={new Date(it.at).toLocaleString('de-CH')}>{clock(it.at)}</time>
                </li>
              )
            })}
          </ol>
        </section>
      ))}
    </div>
  )
}

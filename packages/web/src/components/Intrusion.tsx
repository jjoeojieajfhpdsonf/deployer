import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  INCIDENT_SEVERITY_LABEL, INCIDENT_SOURCE_LABEL, INCIDENT_STATUS_LABEL, INTRUSION_LEARN_MINUTES,
  type IncidentSeverity, type IncidentStatus, type IntrusionIncidentDto, type ProjectDto, type ProjectIntrusionDto,
} from '@airlock/shared'
import { api } from '../api.js'
import { notifyOk } from '../lib/feedback.js'
import { relativeTime } from '../lib/format.js'
import { fmtDateTime } from '../lib/dates.js'
import { useEnvPath } from '../lib/env.js'
import { EmptyState, ErrorState, Loading, SkLines, SkRows, SkStats } from './States.js'
import { Modal } from './Modal.js'
import { ConfirmDialog } from './Confirm.js'
import { Switch } from './Switch.js'
import { SetRow } from './Publication.js'
import { IconAlert, IconCheck, IconLock, IconOk, IconPending, IconShield, IconWarn } from './Icons.js'

/**
 * Nacht 3, Etappe 5: Einbruchserkennung in der Oberfläche – Security ›
 * Vorfälle (Liste, Verlauf, Status, Notiz) und die Karte im Reiter Security
 * eines Projekts (Überwachung, Vorfälle, Isolieren, Reaktion).
 *
 * Nur bestehende Bausteine (Kennzahlen, Segmente, Tabelle, Status-Pille,
 * Einstellungskarte, Switch, Modal, ConfirmDialog). Schweregrad und Status
 * immer mit Wort (und Zeichen), nie nur über Farbe. Keine Animation.
 */

const SEVERITY_CLASS: Record<IncidentSeverity, string> = {
  kritisch: 'status-failed sev-kritisch',
  hoch: 'status-failed',
  mittel: 'status-warn',
  niedrig: 'status-stopped',
}

export function SeverityPill({ severity }: { severity: IncidentSeverity }) {
  const Icon = severity === 'kritisch' ? IconAlert : severity === 'hoch' || severity === 'mittel' ? IconWarn : null
  return (
    <span className={`status ${SEVERITY_CLASS[severity]} sev-pill`}>
      {Icon ? <Icon size={13} /> : <span className="status-dot" aria-hidden="true" />}
      {INCIDENT_SEVERITY_LABEL[severity]}
    </span>
  )
}

export function IncidentStatusPill({ status }: { status: IncidentStatus }) {
  const cls = status === 'offen' ? 'status-deploying' : status === 'erledigt' ? 'status-running' : 'status-stopped'
  const Icon = status === 'erledigt' ? IconOk : status === 'offen' ? IconPending : IconCheck
  return <span className={`status ${cls}`}><Icon size={13} />{INCIDENT_STATUS_LABEL[status]}</span>
}

const ACTOR = (a: string | null) => (!a ? 'Airlock' : a === 'ui:joel' ? 'Du' : a === 'cli' ? 'Kommandozeile' : a.startsWith('system') ? 'Airlock' : a)

/* --- Security › Vorfälle --------------------------------------------------------------- */

type Filter = 'aktiv' | 'offen' | 'gesehen' | 'erledigt' | 'alle'
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'aktiv', label: 'Nicht erledigt' }, { key: 'offen', label: 'Offen' }, { key: 'gesehen', label: 'Gesehen' }, { key: 'erledigt', label: 'Erledigt' }, { key: 'alle', label: 'Alle' },
]

export function IncidentsPage() {
  const [filter, setFilter] = useState<Filter>('aktiv')
  const [openId, setOpenId] = useState<string | null>(null)
  const q = useQuery({ queryKey: ['intrusion-incidents', filter], queryFn: () => api.intrusionIncidents(filter), refetchInterval: 60_000 })
  const c = q.data?.counts
  const titleId = useId()
  return (
    <>
      {c ? (
        <div className="stats">
          <div className="stat">
            <div className="label">Kritisch</div>
            <div className={`stat-value${c.active.kritisch ? ' tone-bad' : ''}`}>{c.active.kritisch}</div>
            <div className="stat-sub">nicht erledigt</div>
          </div>
          <div className="stat">
            <div className="label">Hoch</div>
            <div className={`stat-value${c.active.hoch ? ' tone-bad tone-high' : ''}`}>{c.active.hoch}</div>
            <div className="stat-sub">werden per Push und E-Mail gemeldet</div>
          </div>
          <div className="stat">
            <div className="label">Mittel · Niedrig</div>
            <div className="stat-value">{c.active.mittel} <small>· {c.active.niedrig}</small></div>
            <div className="stat-sub">nur hier</div>
          </div>
          <div className="stat">
            <div className="label">Noch nicht angesehen</div>
            <div className="stat-value">{c.unseen}</div>
            <div className="stat-sub">Status «offen»</div>
          </div>
        </div>
      ) : !q.isError && <Loading label="Kennzahlen werden geladen"><SkStats /></Loading>}

      <div className="section">
        <div className="section-head">
          <div>
            <h2 id={titleId}>Vorfälle</h2>
            <p>Gleiche Hinweise sind gebündelt (Zähler). Neue Container lernen {INTRUSION_LEARN_MINUTES} Minuten lang, was normal ist.</p>
          </div>
          <div className="segmented" role="group" aria-label="Vorfälle filtern">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</button>
            ))}
          </div>
        </div>
        {!q.data && q.isError ? (
          <ErrorState what="Die Vorfälle" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <Loading label="Vorfälle werden geladen"><SkRows n={4} /></Loading>
        ) : q.data.incidents.length === 0 ? (
          <EmptyState title={filter === 'aktiv' ? 'Keine offenen Vorfälle' : 'Keine Vorfälle in dieser Auswahl'}>
            Airlock prüft jede Minute die Prozesse der Container, alle 5 Minuten ihre Dateien, stündlich die statischen Seiten, dazu Anmeldungen, gesperrte Ausgangsversuche und Scans von aussen.
          </EmptyState>
        ) : (
          <IncidentTable incidents={q.data.incidents} onOpen={setOpenId} labelledBy={titleId} showProject />
        )}
      </div>
      <IncidentDialog id={openId} onClose={() => setOpenId(null)} />
    </>
  )
}

function IncidentTable({ incidents, onOpen, labelledBy, showProject }: { incidents: IntrusionIncidentDto[]; onOpen: (id: string) => void; labelledBy?: string; showProject?: boolean }) {
  const ep = useEnvPath()
  return (
    <div className="table-scroll">
      <table className="table incident-table" aria-labelledby={labelledBy}>
        <thead>
          <tr>
            <th>Schwere</th><th>Vorfall</th>{showProject && <th>Betrifft</th>}<th className="num">Anzahl</th><th>Zuletzt</th><th>Status</th>
            <th><span className="visually-hidden">Aktion</span></th>
          </tr>
        </thead>
        <tbody>
          {incidents.map((i) => (
            <tr key={i.id} className={i.status === 'erledigt' ? 'incident-done' : undefined}>
              <td><SeverityPill severity={i.severity} /></td>
              <td className="cell-main incident-title">
                <span>{i.title}</span>
                <small className="muted">{INCIDENT_SOURCE_LABEL[i.source]}{i.samples[0] ? ` · ${i.samples[0]}` : ''}</small>
              </td>
              {showProject && (
                <td>{i.project ? <Link to={ep(`/projekte/${i.project.id}?tab=security`)}>{i.project.name}</Link> : <span className="muted">Server</span>}</td>
              )}
              <td className="num">{i.count.toLocaleString('de-CH')}×</td>
              <td className="incident-when" title={fmtDateTime(i.lastSeen)}>{relativeTime(i.lastSeen)}</td>
              <td><IncidentStatusPill status={i.status} /></td>
              <td className="row-actions">
                <button type="button" className="button-small" onClick={() => onOpen(i.id)} aria-label={`Ansehen: ${i.title}`}>Ansehen</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* --- Ein Vorfall: Beispiele, Verlauf, Status, Notiz --------------------------------------- */

export function IncidentDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient()
  const ep = useEnvPath()
  const titleId = useId()
  const noteId = useId()
  const q = useQuery({ queryKey: ['intrusion-incident', id], queryFn: () => api.intrusionIncident(id!), enabled: id !== null })
  const i = q.data?.incident
  const [note, setNote] = useState('')
  const [confirmNormal, setConfirmNormal] = useState(false)
  useEffect(() => { setNote(i?.note ?? '') }, [i?.id, i?.note])
  const done = (r: { incident: { id: string } }) => {
    qc.setQueryData(['intrusion-incident', r.incident.id], r)
    void qc.invalidateQueries({ queryKey: ['intrusion-incidents'] })
    void qc.invalidateQueries({ queryKey: ['intrusion'] })
  }
  const update = useMutation({
    meta: { errorTitle: 'Vorfall nicht geändert' },
    mutationFn: (input: { status?: IncidentStatus; note?: string | null }) => api.updateIntrusionIncident(id!, input),
    onSuccess: (r, v) => {
      done(r)
      notifyOk(v.status ? `Vorfall: ${INCIDENT_STATUS_LABEL[v.status]}` : 'Notiz gespeichert', { id: `incident-${id}` })
    },
  })
  const normal = useMutation({
    meta: { errorTitle: 'Nicht als normal markiert' },
    mutationFn: () => api.markIncidentNormal(id!),
    onSuccess: (r) => { done(r); setConfirmNormal(false); notifyOk('Als normal markiert', { id: `incident-${id}`, description: 'Gilt ab jetzt für alle Container des Projekts.' }) },
  })
  const noteDirty = (i?.note ?? '') !== note.trim()

  return (
    <Modal open={id !== null} onClose={onClose} labelledBy={titleId} wide busy={update.isPending || normal.isPending}>
      {!i ? (
        q.isError ? <ErrorState compact what="Der Vorfall" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
          : <Loading label="Vorfall wird geladen"><SkLines n={5} /></Loading>
      ) : (
        <div className="incident-detail">
          <h2 id={titleId}>{i.title}</h2>
          <div className="incident-meta">
            <SeverityPill severity={i.severity} />
            <IncidentStatusPill status={i.status} />
            <span className="muted">{INCIDENT_SOURCE_LABEL[i.source]}</span>
          </div>
          <dl className="facts incident-facts">
            <dt>Betrifft</dt>
            <dd>{i.project ? <Link to={ep(`/projekte/${i.project.id}?tab=security`)} onClick={onClose}>{i.project.name}</Link> : 'Server (Anmeldung)'}{i.service ? ` · ${i.service}` : ''}</dd>
            <dt>Gesehen</dt>
            <dd>{i.count.toLocaleString('de-CH')}× · zuerst {fmtDateTime(i.firstSeen)}, zuletzt {fmtDateTime(i.lastSeen)}</dd>
            {i.notifiedAt && <><dt>Gemeldet</dt><dd>{fmtDateTime(i.notifiedAt)} (Push/E-Mail, wenn eingerichtet)</dd></>}
          </dl>
          {i.samples.length > 0 && (
            <>
              <h3 className="incident-sub">Beispiele</h3>
              <ul className="incident-samples">{i.samples.map((s) => <li key={s}><code>{s}</code></li>)}</ul>
            </>
          )}
          <label htmlFor={noteId} className="incident-sub">Notiz</label>
          <textarea id={noteId} rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="z. B. «War ich – docker exec zum Nachsehen»" />
          <div className="incident-actions">
            <button type="button" className="button-small" disabled={!noteDirty || update.isPending} onClick={() => update.mutate({ note: note.trim() || null })}>Notiz speichern</button>
            <span className="incident-actions-gap" />
            {i.canMarkNormal && i.status !== 'erledigt' && (
              <button type="button" disabled={normal.isPending} onClick={() => setConfirmNormal(true)}>Als normal markieren …</button>
            )}
            {i.status === 'offen' && <button type="button" disabled={update.isPending} onClick={() => update.mutate({ status: 'gesehen' })}>Gesehen</button>}
            {i.status !== 'erledigt'
              ? <button type="button" className="button-primary" disabled={update.isPending} onClick={() => update.mutate({ status: 'erledigt' })}>Erledigt</button>
              : <button type="button" disabled={update.isPending} onClick={() => update.mutate({ status: 'offen' })}>Wieder öffnen</button>}
          </div>
          {i.project && i.severity !== 'niedrig' && i.status !== 'erledigt' && (
            <p className="hint incident-hint">Den Container vom Netz nehmen: <Link to={ep(`/projekte/${i.project.id}?tab=security`)} onClick={onClose}>Projekt › Security › «Container jetzt isolieren»</Link>.</p>
          )}
          <h3 className="incident-sub">Verlauf</h3>
          <ol className="incident-events">
            {i.events.map((e, n) => (
              <li key={`${e.at}-${n}`}>
                <time dateTime={e.at}>{fmtDateTime(e.at)}</time>
                <span>{e.text}</span>
                <small className="muted">{ACTOR(e.actor)}</small>
              </li>
            ))}
          </ol>
          <div className="dialog-actions"><button type="button" onClick={onClose}>Schliessen</button></div>
        </div>
      )}
      <ConfirmDialog
        open={confirmNormal}
        title="Als normal markieren?"
        confirmLabel="Als normal markieren"
        busy={normal.isPending}
        error={normal.isError ? (normal.error as Error).message : null}
        onCancel={() => setConfirmNormal(false)}
        onConfirm={() => normal.mutate()}
      >
        <p>{i?.source === 'prozess' ? `Das Programm «${i.subject ?? ''}» gilt in diesem Dienst ab jetzt als normal – auch in künftigen Deployments.`
          : i?.source === 'netz' ? 'Diese Ziele werden nicht mehr gemeldet. Gesperrt bleiben sie trotzdem (Ausnahmen unter Einstellungen › Ausgehende Verbindungen).'
            : 'Diese Orte gelten ab jetzt als normal (Ordner; ausführbare Dateien nur genau diese). Neue Programme dort werden trotzdem gemeldet.'}</p>
        <p className="hint">Der Vorfall wird erledigt. Rückgängig unter Projekt › Security › «Als normal markiert».</p>
      </ConfirmDialog>
    </Modal>
  )
}

/* --- Projekt › Security ------------------------------------------------------------------ */

/** « · zuletzt vor 3 Min.» mit genau einem Punkt am Ende */
const lastCheck = (iso: string | null) => {
  const t = iso ? ` · zuletzt ${relativeTime(iso)}` : ''
  return t.endsWith('.') ? t : `${t}.`
}

const WATCH_TEXT: Record<ProjectIntrusionDto['watch']['state'], string> = {
  aktiv: 'Überwacht',
  lernt: 'Lernt die Grundlinie',
  'ohne-container': 'Kein laufender Container',
  statisch: 'Dateien werden stündlich geprüft',
  extern: 'Web und Netz',
}

/**
 * Einbruchserkennung im Reiter Security: zweimal einhängen (über und unter
 * dem Scan-Bericht). Gibt es einen offenen Vorfall «hoch» oder «kritisch»
 * oder ist das Projekt isoliert, steht die Karte oben – sonst unten, damit
 * der Scan im Ruhefall vorne bleibt. Beim Zusammenführen mit der neuen
 * Security-Seite (main) dort genauso oben und unten einhängen.
 */
export function ProjectIntrusionSlot({ p, at }: { p: ProjectDto; at: 'top' | 'bottom' }) {
  const q = useQuery({ queryKey: ['intrusion', p.id], queryFn: () => api.intrusion(p.id), refetchInterval: 60_000 })
  const d = q.data?.intrusion
  const urgent = Boolean(d && (d.isolation || d.incidents.some((i) => i.status !== 'erledigt' && (i.severity === 'hoch' || i.severity === 'kritisch'))))
  if (at === 'top' ? !urgent : urgent) return null
  return <ProjectIntrusion p={p} />
}

/** Einbruchserkennung eines Projekts (Karte) */
export function ProjectIntrusion({ p }: { p: ProjectDto }) {
  const qc = useQueryClient()
  const titleId = useId()
  const autoId = useId()
  const [openId, setOpenId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'isolate' | 'release' | null>(null)
  const q = useQuery({ queryKey: ['intrusion', p.id], queryFn: () => api.intrusion(p.id), refetchInterval: 60_000 })
  const d = q.data?.intrusion
  const done = (r: { intrusion: ProjectIntrusionDto }) => {
    qc.setQueryData(['intrusion', p.id], { intrusion: r.intrusion })
    void qc.invalidateQueries({ queryKey: ['egress', p.id] })
    void qc.invalidateQueries({ queryKey: ['project', p.id] })
  }
  const auto = useMutation({
    meta: { errorTitle: 'Reaktion nicht geändert' },
    mutationFn: (v: boolean) => api.setIntrusion(p.id, { autoStop: v }),
    onSuccess: (r, v) => { done(r); notifyOk(v ? 'Bei kritischem Vorfall: stoppen und pausieren' : 'Bei kritischem Vorfall: nur melden', { id: `intrusion-auto-${p.id}` }) },
  })
  const isolate = useMutation({
    meta: { errorTitle: 'Nicht isoliert' },
    mutationFn: () => api.isolate(p.id),
    onSuccess: (r) => { done(r); setConfirm(null); notifyOk('Container isoliert', { id: `isolate-${p.id}`, description: 'Ausgang abgeschottet, Neustart und Deploy gesperrt.' }) },
  })
  const release = useMutation({
    meta: { errorTitle: 'Isolation nicht aufgehoben' },
    mutationFn: () => api.releaseIsolation(p.id),
    onSuccess: (r) => { done(r); setConfirm(null); notifyOk('Isolation aufgehoben', { id: `isolate-${p.id}`, description: 'Der Ausgang bleibt abgeschottet.' }) },
  })
  const removeNormal = useMutation({
    meta: { errorTitle: 'Eintrag nicht entfernt' },
    mutationFn: (e: ProjectIntrusionDto['normal'][number]) => api.removeIntrusionNormal(p.id, e),
    onSuccess: (r) => { done(r); notifyOk('Wieder überwacht', { id: `intrusion-normal-${p.id}` }) },
  })
  const active = d?.incidents.filter((i) => i.status !== 'erledigt') ?? []
  // Ohne eigenen Container: kein Stoppen bei Vorfällen, kein Isolieren (bestehender Dienst: Airlock fasst ihn nicht an)
  const isStatic = p.runtimeKind === 'static' || p.sourceType === 'external'

  return (
    <section className="set-card intrusion-card" aria-labelledby={titleId}>
      <div className="set-head">
        <h2 id={titleId}>Einbruchserkennung</h2>
        {d && (
          <div className="set-head-actions">
            {d.isolation
              ? <span className="status status-failed"><IconLock size={13} />Isoliert</span>
              : <span className={`status ${d.watch.state === 'lernt' ? 'status-deploying' : d.watch.state === 'ohne-container' ? 'status-stopped' : 'status-running'}`}>
                {d.watch.state === 'lernt' ? <IconPending size={13} /> : d.watch.state === 'ohne-container' ? <span className="status-dot" aria-hidden="true" /> : <IconShield size={13} />}
                {WATCH_TEXT[d.watch.state]}
              </span>}
          </div>
        )}
      </div>
      {!d && q.isError ? <div className="set-row-note"><ErrorState compact what="Die Einbruchserkennung" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} /></div>
        : !d ? <Loading label="Einbruchserkennung wird geladen" className="set-row-note"><SkLines n={3} /></Loading> : (
        <>
          <p className="set-row-note intrusion-watch">
            {d.watch.state === 'lernt' && d.watch.learnUntil ? `Neue Container lernen bis ${fmtDateTime(d.watch.learnUntil)}, welche Programme und Dateien normal sind. Danach meldet Airlock Neues.`
              : d.watch.state === 'aktiv' ? `${d.watch.containers} Container: Prozesse jede Minute, Dateien alle 5 Minuten${lastCheck(d.watch.lastCheckAt)}`
                : d.watch.state === 'statisch' ? `Die ausgelieferten Dateien werden stündlich mit der Fassung verglichen${lastCheck(d.watch.lastCheckAt)}`
                : d.watch.state === 'extern' ? 'Bestehender Dienst: Airlock beobachtet die Anfragen an seine Adressen (Web) und das Netz. Prozesse und Dateien eines Containers, den Airlock nicht verwaltet, sieht es nicht.'
                  : 'Sobald ein Container läuft, lernt Airlock seine Grundlinie und prüft dann jede Minute.'}
          </p>
          {d.isolation && (
            <div className="set-row-note intrusion-isolated" role="status">
              <IconLock size={14} />
              <span>Isoliert seit {fmtDateTime(d.isolation.at)} ({ACTOR(d.isolation.by)}): Ausgang abgeschottet, Start, Neustart und Deploy gesperrt. Die Container laufen weiter, damit sich ihr Zustand ansehen lässt.</span>
            </div>
          )}
          <div className="set-row-block intrusion-block">
            <h3 className="egress-sub">{active.length ? `Offene Vorfälle (${active.length})` : 'Vorfälle'}</h3>
            {d.incidents.length === 0
              ? <p className="hint egress-empty">Keine Vorfälle.</p>
              : <IncidentTable incidents={d.incidents} onOpen={setOpenId} />}
          </div>
          {!isStatic && (
            <SetRow
              label={<span id={autoId}>Bei kritischem Vorfall</span>}
              action={<Switch checked={auto.isPending ? auto.variables === true : d.autoStop} labelledBy={autoId} busy={auto.isPending} onChange={(v) => auto.mutate(v)} />}
            >
              <strong className="set-strong">{d.autoStop ? 'Container stoppen und Seite pausieren' : 'Nur melden'}</strong>
              <span className="muted"> · {d.autoStop ? 'z. B. bei einem Krypto-Miner; die öffentliche Seite zeigt die Pause-Seite' : 'Standard; stoppen und pausieren geht von Hand'}</span>
            </SetRow>
          )}
          {!isStatic && (
            <SetRow
              label="Isolieren"
              action={d.isolation
                ? <button type="button" onClick={() => setConfirm('release')}>Isolation aufheben …</button>
                : <button type="button" className="button-warn" onClick={() => setConfirm('isolate')}><IconLock size={14} /> Container jetzt isolieren …</button>}
            >
              <span className="muted">{d.isolation ? 'Aufheben: Start und Deploy gehen wieder; der Ausgang bleibt abgeschottet.' : 'Ausgang auf «Abgeschottet», kein Neustart bis zur Freigabe. Die Seite bleibt erreichbar.'}</span>
            </SetRow>
          )}
          {d.normal.length > 0 && (
            <div className="set-row-block">
              <h3 className="egress-sub">Als normal markiert</h3>
              <ul className="egress-list">
                {d.normal.map((n) => (
                  <li key={`${n.kind}|${n.service}|${n.value}`}>
                    <span className="egress-target"><code>{n.value}</code></span>
                    <span className="egress-detail muted">{n.kind === 'prozess' ? 'Programm' : n.kind === 'datei' ? (n.value.endsWith('/') ? 'Ordner' : 'Datei') : 'Ziel'}{n.service ? ` · ${n.service}` : ''}</span>
                    <button type="button" className="button-small" disabled={removeNormal.isPending} onClick={() => removeNormal.mutate(n)} aria-label={`Entfernen: ${n.value} (wieder überwachen)`}>Entfernen</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <IncidentDialog id={openId} onClose={() => setOpenId(null)} />
      <ConfirmDialog
        open={confirm === 'isolate'}
        title="Container jetzt isolieren?"
        confirmLabel="Isolieren"
        busy={isolate.isPending}
        error={isolate.isError ? (isolate.error as Error).message : null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => isolate.mutate()}
      >
        <p>«{p.name}» erreicht danach nichts mehr ausserhalb seines eigenen Netzes (Ausgang «Abgeschottet», durchgesetzt). Start, Neustart, Deploy und Rollback sind gesperrt, Docker startet die Container nicht neu.</p>
        <p>Die Container laufen weiter, Besucher erreichen die Seite weiter – zum Abschalten zusätzlich stoppen oder pausieren.</p>
        <p className="hint">Airlock fragt dafür noch einmal nach deinem Passwort oder Passkey. Notausgang ohne Oberfläche: <code className="intrusion-cmd">docker exec airlock-app node dist/cli.js release-isolation {p.slug}</code></p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'release'}
        title="Isolation aufheben?"
        confirmLabel="Aufheben"
        busy={release.isPending}
        error={release.isError ? (release.error as Error).message : null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => release.mutate()}
      >
        <p>Start, Neustart und Deploy gehen wieder, Docker startet die Container nach einem Absturz wieder neu.</p>
        <p>Der Ausgang bleibt «Abgeschottet». Öffnen unter Einstellungen › Ausgehende Verbindungen, wenn die Ursache behoben ist.</p>
      </ConfirmDialog>
    </section>
  )
}

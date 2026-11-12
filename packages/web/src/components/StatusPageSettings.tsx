import { useEffect, useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  INCIDENT_STATE_LABEL, incidentStates, STATUS_AUTO_DOWN_MS,
  type IncidentDto, type IncidentState, type StatusPageDto,
} from '@airlock/shared'
import { api } from '../api.js'
import { Field } from './Field.js'
import { Switch } from './Switch.js'
import { ConfirmDialog } from './Confirm.js'
import { IconCheck, IconExternal, IconWarn } from './Icons.js'
import { EmptyState, ErrorState, Loading, SkCard } from './States.js'
import { fmtDateTimeShort } from '../lib/dates.js'
import { actorLabel, relativeTime } from '../lib/format.js'

/**
 * Etappe 5: Einstellungen › Statusseite der Umgebung. Ein/aus und Titel,
 * welche Projekte erscheinen, Störungen melden und fortschreiben. Die Seite
 * selbst liefert ein eigener Container aus (status.<hauptzone>); hier steht
 * nur, was Airlock dorthin schreibt.
 */
export function StatusPageSettings() {
  const q = useQuery({ queryKey: ['status-page'], queryFn: api.statusPage })
  if (!q.data && q.isError) return <ErrorState what="Die Statusseite" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
  if (!q.data) return <Loading label="Statusseite wird geladen"><SkCard lines={5} /></Loading>
  const sp = q.data.statusPage
  return (
    <>
      <PageSettings sp={sp} />
      <ShownProjects sp={sp} />
      <Incidents sp={sp} />
    </>
  )
}

/* --- Ein/aus und Titel ------------------------------------------------------------- */

function PageSettings({ sp }: { sp: StatusPageDto }) {
  const qc = useQueryClient()
  const labelId = useId()
  const problemId = useId()
  const [title, setTitle] = useState(sp.title)
  useEffect(() => setTitle(sp.title), [sp.title])
  const save = useMutation({
    meta: { errorTitle: 'Statusseite nicht geändert' },
    mutationFn: (input: { enabled?: boolean; title?: string }) => api.setStatusPage(input),
    onSuccess: (r, v) => {
      qc.setQueryData(['status-page'], r)
      if (v.enabled !== undefined) toast.success(v.enabled ? 'Statusseite ist an' : 'Statusseite ist aus', { description: v.enabled ? `Öffentlich unter ${r.statusPage.hostname}. Cloudflare braucht für den neuen Namen manchmal ein, zwei Minuten.` : 'DNS-Eintrag, Tunnel-Regel und Dateien sind entfernt.' })
      else toast.success('Titel gespeichert')
    },
  })
  const on = save.isPending && save.variables?.enabled !== undefined ? Boolean(save.variables.enabled) : sp.enabled
  const blocked = !sp.enabled && !sp.publicReady
  const titleError = title.trim() ? null : 'Bitte einen Titel eingeben'
  return (
    <form className="field-group sp-settings" noValidate onSubmit={(e) => { e.preventDefault(); if (!titleError) save.mutate({ title: title.trim() }) }}>
      <h2>Statusseite</h2>
      <p className="hint">
        Öffentliche Seite mit Zustand und Verfügbarkeit der Projekte und den Störungen. Ein eigener Container liefert sie aus –
        ohne Zugriff auf Airlock, Datenbank oder Docker. Sie zeigt nur Namen, Zustand und Verfügbarkeit, keine Adressen, Versionen oder Fehlertexte.
      </p>
      <div className="sp-switch-row">
        <span id={labelId} className="sp-switch-label">Öffentlich unter <strong>{sp.hostname ?? 'status.<hauptzone>'}</strong></span>
        <Switch checked={on} labelledBy={labelId} describedBy={sp.problem ? problemId : undefined} busy={save.isPending} disabled={blocked} onChange={(v) => save.mutate({ enabled: v })} />
        <strong className="sp-switch-word">{on ? 'An' : 'Aus'}</strong>
      </div>
      {sp.problem && (
        <p className="sp-problem" id={problemId}><IconWarn /> <span>{sp.problem}</span></p>
      )}
      {sp.enabled && sp.hostname && (
        <p className="hint sp-address">
          <a href={`https://${sp.hostname}`} target="_blank" rel="noreferrer">https://{sp.hostname} <IconExternal /></a>
          {' · '}{sp.writtenAt ? `zuletzt geschrieben ${relativeTime(sp.writtenAt)}` : 'noch nicht geschrieben'}{' · '}RSS: <code>/feed.xml</code>
        </p>
      )}
      <Field id="sp-title" label="Titel der Seite" error={title !== sp.title ? titleError ?? undefined : undefined} hint="Steht oben auf der Seite und im Browser-Tab, z. B. «Status Beispiel».">
        <input id="sp-title" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} aria-describedby={titleError && title !== sp.title ? 'sp-title-error' : 'sp-title-hint'} aria-invalid={Boolean(titleError && title !== sp.title) || undefined} />
      </Field>
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={title.trim() === sp.title || Boolean(titleError) || save.isPending}>Titel speichern</button>
      </div>
    </form>
  )
}

/* --- Projekte auf der Seite --------------------------------------------------------- */

function ShownProjects({ sp }: { sp: StatusPageDto }) {
  const qc = useQueryClient()
  const set = useMutation({
    meta: { errorTitle: 'Nicht geändert' },
    mutationFn: ({ id, show }: { id: string; show: boolean | null }) => api.updateProject(id, { showOnStatus: show }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ['status-page'] })
      void qc.invalidateQueries({ queryKey: ['project', v.id] })
    },
  })
  const shown = sp.projects.filter((p) => p.shown).length
  return (
    <fieldset className="field-group">
      <legend>Projekte auf der Seite</legend>
      <p className="hint">Standard: öffentliche Projekte erscheinen, interne nicht. Ein Haken hier gilt wie «Auf Statusseite zeigen» in den Einstellungen des Projekts. {shown === 1 ? '1 Projekt' : `${shown} Projekte`} auf der Seite.</p>
      {sp.projects.length === 0 ? (
        <p className="hint">In dieser Umgebung gibt es noch keine Projekte.</p>
      ) : (
        <div className="sp-projects">
          {sp.projects.map((p) => {
            const pending = set.isPending && set.variables?.id === p.id
            const checked = pending ? Boolean(set.variables?.show ?? p.public) : p.shown
            return (
              <label key={p.id} className="choice">
                <input type="checkbox" checked={checked} aria-busy={pending || undefined} onChange={(e) => { if (!pending) set.mutate({ id: p.id, show: e.target.checked }) }} />
                <span>{p.name}<small>{p.public ? 'öffentlich' : 'intern'} · {p.explicit ? 'selbst gewählt' : 'Standard'}</small></span>
              </label>
            )
          })}
        </div>
      )}
    </fieldset>
  )
}

/* --- Störungen ------------------------------------------------------------------- */

const STATE_HINT: Record<IncidentState, string> = {
  untersucht: 'Etwas stimmt nicht, die Ursache ist noch offen.',
  erkannt: 'Die Ursache ist bekannt, die Behebung läuft.',
  behoben: 'Läuft wieder; bleibt 14 Tage als behoben auf der Seite.',
}

function StateBadge({ state }: { state: IncidentState }) {
  return (
    <span className={`badge sp-state sp-state-${state === 'behoben' ? 'done' : 'open'}`}>
      {state === 'behoben' ? <IconCheck size={13} /> : <IconWarn size={13} />}
      {INCIDENT_STATE_LABEL[state]}
    </span>
  )
}

function StateChoice({ value, onChange, name }: { value: IncidentState; onChange: (s: IncidentState) => void; name: string }) {
  return (
    <fieldset className="sp-states">
      <legend>Zustand</legend>
      {incidentStates.map((s) => (
        <label key={s} className="choice">
          <input type="radio" name={name} checked={value === s} onChange={() => onChange(s)} />
          <span>{INCIDENT_STATE_LABEL[s]}<small>{STATE_HINT[s]}</small></span>
        </label>
      ))}
    </fieldset>
  )
}

function Incidents({ sp }: { sp: StatusPageDto }) {
  const q = useQuery({ queryKey: ['incidents'], queryFn: api.incidents })
  const [creating, setCreating] = useState(false)
  const headId = useId()
  const list = q.data?.incidents ?? []
  const open = list.filter((i) => i.state !== 'behoben')
  return (
    <section className="field-group sp-incidents" aria-labelledby={headId}>
      <div className="panel-head">
        <h2 id={headId}>Störungen</h2>
        {!creating && <button type="button" className="button-primary" onClick={() => setCreating(true)}>Störung melden</button>}
      </div>
      <p className="hint">
        Offene Störungen stehen oben auf der Statusseite und im RSS-Feed. Ist ein Projekt auf der Seite länger als {STATUS_AUTO_DOWN_MS / 60_000} Minuten
        nicht erreichbar, meldet Airlock das selbst – und schreibt «Behoben», sobald es wieder läuft.
        {!sp.enabled && ' Die Statusseite ist aus: Störungen werden gespeichert, aber nicht veröffentlicht.'}
      </p>
      {creating && <NewIncident sp={sp} onDone={() => setCreating(false)} />}
      {!q.data && q.isError ? <ErrorState compact what="Die Störungen" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
        : !q.data ? <Loading label="Störungen werden geladen"><SkCard lines={3} title={false} /></Loading>
        : list.length === 0 ? <EmptyState compact title="Keine Störungen.">Bisher wurde nichts gemeldet.</EmptyState>
        : (
          <>
            <p className="sp-count">{open.length === 0 ? 'Keine offene Störung' : open.length === 1 ? '1 offene Störung' : `${open.length} offene Störungen`} · {list.length} insgesamt</p>
            <ol className="sp-incident-list">
              {list.map((i) => <IncidentItem key={i.id} i={i} />)}
            </ol>
          </>
        )}
    </section>
  )
}

function NewIncident({ sp, onDone }: { sp: StatusPageDto; onDone: () => void }) {
  const qc = useQueryClient()
  const name = useId()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [state, setState] = useState<IncidentState>('untersucht')
  const [projects, setProjects] = useState<string[]>([])
  const [tried, setTried] = useState(false)
  const errors = { title: title.trim() ? null : 'Bitte einen Titel eingeben', body: body.trim() ? null : 'Bitte beschreiben, was los ist' }
  const create = useMutation({
    meta: { errorTitle: 'Störung nicht gemeldet' },
    mutationFn: () => api.createIncident({ title: title.trim(), body: body.trim(), state, projectIds: projects }),
    onSuccess: (r) => {
      qc.setQueryData(['incidents'], r)
      toast.success('Störung gemeldet', { description: sp.enabled ? 'Steht jetzt oben auf der Statusseite.' : 'Gespeichert; die Statusseite ist aus.' })
      onDone()
    },
  })
  useEffect(() => { document.getElementById('sp-new-title')?.focus() }, [])
  const err = (k: keyof typeof errors) => (tried ? errors[k] ?? undefined : undefined)
  return (
    <form className="sp-form" aria-label="Störung melden" noValidate onSubmit={(e) => {
      e.preventDefault()
      setTried(true)
      if (errors.title) return document.getElementById('sp-new-title')?.focus()
      if (errors.body) return document.getElementById('sp-new-body')?.focus()
      create.mutate()
    }}>
      <Field id="sp-new-title" label="Titel" error={err('title')}>
        <input id="sp-new-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="z. B. Fotoalbum lädt langsam" aria-invalid={Boolean(err('title')) || undefined} aria-describedby={err('title') ? 'sp-new-title-error' : undefined} />
      </Field>
      <Field id="sp-new-body" label="Text" error={err('body')} hint="Was Besucher wissen sollen. Leerzeile = neuer Absatz.">
        <textarea id="sp-new-body" rows={3} value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} aria-invalid={Boolean(err('body')) || undefined} aria-describedby={err('body') ? 'sp-new-body-error' : 'sp-new-body-hint'} />
      </Field>
      <StateChoice value={state} onChange={setState} name={name} />
      {sp.projects.length > 0 && (
        <fieldset className="sp-states">
          <legend>Betroffene Projekte <span className="field-optional">(optional)</span></legend>
          <div className="sp-projects">
            {sp.projects.map((p) => (
              <label key={p.id} className="choice">
                <input type="checkbox" checked={projects.includes(p.id)} onChange={(e) => setProjects(e.target.checked ? [...projects, p.id] : projects.filter((x) => x !== p.id))} />
                <span>{p.name}{!p.shown && <small>nicht auf der Statusseite</small>}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={create.isPending} aria-busy={create.isPending || undefined}>Störung veröffentlichen</button>
        <button type="button" onClick={onDone} disabled={create.isPending}>Abbrechen</button>
      </div>
    </form>
  )
}

function IncidentItem({ i }: { i: IncidentDto }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const headId = useId()
  const remove = useMutation({
    meta: { errorTitle: 'Störung nicht gelöscht', quiet: true },
    mutationFn: () => api.deleteIncident(i.id),
    onSuccess: (r) => { qc.setQueryData(['incidents'], r); setConfirm(false); toast.success('Störung gelöscht', { description: 'Sie verschwindet auch von der Statusseite und aus dem RSS-Feed.' }) },
  })
  const hidden = i.projects.filter((p) => !p.shown)
  return (
    <li className={`sp-incident ${i.state === 'behoben' ? 'sp-incident-done' : 'sp-incident-open'}`} aria-labelledby={headId}>
      <div className="sp-incident-head">
        <h3 id={headId}>{i.title}</h3>
        <StateBadge state={i.state} />
        {i.auto && <span className="badge badge-neutral">automatisch</span>}
      </div>
      <p className="sp-meta">
        Seit {fmtDateTimeShort(i.createdAt)}{i.resolvedAt ? ` · behoben ${fmtDateTimeShort(i.resolvedAt)}` : ''}
        {i.projects.length > 0 && <> · Betrifft: {i.projects.map((p) => p.name).join(', ')}</>}
        {hidden.length > 0 && <> ({hidden.map((p) => p.name).join(', ')} nicht auf der Statusseite)</>}
      </p>
      <ol className="sp-updates" aria-label="Verlauf">
        {i.updates.map((u) => (
          <li key={u.id}>
            <p className="sp-update-head"><strong>{INCIDENT_STATE_LABEL[u.state]}</strong> <time dateTime={u.at}>{fmtDateTimeShort(u.at)}</time> <span className="muted">· {actorLabel(u.actor)}</span></p>
            <p className="sp-update-body">{u.body}</p>
          </li>
        ))}
      </ol>
      {adding ? <AddUpdate i={i} onDone={() => setAdding(false)} /> : (
        <div className="form-actions">
          <button type="button" className="button-small" onClick={() => setAdding(true)}>Update hinzufügen</button>
          <button type="button" className="button-small" onClick={() => { remove.reset(); setConfirm(true) }}>Löschen …</button>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title={<>Störung «{i.title}» löschen?</>}
        confirmLabel={remove.isPending ? 'Wird gelöscht…' : 'Ja, löschen'}
        busy={remove.isPending}
        error={remove.isError ? (remove.error as Error).message : null}
        onCancel={() => setConfirm(false)}
        onConfirm={() => remove.mutate()}
      >
        <p>Für Fehleinträge. Die Störung samt Verlauf verschwindet von der Statusseite und aus dem RSS-Feed. Wer sie im Feed schon gelesen hat, behält sie.</p>
      </ConfirmDialog>
    </li>
  )
}

function AddUpdate({ i, onDone }: { i: IncidentDto; onDone: () => void }) {
  const qc = useQueryClient()
  const name = useId()
  const id = `sp-up-${i.id}`
  const [state, setState] = useState<IncidentState>(i.state === 'untersucht' ? 'erkannt' : i.state === 'erkannt' ? 'behoben' : 'behoben')
  const [body, setBody] = useState('')
  const [tried, setTried] = useState(false)
  const error = tried && !body.trim() ? 'Bitte einen Text eingeben' : undefined
  const add = useMutation({
    meta: { errorTitle: 'Update nicht gespeichert' },
    mutationFn: () => api.addIncidentUpdate(i.id, { state, body: body.trim() }),
    onSuccess: (r) => { qc.setQueryData(['incidents'], r); toast.success(`Update: ${INCIDENT_STATE_LABEL[state]}`); onDone() },
  })
  useEffect(() => { document.getElementById(id)?.focus() }, [id])
  return (
    <form className="sp-form sp-form-inline" aria-label={`Update zu «${i.title}»`} noValidate onSubmit={(e) => {
      e.preventDefault()
      setTried(true)
      if (!body.trim()) return document.getElementById(id)?.focus()
      add.mutate()
    }}>
      <StateChoice value={state} onChange={setState} name={name} />
      <Field id={id} label="Text" error={error}>
        <textarea id={id} rows={2} value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} aria-invalid={Boolean(error) || undefined} aria-describedby={error ? `${id}-error` : undefined} />
      </Field>
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={add.isPending} aria-busy={add.isPending || undefined}>Update veröffentlichen</button>
        <button type="button" onClick={onDone} disabled={add.isPending}>Abbrechen</button>
      </div>
    </form>
  )
}

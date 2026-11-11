import { useEffect, useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { publicNameFormSchema, publicStateOf, type ProjectDto, type PublicProgressDto, type PublicState, type PublicStatusDto, type PausePage, type PauseOptions } from '@airlock/shared'
import { toast } from 'sonner'
import { PausePageDialog, pageKind } from './PausePageEditor.js'
import { api } from '../api.js'
import { poll } from '../lib/live.js'
import { useFormErrors } from '../lib/form.js'
import { useUnsaved } from '../lib/unsaved.js'
import { usePublicActions } from '../lib/public.js'
import { relativeTime } from '../lib/format.js'
import { ageMs, fmtDate, fmtDateTime, fmtDateTimeMedium, fmtTime, msOf, sameDay } from '../lib/dates.js'
import { ErrorState, Loading, SkLines } from './States.js'
import { Field } from './Field.js'
import { IconExternal, IconGlobe, IconLock, IconPause, IconWarn } from './Icons.js'
import { Switch } from './Switch.js'

const STATE_LABEL: Record<PublicState, string> = { private: 'Privat', live: 'Öffentlich', paused: 'Pausiert' }

/** Zustand der Veröffentlichung als Pille: Zeichen UND Wort, nie nur Farbe. */
export function PublicPill({ state, className = '' }: { state: PublicState; className?: string }) {
  const Icon = state === 'live' ? IconGlobe : state === 'paused' ? IconPause : IconLock
  return (
    <span className={`chip chip-pub-${state} ${className}`.trim()}>
      <Icon size={12} />
      {STATE_LABEL[state]}
    </span>
  )
}

/** Pille für den Projektkopf und die Projektkarte; privat zeigt nichts. */
export function PublicPillFor({ p }: { p: ProjectDto }) {
  const s = publicStateOf(p.routes)
  return s === 'private' ? null : <PublicPill state={s} />
}

const when = (iso: string | null) => fmtDateTimeMedium(iso)

/** Seit wann, kurz: heute die Uhrzeit, sonst das Datum */
const sinceShort = (iso: string | null) => {
  if (msOf(iso) === null) return ''
  return sameDay(iso, new Date()) ? fmtTime(iso) : fmtDate(iso)
}

/** Status-Pille im Kopf: «Öffentlich seit 19:21», «Pausiert seit …», «Privat» */
function StatePill({ s }: { s: PublicStatusDto }) {
  const Icon = s.state === 'live' ? IconGlobe : s.state === 'paused' ? IconPause : IconLock
  const when = s.state === 'private' ? '' : sinceShort(s.since)
  return (
    <span className={`chip chip-pub-${s.state} set-state`} title={fmtDateTime(s.since, '') || undefined}>
      <Icon size={12} />{STATE_LABEL[s.state]}{when ? ` seit ${when}` : ''}
    </span>
  )
}

/**
 * Karte «Veröffentlichung» (Projekt → Einstellungen), kompakte Zeilen:
 * Kopf mit Status-Pille und der Hauptaktion rechts («Offline nehmen»,
 * «Wieder online», «Veröffentlichen»), darunter Adresse (Ändern),
 * Cloudflare Access (Schalter mit Rückfrage) und Pause-Seite (Anpassen).
 * Alles ist sofort wirksam; der Fortschritt steht in der Karte, ein Toast
 * bietet «Rückgängig».
 */
export function Publication({ p }: { p: ProjectDto }) {
  const q = useQuery({ queryKey: ['public', p.id], queryFn: () => api.publicStatus(p.id), refetchInterval: poll })
  const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
  const actions = usePublicActions(p)
  const titleId = useId()
  const s = q.data
  const defaultZone = domains.data?.domains.find((d) => d.isDefault)?.name ?? null

  return (
    <section className="set-card publication" id="set-veroeffentlichung" aria-labelledby={titleId}>
      {!s && (
        <div className="set-head"><h2 id={titleId}>Veröffentlichung</h2></div>
      )}
      {!s && !q.isError && <Loading label="Veröffentlichung wird geladen" className="set-row-note"><SkLines n={2} /></Loading>}
      {!s && q.isError && <div className="set-row-note"><ErrorState compact what="Der Zustand der Veröffentlichung" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} /></div>}

      {s && (
        <>
          {s.state === 'private' && <PrivateState p={p} s={s} actions={actions} defaultZone={defaultZone} titleId={titleId} />}
          {s.state === 'live' && <LiveState p={p} s={s} actions={actions} defaultZone={defaultZone} titleId={titleId} />}
          {s.state === 'paused' && <PausedState p={p} s={s} actions={actions} defaultZone={defaultZone} titleId={titleId} />}

          {/* Platz für eine vorgemerkte Öffentlich-Anfrage (etwa von MCP), die nach dem Scan wirksam wird */}
          {s.pendingRequest && <div className="set-row-block"><PendingRequest p={p} s={s} /></div>}
          <div className="set-row-block set-row-block-quiet"><ProgressSteps live={actions.progress} last={s.progress} pending={actions.pending} /></div>
        </>
      )}
    </section>
  )
}

function Head({ titleId, s, children }: { titleId: string; s: PublicStatusDto; children?: React.ReactNode }) {
  return (
    <div className="set-head">
      <h2 id={titleId} tabIndex={-1}>Veröffentlichung</h2>
      <StatePill s={s} />
      {children && <div className="set-head-actions">{children}</div>}
    </div>
  )
}

/** Eine Zeile: Beschriftung · Wert · Aktion rechts */
export function SetRow({ label, children, action, id }: { label: React.ReactNode; children: React.ReactNode; action?: React.ReactNode; id?: string }) {
  return (
    <div className="set-row">
      <div className="set-row-label" id={id}>{label}</div>
      <div className="set-row-value">{children}</div>
      {action !== undefined && <div className="set-row-action">{action}</div>}
    </div>
  )
}

type Actions = ReturnType<typeof usePublicActions>

/* --- Vorgemerkte Anfrage ------------------------------------------------------------- */

const REQUEST_HEAD: Record<NonNullable<PublicStatusDto['pendingRequest']>['state'], string> = {
  waiting: 'Öffentlich-Anfrage vorgemerkt',
  blocked: 'Öffentlich-Anfrage gesperrt',
  ready: 'Öffentlich-Anfrage: Scan bestanden',
  failed: 'Öffentlich-Anfrage gescheitert',
}

/**
 * Eine Anfrage (etwa per MCP), die wegen der Schwelle noch nicht wirksam
 * ist. Wird nie still ausgeführt: «Nach dem Scan öffentlich schalten»
 * bestätigt sie; ist der Scan schon bestanden, geht sie damit sofort live.
 */
function PendingRequest({ p, s }: { p: ProjectDto; s: PublicStatusDto }) {
  const r = s.pendingRequest!
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['public', p.id] }),
    qc.invalidateQueries({ queryKey: ['project', p.id] }),
    qc.invalidateQueries({ queryKey: ['projects'] }),
  ])
  const approve = useMutation({
    mutationFn: () => api.approvePublicRequest(p.id),
    onSuccess: () => { setConfirming(false); void refresh() },
  })
  const discard = useMutation({ mutationFn: () => api.discardPublicRequest(p.id), onSuccess: () => void refresh() })
  const busy = approve.isPending || discard.isPending
  const now = r.state === 'ready' || r.state === 'failed'
  const label = r.state === 'failed' ? 'Erneut versuchen' : now ? 'Jetzt öffentlich schalten' : 'Nach dem Scan öffentlich schalten'

  return (
    <div className={`publication-pending publication-pending-${r.state}`} role="note">
      <div className="publication-pending-text">
        {r.state === 'blocked' || r.state === 'failed' ? <IconWarn /> : <IconGlobe size={14} />}
        <span>
          <strong>{REQUEST_HEAD[r.state]}</strong>
          <span className="publication-pending-detail">{r.text}</span>
          {r.hostname && <span className="publication-pending-detail">Name: <code>{r.hostname}</code>{r.accessProtected ? ' · hinter Cloudflare Access' : ''}</span>}
        </span>
      </div>
      {!r.approvedBy || r.state === 'failed' ? (
        !confirming ? (
          <div className="publication-pending-actions">
            <button type="button" className="button-small" onClick={() => setConfirming(true)} disabled={busy}>{label}</button>
            <button type="button" className="button-small button-ghost" onClick={() => discard.mutate()} disabled={busy}>Anfrage verwerfen</button>
          </div>
        ) : (
          <div className="confirm-inline" role="group" aria-label="Öffentlich-Anfrage bestätigen">
            <span className="confirm-note">
              <IconWarn /> {now
                ? <>«{p.name}» wird jetzt für alle im Internet erreichbar.</>
                : <>«{p.name}» wird nach dem nächsten Scan ohne kritischen Befund automatisch für alle im Internet erreichbar.</>}
              {' '}<InternalNote s={s} />
            </span>
            <button type="button" className="button-small" onClick={() => setConfirming(false)}>Abbrechen</button>
            <button type="button" className="button-small button-primary" onClick={() => approve.mutate()} disabled={busy} aria-busy={approve.isPending || undefined} autoFocus>
              {now ? 'Ja, veröffentlichen' : 'Ja, nach dem Scan'}
            </button>
          </div>
        )
      ) : (
        <div className="publication-pending-actions">
          <span className="hint">Bestätigt von {r.approvedBy} {relativeTime(r.approvedAt)}.</span>
          <button type="button" className="button-small button-ghost" onClick={() => discard.mutate()} disabled={busy}>Anfrage verwerfen</button>
        </div>
      )}
    </div>
  )
}

/** Grund, warum gerade nicht veröffentlicht werden kann – mit Zeichen und Wort. */
function Blocked({ s, id }: { s: PublicStatusDto; id: string }) {
  if (s.publishable.ok) return null
  const head = s.publishable.why === 'scan_running' ? 'Scan läuft' : s.publishable.why === 'critical' ? 'Gesperrt' : s.publishable.why === 'no_scan' ? 'Noch kein Scan' : 'Nicht eingerichtet'
  return (
    <p className="publication-blocked" id={id}>
      <IconWarn /> <span><strong>{head}:</strong> {s.publishable.reason}</span>
    </p>
  )
}

function InternalNote({ s }: { s: PublicStatusDto }) {
  if (!s.internalUrl) return <>Eine interne Adresse hat das Projekt nicht.</>
  return <>Intern bleibt es unter <a href={s.internalUrl} target="_blank" rel="noreferrer">{s.internalUrl.replace(/^https?:\/\//, '')}</a> erreichbar.</>
}

/* --- Privat ------------------------------------------------------------------------ */

function PrivateState({ p, s, actions, defaultZone, titleId }: { p: ProjectDto; s: PublicStatusDto; actions: Actions; defaultZone: string | null; titleId: string }) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [name, setName] = useState('')
  const [access, setAccess] = useState(false)
  const blockedId = useId()
  const v = useFormErrors({ schema: publicNameFormSchema, values: () => ({ name }) })
  const start = () => {
    if (!open) { setOpen(true); requestAnimationFrame(() => document.getElementById(v.idFor('name'))?.focus()); return }
    // Erst prüfen, dann fragen – bestätigt wird nur, was auch gehen kann.
    if (v.validateAll()) setConfirming(true)
  }

  // Was nur der Server prüfen kann (Zone des Kontos, belegt, fremder DNS-Eintrag), steht am Namensfeld.
  const err = actions.error
  useEffect(() => {
    if (err && (err.status === 400 || err.status === 409) && !['not_publishable', 'public_disabled'].includes(err.code) && !/läuft schon/.test(err.message)) {
      setOpen(true)
      v.setErrors({ name: err.message })
      requestAnimationFrame(() => document.getElementById(v.idFor('name'))?.focus())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [err])

  const target = (() => {
    const n = name.trim().toLowerCase()
    if (n.includes('.')) return n
    return defaultZone ? `${n || p.slug}.${defaultZone}` : null
  })()

  return (
    <>
      <Head titleId={titleId} s={s}>
        {!open && (
          <button className="button-primary button-small" disabled={!s.publishable.ok || actions.pending} aria-busy={(actions.pending && actions.current?.op === 'publish') || undefined} aria-describedby={!s.publishable.ok ? blockedId : undefined} onClick={start}>
            Veröffentlichen
          </button>
        )}
      </Head>
      <SetRow label="Erreichbar">
        {s.internalUrl
          ? <>nur intern unter <a href={s.internalUrl} target="_blank" rel="noreferrer">{s.internalUrl.replace(/^https?:\/\//, '')}</a> <span className="muted">· Veröffentlichen macht es über Cloudflare Tunnel im Internet sichtbar</span></>
          : <span className="muted">nirgends: weder intern noch öffentlich</span>}
      </SetRow>
      {!s.publishable.ok && <div className="set-row-block"><Blocked s={s} id={blockedId} /></div>}

      {open && s.enabled && (
        <div className="public-options set-row-block">
          <Field id={v.idFor('name')} label="Öffentlicher Name" optional error={v.errors.name}
            hint={<>Nur die Subdomain ({defaultZone ? <>wird zu <code>…{'.'}{defaultZone}</code></> : 'keine Standard-Domain gesetzt'}) oder ein voller Name in einer Zone des Kontos. Leer = <code>{p.slug}</code>.</>}>
            <input
              {...v.field('name', `${v.idFor('name')}-hint`)}
              value={name}
              placeholder={defaultZone ? `${p.slug}.${defaultZone}` : 'name.deinedomain.ch'}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => { setName(e.target.value); setConfirming(false) }}
            />
          </Field>
          <label className="choice">
            <input type="checkbox" checked={access} onChange={(e) => { setAccess(e.target.checked); setConfirming(false) }} />
            <span>Cloudflare Access <small>nur nach Login per E-Mail-Code</small></span>
          </label>
        </div>
      )}

      {open && (
      <div className="form-actions publication-actions set-row-block">
        {!confirming && (
          <button className="button-primary" disabled={!s.publishable.ok || actions.pending} aria-busy={(actions.pending && actions.current?.op === 'publish') || undefined} aria-describedby={!s.publishable.ok ? blockedId : undefined} onClick={start}>
            Veröffentlichen
          </button>
        )}
        {!confirming && <button onClick={() => { setOpen(false); v.reset() }} disabled={actions.pending}>Abbrechen</button>}
        {confirming && (
          <span className="confirm-inline publication-confirm" role="group" aria-label="Veröffentlichen bestätigen">
            <span className="confirm-note">
              <IconWarn />
              <span>
                «{p.name}» wird {target ? <>unter <code>{target}</code> </> : ''}für alle im Internet erreichbar{access ? ', nach Login per E-Mail-Code' : ', ohne Login'}. <InternalNote s={s} />
              </span>
            </span>
            <button onClick={() => setConfirming(false)}>Abbrechen</button>
            <button className="button-danger-solid" autoFocus disabled={actions.pending}
              onClick={() => { setConfirming(false); actions.run({ op: 'publish', name, access }) }}>
              Ja, veröffentlichen
            </button>
          </span>
        )}
      </div>
      )}
    </>
  )
}

/* --- Öffentlich -------------------------------------------------------------------- */

/** Adresse mit «Ändern»: neuer Name (Subdomain oder voll), sofort wirksam, Toast mit «Rückgängig» */
function AddressRow({ p, s, actions, paused, defaultZone }: { p: ProjectDto; s: PublicStatusDto; actions: Actions; paused: boolean; defaultZone: string | null }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const v = useFormErrors({ schema: publicNameFormSchema, values: () => ({ name }) })
  const err = actions.error
  useEffect(() => {
    if (editing && err && (err.status === 400 || err.status === 409)) {
      v.setErrors({ name: err.message })
      requestAnimationFrame(() => document.getElementById(v.idFor('name'))?.focus())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [err])
  const renaming = actions.pending && actions.current?.op === 'rename'
  // UI-Qualität 8: neue Adresse eingetippt, aber nicht übernommen → Rückfrage beim Verlassen
  useUnsaved(editing && name.trim() !== (s.hostname ?? ''), 'neue öffentliche Adresse')
  return (
    <>
      <SetRow
        label="Adresse"
        action={!editing ? <button type="button" className="button-small" onClick={() => { setEditing(true); setName(s.hostname ?? ''); requestAnimationFrame(() => (document.getElementById(v.idFor('name')) as HTMLInputElement | null)?.select()) }} disabled={actions.pending}>Ändern</button> : undefined}
      >
        <a href={s.url!} target="_blank" rel="noreferrer" className="publication-url">{s.hostname} <IconExternal /></a>
        {paused && <span className="muted"> · zeigt die Pause-Seite (HTTP 503)</span>}
      </SetRow>
      {editing && (
        <form
          className="set-row-block set-inline-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            if (!v.validateAll()) return
            const n = name.trim().toLowerCase()
            if (!n || n === s.hostname) { setEditing(false); return }
            actions.run({ op: 'rename', name: n, access: s.accessProtected, before: s.hostname! })
            setEditing(false)
          }}
        >
          <Field id={v.idFor('name')} label="Neue öffentliche Adresse" error={v.errors.name}
            hint={<>Subdomain ({defaultZone ? <>wird zu <code>…{'.'}{defaultZone}</code></> : 'keine Standard-Domain gesetzt'}) oder ein voller Name in einer Zone des Kontos. Der alte Name wird frei.</>}>
            <input {...v.field('name', `${v.idFor('name')}-hint`)} value={name} spellCheck={false} autoComplete="off" onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="confirm-inline">
            <button type="button" onClick={() => { setEditing(false); v.reset() }}>Abbrechen</button>
            <button type="submit" className="button-primary" disabled={renaming} aria-busy={renaming || undefined}>Adresse ändern</button>
          </div>
        </form>
      )}
    </>
  )
}

/**
 * Cloudflare Access als Schalter. Einschalten fragt zurück (Besucher brauchen
 * danach einen Login), Ausschalten auch (die Seite ist dann für alle offen).
 */
function AccessRow({ s, actions }: { s: PublicStatusDto; actions: Actions }) {
  const [confirm, setConfirm] = useState<boolean | null>(null)
  const labelId = useId()
  const busy = actions.pending && actions.current?.op === 'access'
  return (
    <>
      <SetRow
        label={<span id={labelId}>Cloudflare Access</span>}
        action={<Switch checked={confirm ?? s.accessProtected} labelledBy={labelId} busy={busy} disabled={actions.pending && !busy} onChange={(next) => setConfirm(next)} />}
      >
        {s.accessProtected ? <><strong className="set-strong">An</strong> <span className="muted">· nur nach Login per E-Mail-Code</span></> : <><strong className="set-strong">Aus</strong> <span className="muted">· jeder kann die Seite öffnen</span></>}
      </SetRow>
      {confirm !== null && (
        <div className="set-row-block">
          <span className="confirm-inline" role="group" aria-label={confirm ? 'Access einschalten bestätigen' : 'Access ausschalten bestätigen'}>
            <span className="confirm-note"><IconWarn /> <span>{confirm ? `${s.hostname} verlangt danach einen Login per E-Mail-Code; wer keinen Zugang hat, sieht die Seite nicht mehr.` : `${s.hostname} ist danach ohne Login für alle erreichbar.`}</span></span>
            <button type="button" onClick={() => setConfirm(null)}>Abbrechen</button>
            <button type="button" className={confirm ? 'button-primary' : 'button-danger-solid'} autoFocus disabled={actions.pending}
              onClick={() => { actions.run({ op: 'access', access: confirm }); setConfirm(null) }}>
              {confirm ? 'Ja, Access einschalten' : 'Ja, ohne Login'}
            </button>
          </span>
        </div>
      )}
    </>
  )
}

/**
 * Pause-Seite des Projekts – auch einstellbar, solange es live ist (gilt dann
 * beim nächsten Pausieren). «Voraussichtlich zurück» nur während der Pause.
 * Gespeichert wird sofort; pausiert sehen Besucher die Änderung gleich.
 */
function PausePageRow({ p, s, paused }: { p: ProjectDto; s: PublicStatusDto; paused: boolean }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const save = useMutation({
    // Der Dialog zeigt den Fehler selbst
    meta: { quiet: true },
    mutationFn: (r: { page: PausePage | null; backAt: string | null }) => api.putPausePage(p.id, paused ? r : { page: r.page }),
    onSuccess: (r) => {
      qc.setQueryData(['public', p.id], r.status)
      setOpen(false)
      toast.success('Pause-Seite gespeichert', { description: paused ? `Besucher von ${s.hostname} sehen sie sofort.` : 'Sie erscheint, sobald das Projekt pausiert wird.' })
    },
  })
  return (
    <SetRow label="Pause-Seite" action={<button type="button" className="button-small" onClick={() => setOpen(true)}>Anpassen</button>}>
      «{(s.pause.page ?? s.pause.template).title}» <span className="muted">· {pageKind(s.pause.page)}{paused && s.pause.backAt ? ` · zurück ${when(s.pause.backAt)}` : ''}</span>
      <PausePageDialog open={open} title={`Pause-Seite für «${p.name}»`} initial={s.pause.page} template={s.pause.template} initialBackAt={s.pause.backAt}
        withBackAt={paused} saveLabel={paused ? 'Speichern – wirkt sofort' : 'Speichern'}
        note={paused ? undefined : 'Besucher sehen diese Seite erst, wenn das Projekt pausiert ist.'}
        saving={save.isPending} error={save.isError ? (save.error as Error).message : null}
        onCancel={() => { setOpen(false); save.reset() }} onSave={(r) => save.mutate(r)} />
    </SetRow>
  )
}

type OfflineMode = 'pause' | 'unpublish'

/** Eine Zeile: welche Pause-Seite Besucher sehen, mit «Anpassen …». */
function PausePageSummary({ page, template, backAt, onEdit }: { page: PausePage | null; template: PausePage; backAt: string | null; onEdit: () => void }) {
  return (
    <div className="pause-summary">
      <span className="pause-summary-text">
        <span className="pause-summary-label">Pause-Seite</span>
        «{(page ?? template).title}» <span className="muted">· {pageKind(page)}{backAt ? ` · zurück ${when(backAt)}` : ''}</span>
      </span>
      <button type="button" className="button-small" onClick={onEdit}>Anpassen</button>
    </div>
  )
}

/** Rückfrage «Offline nehmen» mit Wahl zwischen Pausieren und ganz offline. */
export function OfflineConfirm({ s, name, busy, onCancel, onGo, only }: {
  s: PublicStatusDto; name: string; busy: boolean; onCancel: () => void; onGo: (m: OfflineMode, opts?: PauseOptions) => void; only?: OfflineMode
}) {
  const [mode, setMode] = useState<OfflineMode>(only ?? 'pause')
  const group = useId()
  // Pause-Seite für diesen Lauf: vorbelegt mit der des Projekts, angepasst im Dialog
  const [draft, setDraft] = useState<{ page: PausePage | null; backAt: string | null }>({ page: s.pause.page, backAt: s.pause.backAt })
  const [dialog, setDialog] = useState(false)
  return (
    <div className="publication-offline" role="group" aria-label="Offline nehmen bestätigen">
      {!only && (
        <div className="publication-modes" role="radiogroup" aria-label="Wie offline nehmen?">
          <label className="choice">
            <input type="radio" name={group} checked={mode === 'pause'} onChange={() => setMode('pause')} />
            <span>Pausieren <small>Besucher sehen die Pause-Seite (HTTP 503). Name, DNS-Eintrag und Tunnel-Regel bleiben – «Wieder online» geht mit einem Klick.</small></span>
          </label>
          <label className="choice">
            <input type="radio" name={group} checked={mode === 'unpublish'} onChange={() => setMode('unpublish')} />
            <span>Ganz offline nehmen <small>Tunnel-Regel und DNS-Eintrag werden entfernt{s.accessProtected ? ', ebenso die Access-App' : ''}. Der Name {s.hostname} ist danach frei.</small></span>
          </label>
        </div>
      )}
      {mode === 'pause' && (
        <>
          <PausePageSummary page={draft.page} template={s.pause.template} backAt={draft.backAt} onEdit={() => setDialog(true)} />
          <PausePageDialog open={dialog} title={`Pause-Seite für «${name}»`} initial={draft.page} template={s.pause.template} initialBackAt={draft.backAt}
            saveLabel="Übernehmen" onCancel={() => setDialog(false)} onSave={(r) => { setDraft(r); setDialog(false) }} />
        </>
      )}
      <p className="confirm-note publication-offline-note">
        <IconWarn />
        <span>
          {mode === 'pause' ? <>«{name}» ist unter {s.hostname} nicht mehr zu sehen.</> : <>«{name}» verliert den Namen {s.hostname}.</>} <InternalNote s={s} />
        </span>
      </p>
      <span className="confirm-inline">
        <button onClick={onCancel}>Abbrechen</button>
        <button className="button-danger-solid" disabled={busy} onClick={() => (mode === 'pause' ? onGo(mode, draft) : onGo(mode))}>
          {mode === 'pause' ? 'Ja, pausieren' : 'Ja, ganz offline nehmen'}
        </button>
      </span>
    </div>
  )
}

function LiveState({ p, s, actions, defaultZone, titleId }: { p: ProjectDto; s: PublicStatusDto; actions: Actions; defaultZone: string | null; titleId: string }) {
  const [offline, setOffline] = useState(false)
  return (
    <>
      <Head titleId={titleId} s={s}>
        {!offline && (
          <button className="button-small" onClick={() => setOffline(true)} disabled={actions.pending} aria-busy={(actions.pending && (actions.current?.op === 'pause' || actions.current?.op === 'unpublish')) || undefined}>
            Offline nehmen
          </button>
        )}
      </Head>
      {offline && (
        <div className="set-row-block">
          <OfflineConfirm s={s} name={p.name} busy={actions.pending} onCancel={() => setOffline(false)}
            onGo={(m, opts) => { setOffline(false); actions.run(m === 'pause' ? { op: 'pause', opts } : { op: m }) }} />
        </div>
      )}
      <AddressRow p={p} s={s} actions={actions} paused={false} defaultZone={defaultZone} />
      <AccessRow s={s} actions={actions} />
      <PausePageRow p={p} s={s} paused={false} />
    </>
  )
}

/* --- Pausiert ---------------------------------------------------------------------- */

function PausedState({ p, s, actions, defaultZone, titleId }: { p: ProjectDto; s: PublicStatusDto; actions: Actions; defaultZone: string | null; titleId: string }) {
  const [offline, setOffline] = useState(false)
  const blockedId = useId()
  return (
    <>
      <Head titleId={titleId} s={s}>
        <button className="button-primary button-small" disabled={!s.publishable.ok || actions.pending} aria-describedby={!s.publishable.ok ? blockedId : undefined}
          aria-busy={(actions.pending && actions.current?.op === 'resume') || undefined}
          onClick={() => actions.run({ op: 'resume' })}>
          Wieder online
        </button>
      </Head>
      {!s.publishable.ok && <div className="set-row-block"><Blocked s={s} id={blockedId} /></div>}
      <AddressRow p={p} s={s} actions={actions} paused defaultZone={defaultZone} />
      <AccessRow s={s} actions={actions} />
      <PausePageRow p={p} s={s} paused />
      <SetRow label="Ganz offline" action={!offline ? <button type="button" className="button-small" onClick={() => setOffline(true)} disabled={actions.pending}>Ganz offline nehmen</button> : undefined}>
        <span className="muted">Name, DNS-Eintrag und Tunnel-Regel entfernen; intern bleibt das Projekt erreichbar</span>
      </SetRow>
      {offline && (
        <div className="set-row-block">
          <OfflineConfirm s={s} name={p.name} busy={actions.pending} only="unpublish" onCancel={() => setOffline(false)}
            onGo={() => { setOffline(false); actions.run({ op: 'unpublish' }) }} />
        </div>
      )}
    </>
  )
}

/* --- Fortschritt -------------------------------------------------------------------- */

const STEP_WORD: Record<string, string> = { todo: 'offen', current: 'läuft', done: 'erledigt', failed: 'fehlgeschlagen', warn: 'Warnung', skipped: 'übersprungen' }

/**
 * Schritte live, solange der Aufruf läuft; danach bleibt der letzte Lauf
 * stehen, wenn er scheiterte oder eine Warnung hatte (sonst sagt es der Toast).
 */
function ProgressSteps({ live, last, pending }: { live: PublicProgressDto | null; last: PublicProgressDto | null; pending: boolean }) {
  const recent = last && (ageMs(last.finishedAt) ?? Infinity) < 10 * 60_000
  const show = pending ? live : recent && (last.ok === false || last.steps.some((x) => x.state === 'warn')) ? last : null
  if (!show) return pending ? <p className="hint" role="status">Wird ausgeführt…</p> : null
  const notes = show.steps.filter((x) => x.detail && (x.state === 'warn' || x.state === 'failed'))
  return (
    <div className="publication-progress" role="status" aria-live="polite">
      <ol className="steps">
        {show.steps.map((x) => (
          <li key={x.key} className={`step step-${x.state}`} aria-current={x.state === 'current' ? 'step' : undefined} title={x.detail}>
            {x.label}<span className="sr-only"> – {STEP_WORD[x.state]}</span>
          </li>
        ))}
      </ol>
      {notes.length > 0 && (
        <ul className="publication-notes">
          {notes.map((x) => <li key={x.key} className={x.state === 'failed' ? 'publication-note-failed' : 'publication-note-warn'}><IconWarn /> <span><strong>{x.label}:</strong> {x.detail}</span></li>)}
        </ul>
      )}
    </div>
  )
}

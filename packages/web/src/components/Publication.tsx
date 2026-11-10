import { useEffect, useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { publicNameFormSchema, publicStateOf, type ProjectDto, type PublicProgressDto, type PublicState, type PublicStatusDto } from '@deployer/shared'
import { api } from '../api.js'
import { useFormErrors } from '../lib/form.js'
import { usePublicActions } from '../lib/public.js'
import { relativeTime } from '../lib/format.js'
import { Field } from './Field.js'
import { IconExternal, IconGlobe, IconLock, IconPause, IconWarn } from './Icons.js'

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

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' }) : '–')

/**
 * Karte «Veröffentlichung» (Projekt → Einstellungen). Drei Zustände:
 * Privat (Knopf «Veröffentlichen …»), Öffentlich (Adresse, seit, Access,
 * «Offline nehmen …») und Pausiert («Wieder online»). Veröffentlichen und
 * Offline nehmen fragen zurück; danach ist alles sofort wirksam, der
 * Fortschritt steht in der Karte und ein Toast bietet «Rückgängig».
 */
export function Publication({ p }: { p: ProjectDto }) {
  const q = useQuery({ queryKey: ['public', p.id], queryFn: () => api.publicStatus(p.id), refetchInterval: 10_000 })
  const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
  const actions = usePublicActions(p)
  const titleId = useId()
  const s = q.data

  return (
    <section className="field-group publication" aria-labelledby={titleId}>
      <div className="publication-head">
        <h2 id={titleId}>Veröffentlichung</h2>
        {s && <PublicPill state={s.state} />}
      </div>

      {q.isLoading && <p className="hint">Wird geladen…</p>}
      {q.isError && <p role="alert" className="error">Zustand der Veröffentlichung nicht abrufbar.</p>}

      {s && (
        <>
          {/* Platz für eine vorgemerkte Öffentlich-Anfrage (etwa von MCP), die nach dem Scan wirksam wird */}
          {s.pendingRequest && <PendingRequest s={s} />}

          {s.state === 'private' && <PrivateState p={p} s={s} actions={actions} defaultZone={domains.data?.domains.find((d) => d.isDefault)?.name ?? null} />}
          {s.state === 'live' && <LiveState p={p} s={s} actions={actions} />}
          {s.state === 'paused' && <PausedState p={p} s={s} actions={actions} />}

          <ProgressSteps live={actions.progress} last={s.progress} pending={actions.pending} />
        </>
      )}
    </section>
  )
}

type Actions = ReturnType<typeof usePublicActions>

/* --- Vorgemerkte Anfrage (Platzhalter) --------------------------------------------- */

function PendingRequest({ s }: { s: PublicStatusDto }) {
  const r = s.pendingRequest!
  return (
    <div className="publication-pending" role="note">
      <IconGlobe size={14} />
      <span>
        <strong>Öffentlich-Anfrage vorgemerkt</strong> von {r.actor} ({relativeTime(r.requestedAt)}){r.hostname ? <> für <code>{r.hostname}</code></> : null}.
        {' '}Sie wird erst wirksam, wenn du sie nach dem Scan bestätigst.
      </span>
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

function PrivateState({ p, s, actions, defaultZone }: { p: ProjectDto; s: PublicStatusDto; actions: Actions; defaultZone: string | null }) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [name, setName] = useState('')
  const [access, setAccess] = useState(false)
  const blockedId = useId()
  const v = useFormErrors({ schema: publicNameFormSchema, values: () => ({ name }) })

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
      <p className="publication-lede">
        {s.internalUrl
          ? <>Nur intern erreichbar unter <a href={s.internalUrl} target="_blank" rel="noreferrer">{s.internalUrl.replace(/^https?:\/\//, '')}</a>. Veröffentlichen macht das Projekt über Cloudflare Tunnel im Internet sichtbar.</>
          : <>Nirgends erreichbar: weder intern noch öffentlich.</>}
      </p>
      <Blocked s={s} id={blockedId} />

      {open && s.enabled && (
        <div className="public-options">
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

      <div className="form-actions publication-actions">
        {!confirming && (
          <button
            className="button-primary"
            disabled={!s.publishable.ok || actions.pending}
            aria-describedby={!s.publishable.ok ? blockedId : undefined}
            onClick={() => {
              if (!open) { setOpen(true); requestAnimationFrame(() => document.getElementById(v.idFor('name'))?.focus()); return }
              // Erst prüfen, dann fragen – bestätigt wird nur, was auch gehen kann.
              if (v.validateAll()) setConfirming(true)
            }}
          >
            {actions.pending && actions.current?.op === 'publish' ? 'Wird veröffentlicht…' : 'Veröffentlichen …'}
          </button>
        )}
        {open && !confirming && <button onClick={() => { setOpen(false); v.reset() }} disabled={actions.pending}>Abbrechen</button>}
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
    </>
  )
}

/* --- Öffentlich -------------------------------------------------------------------- */

function Facts({ s, paused }: { s: PublicStatusDto; paused: boolean }) {
  return (
    <dl className="facts publication-facts">
      <dt>Adresse</dt>
      <dd>
        <a href={s.url!} target="_blank" rel="noreferrer" className="publication-url">{s.hostname} <IconExternal /></a>
        {paused && <span className="muted"> · zeigt die Wartungsseite (HTTP 503)</span>}
      </dd>
      <dt>{paused ? 'Pausiert seit' : 'Öffentlich seit'}</dt>
      <dd>{when(s.since)} <span className="muted">· {relativeTime(s.since)}</span></dd>
      <dt>Cloudflare Access</dt>
      <dd>{s.accessProtected ? <>An <span className="muted">· Login per E-Mail-Code</span></> : <>Aus <span className="muted">· ohne Login</span></>}</dd>
      <dt>Intern</dt>
      <dd>{s.internalUrl ? <a href={s.internalUrl} target="_blank" rel="noreferrer">{s.internalUrl.replace(/^https?:\/\//, '')}</a> : <span className="muted">keine interne Adresse</span>}</dd>
    </dl>
  )
}

type OfflineMode = 'pause' | 'unpublish'

/** Rückfrage «Offline nehmen» mit Wahl zwischen Pausieren und ganz offline. */
export function OfflineConfirm({ s, name, busy, onCancel, onGo, only }: {
  s: PublicStatusDto; name: string; busy: boolean; onCancel: () => void; onGo: (m: OfflineMode) => void; only?: OfflineMode
}) {
  const [mode, setMode] = useState<OfflineMode>(only ?? 'pause')
  const group = useId()
  return (
    <div className="publication-offline" role="group" aria-label="Offline nehmen bestätigen">
      {!only && (
        <div className="publication-modes" role="radiogroup" aria-label="Wie offline nehmen?">
          <label className="choice">
            <input type="radio" name={group} checked={mode === 'pause'} onChange={() => setMode('pause')} />
            <span>Pausieren <small>Besucher sehen eine neutrale Wartungsseite (HTTP 503). Name, DNS-Eintrag und Tunnel-Regel bleiben – «Wieder online» geht mit einem Klick.</small></span>
          </label>
          <label className="choice">
            <input type="radio" name={group} checked={mode === 'unpublish'} onChange={() => setMode('unpublish')} />
            <span>Ganz offline nehmen <small>Tunnel-Regel und DNS-Eintrag werden entfernt{s.accessProtected ? ', ebenso die Access-App' : ''}. Der Name {s.hostname} ist danach frei.</small></span>
          </label>
        </div>
      )}
      <p className="confirm-note publication-offline-note">
        <IconWarn />
        <span>
          {mode === 'pause' ? <>«{name}» ist unter {s.hostname} nicht mehr zu sehen.</> : <>«{name}» verliert den Namen {s.hostname}.</>} <InternalNote s={s} />
        </span>
      </p>
      <span className="confirm-inline">
        <button onClick={onCancel}>Abbrechen</button>
        <button className="button-danger-solid" autoFocus disabled={busy} onClick={() => onGo(mode)}>
          {mode === 'pause' ? 'Ja, pausieren' : 'Ja, ganz offline nehmen'}
        </button>
      </span>
    </div>
  )
}

function LiveState({ p, s, actions }: { p: ProjectDto; s: PublicStatusDto; actions: Actions }) {
  const [offline, setOffline] = useState(false)
  const [accessConfirm, setAccessConfirm] = useState(false)
  return (
    <>
      <Facts s={s} paused={false} />
      <div className="form-actions publication-actions">
        {!offline && !accessConfirm && (
          <>
            <button onClick={() => setOffline(true)} disabled={actions.pending}>
              {actions.pending && (actions.current?.op === 'pause' || actions.current?.op === 'unpublish') ? 'Wird offline genommen…' : 'Offline nehmen …'}
            </button>
            {/* Access ausschalten öffnet für alle: Rückfrage. Einschalten schützt nur: sofort. */}
            <button onClick={() => (s.accessProtected ? setAccessConfirm(true) : actions.run({ op: 'access', access: true }))} disabled={actions.pending}>
              {s.accessProtected ? 'Access ausschalten …' : 'Access einschalten'}
            </button>
          </>
        )}
        {accessConfirm && (
          <span className="confirm-inline" role="group" aria-label="Access ausschalten bestätigen">
            <span className="confirm-note"><IconWarn /> <span>{s.hostname} ist danach ohne Login für alle erreichbar.</span></span>
            <button onClick={() => setAccessConfirm(false)}>Abbrechen</button>
            <button className="button-danger-solid" autoFocus disabled={actions.pending} onClick={() => { setAccessConfirm(false); actions.run({ op: 'access', access: false }) }}>Ja, ohne Login</button>
          </span>
        )}
      </div>
      {offline && (
        <OfflineConfirm s={s} name={p.name} busy={actions.pending} onCancel={() => setOffline(false)}
          onGo={(m) => { setOffline(false); actions.run({ op: m }) }} />
      )}
    </>
  )
}

/* --- Pausiert ---------------------------------------------------------------------- */

function PausedState({ p, s, actions }: { p: ProjectDto; s: PublicStatusDto; actions: Actions }) {
  const [offline, setOffline] = useState(false)
  const blockedId = useId()
  return (
    <>
      <Facts s={s} paused />
      <Blocked s={s} id={blockedId} />
      <div className="form-actions publication-actions">
        {!offline && (
          <>
            <button className="button-primary" disabled={!s.publishable.ok || actions.pending} aria-describedby={!s.publishable.ok ? blockedId : undefined}
              onClick={() => actions.run({ op: 'resume' })}>
              {actions.pending && actions.current?.op === 'resume' ? 'Wird fortgesetzt…' : 'Wieder online'}
            </button>
            <button onClick={() => setOffline(true)} disabled={actions.pending}>Ganz offline nehmen …</button>
          </>
        )}
      </div>
      {offline && (
        <OfflineConfirm s={s} name={p.name} busy={actions.pending} only="unpublish" onCancel={() => setOffline(false)}
          onGo={() => { setOffline(false); actions.run({ op: 'unpublish' }) }} />
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
  const recent = last && last.finishedAt && Date.now() - Date.parse(last.finishedAt) < 10 * 60_000
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

import { useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  EGRESS_MAX_EXCEPTIONS, EGRESS_MODE_LABEL, egressModes, egressTargetKind,
  type EgressApplyDto, type EgressAttemptDto, type EgressExceptionDto, type EgressMode, type EgressServerDto, type ProjectDto, type ProjectEgressDto,
} from '@airlock/shared'
import { api } from '../api.js'
import { notifyOk } from '../lib/feedback.js'
import { relativeTime } from '../lib/format.js'
import { fmtDateTime } from '../lib/dates.js'
import { ErrorState, Loading, SkLines } from './States.js'
import { SetRow } from './Publication.js'
import { Switch } from './Switch.js'
import { ConfirmDialog } from './Confirm.js'
import { IconAlert, IconOk, IconPending, IconServer, IconWarn } from './Icons.js'

/**
 * Nacht 3, Etappe 4: Projekt › Einstellungen › «Ausgehende Verbindungen» und
 * die Übersicht unter Server. Nur bestehende Bausteine (Einstellungskarte mit
 * Zeilen, Auswahl, Switch, Tabelle, Status-Pille, ConfirmDialog); Zustände
 * immer mit Text und Zeichen, nie nur über Farbe. Keine Animation.
 */

const MODE_NOTE: Record<EgressMode, string> = {
  internet: 'Internet und DNS gehen. Heimnetz, Tailnet, andere Projekte und der Server selbst sind gesperrt.',
  abgeschottet: 'Auch kein Internet und kein DNS nach draussen – nur das eigene Projekt-Netz und die Ausnahmen.',
  frei: 'Keine Sperre, wie vor diesem Schutz. Das Projekt erreicht Router, NAS und den Server.',
}

const APPLY: Record<EgressApplyDto['state'], { word: string; cls: string; icon: 'ok' | 'pending' | 'warn' | 'bad' | null }> = {
  angewendet: { word: 'Angewendet', cls: 'status-running', icon: 'ok' },
  ausstehend: { word: 'Wird angewendet', cls: 'status-deploying', icon: 'pending' },
  'dienst-aus': { word: 'Firewall-Dienst aus', cls: 'status-warn', icon: 'warn' },
  fehler: { word: 'Nicht angewendet', cls: 'status-failed', icon: 'bad' },
  abgeschaltet: { word: 'Notausgang aktiv', cls: 'status-warn', icon: 'warn' },
  'ohne-netz': { word: 'Noch kein Netz', cls: 'status-stopped', icon: null },
  frei: { word: 'Keine Regeln', cls: 'status-stopped', icon: null },
}

function ApplyPill({ apply }: { apply: EgressApplyDto }) {
  const a = APPLY[apply.state]
  const Icon = a.icon === 'ok' ? IconOk : a.icon === 'pending' ? IconPending : a.icon === 'bad' ? IconAlert : a.icon === 'warn' ? IconWarn : null
  return (
    <span className={`status ${a.cls} egress-pill`} title={apply.at ? `Zuletzt angewendet ${fmtDateTime(apply.at, '')}` : undefined}>
      {Icon ? <Icon size={13} /> : <span className="status-dot" aria-hidden="true" />}
      {a.word}
    </span>
  )
}

/** Ziel einer Ausnahme oder eines Versuchs: Adresse und Port */
const targetText = (target: string, port: number | null) => (port === null ? target : target.includes(':') ? `[${target}]:${port}` : `${target}:${port}`)

export function attemptVerb(a: EgressAttemptDto): string {
  return a.verdict === 'gesperrt' ? 'Gesperrt' : 'Hätte gesperrt'
}

/* --- Einstellungen ----------------------------------------------------------------------- */

export function EgressSettings({ p }: { p: ProjectDto }) {
  const qc = useQueryClient()
  const titleId = useId()
  const modeId = useId()
  const enforceId = useId()
  const q = useQuery({ queryKey: ['egress', p.id], queryFn: () => api.egress(p.id), refetchInterval: 30_000 })
  const e = q.data?.egress
  const [confirmFree, setConfirmFree] = useState(false)
  const done = (r: { egress: ProjectEgressDto }) => {
    qc.setQueryData(['egress', p.id], r)
    void qc.invalidateQueries({ queryKey: ['project', p.id] })
  }
  const set = useMutation({
    meta: { errorTitle: 'Ausgang nicht geändert' },
    mutationFn: (v: { mode?: EgressMode; enforce?: boolean; undo?: boolean }) => api.setEgress(p.id, { mode: v.mode, enforce: v.enforce }),
    onSuccess: (r, v) => {
      done(r)
      setConfirmFree(false)
      const before = e
      const title = v.mode ? `Ausgang: ${EGRESS_MODE_LABEL[v.mode]}` : v.enforce ? 'Ausgang: durchsetzen' : 'Ausgang: nur beobachten'
      notifyOk(`${v.undo ? 'Rückgängig: ' : ''}${title}`, {
        id: `egress-${p.id}`,
        description: v.mode ? MODE_NOTE[v.mode] : v.enforce ? 'Versuche ins Heimnetz und zum Server werden abgewiesen.' : 'Nichts wird gesperrt; Versuche stehen als «hätte gesperrt» in der Liste.',
        // «frei» nicht per Rückgängig zurückholen (bräuchte wieder die Bestätigung); weg von «frei» schon
        undo: v.undo || !before || v.mode === 'frei' ? undefined
          : () => set.mutate(v.mode ? { mode: before.mode, undo: true } : { enforce: before.enforce, undo: true }),
      })
    },
  })
  const isStatic = p.runtimeKind === 'static'
  const pendingMode = set.isPending ? set.variables?.mode : undefined
  const mode = pendingMode ?? e?.mode ?? 'internet'
  const enforce = set.isPending && set.variables?.enforce !== undefined ? set.variables.enforce : (e?.enforce ?? true)
  const readOnly = Boolean(e?.inheritedFrom)

  return (
    <section className="set-card" id="set-ausgang" aria-labelledby={titleId}>
      <div className="set-head">
        <h2 id={titleId} tabIndex={-1}>Ausgehende Verbindungen</h2>
        {e && <div className="set-head-actions"><ApplyPill apply={e.apply} /></div>}
      </div>
      {!e && q.isError ? <div className="set-row-note"><ErrorState compact what="Der Ausgang" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} /></div>
        : !e ? <Loading label="Ausgang wird geladen" className="set-row-note"><SkLines n={3} /></Loading> : (
        <>
          {e.inheritedFrom && <p className="set-row-note">Vorschau: folgt den Einstellungen von «{e.inheritedFrom.name}».</p>}
          <SetRow label={<span id={modeId}>Modus</span>}>
            <div className="egress-modes" role="radiogroup" aria-labelledby={modeId}>
              {egressModes.map((m) => (
                <label key={m} className={`choice${readOnly ? ' choice-disabled' : ''}`}>
                  <input
                    type="radio"
                    name={`${titleId}-mode`}
                    checked={mode === m}
                    disabled={readOnly || set.isPending}
                    onChange={() => (m === 'frei' ? setConfirmFree(true) : set.mutate({ mode: m }))}
                  />
                  <span>
                    <strong className="set-strong">{EGRESS_MODE_LABEL[m]}{m === 'internet' ? ' (Standard)' : ''}</strong>
                    <small>{MODE_NOTE[m]}</small>
                  </span>
                </label>
              ))}
            </div>
          </SetRow>
          {mode !== 'frei' && (
            <SetRow label={<span id={enforceId}>Sperren</span>} action={<Switch checked={enforce} labelledBy={enforceId} busy={set.isPending} disabled={readOnly} onChange={(v) => set.mutate({ enforce: v })} />}>
              <strong className="set-strong">{enforce ? 'Durchsetzen' : 'Nur beobachten'}</strong>
              <span className="muted"> · {enforce ? 'Versuche werden abgewiesen und gezählt' : 'nichts wird gesperrt – Versuche erscheinen unten als «hätte gesperrt»'}</span>
            </SetRow>
          )}
          {mode === 'frei' && (
            <p className="set-row-note egress-free"><IconWarn /> Kein Schutz: ein gehacktes Projekt erreicht von hier aus das Heimnetz, andere Projekte und den Server.</p>
          )}
          {isStatic && <p className="set-row-note">Statische Seite: gilt für den Build und den Security-Scan, die im Netz des Projekts laufen.</p>}
          {e.apply.message && e.apply.state !== 'angewendet' && e.apply.state !== 'frei' && (
            <p className="set-row-note egress-apply-note" role="status">{e.apply.message}</p>
          )}
          {mode !== 'frei' && <Exceptions p={p} e={e} readOnly={readOnly} onDone={done} />}
          <Attempts e={e} />
        </>
      )}
      <ConfirmDialog
        open={confirmFree}
        title="Ausgang frei geben?"
        confirmLabel="Frei geben"
        busy={set.isPending}
        error={set.isError ? (set.error as Error).message : null}
        onCancel={() => setConfirmFree(false)}
        onConfirm={() => set.mutate({ mode: 'frei' })}
      >
        <p>«{p.name}» erreicht danach wieder das Heimnetz (Router, NAS), andere Projekte und den Server selbst – wie vor diesem Schutz. Für einzelne Ziele reicht meist eine Ausnahme.</p>
        <p className="hint">Airlock fragt dafür noch einmal nach deinem Passwort oder Passkey.</p>
      </ConfirmDialog>
    </section>
  )
}

function Exceptions({ p, e, readOnly, onDone }: { p: ProjectDto; e: ProjectEgressDto; readOnly: boolean; onDone: (r: { egress: ProjectEgressDto }) => void }) {
  const uid = useId()
  const [target, setTarget] = useState('')
  const [port, setPort] = useState('')
  const [protocol, setProtocol] = useState<'tcp' | 'udp'>('tcp')
  const [note, setNote] = useState('')
  const [touched, setTouched] = useState(false)
  const targetRef = useRef<HTMLInputElement>(null)
  const add = useMutation({
    mutationFn: () => api.addEgressException(p.id, { target: target.trim(), port: port.trim() ? Number(port) : null, protocol, note: note.trim() || null }),
    onSuccess: (r) => {
      onDone(r)
      notifyOk('Ausnahme eingetragen', { id: `egress-ex-${p.id}`, description: targetText(target.trim(), port.trim() ? Number(port) : null) })
      setTarget(''); setPort(''); setNote(''); setTouched(false)
    },
  })
  const remove = useMutation({
    meta: { errorTitle: 'Ausnahme nicht entfernt' },
    mutationFn: (x: EgressExceptionDto) => api.removeEgressException(p.id, x.id),
    onSuccess: (r, x) => { onDone(r); notifyOk('Ausnahme entfernt', { id: `egress-ex-${p.id}`, description: targetText(x.target, x.port) }) },
  })
  const kind = egressTargetKind(target)
  const portNum = Number(port)
  const portOk = port.trim() === '' || (/^\d+$/.test(port.trim()) && portNum >= 1 && portNum <= 65535)
  const targetError = touched && target.trim() !== '' && !kind ? 'IP-Adresse, Netz (z. B. 192.168.1.0/24, höchstens /8) oder Hostname' : null
  const full = e.exceptions.length >= EGRESS_MAX_EXCEPTIONS
  const hostInIsolated = e.mode === 'abgeschottet' && kind?.kind === 'host'

  return (
    <div className="set-row-block egress-block">
      <h3 className="egress-sub">Ausnahmen</h3>
      {e.exceptions.length === 0
        ? <p className="hint egress-empty">Keine. Was das Projekt im Heimnetz braucht – etwa das NAS mit 192.168.1.10, Port 445 –, hier eintragen.</p>
        : (
          <ul className="egress-list">
            {e.exceptions.map((x) => (
              <li key={x.id}>
                <span className="egress-target">
                  <code>{targetText(x.target, x.port)}</code>
                  {x.port !== null && <span className="muted"> {x.protocol.toUpperCase()}</span>}
                  {x.port === null && <span className="muted"> alle Ports</span>}
                </span>
                <span className="egress-detail muted">
                  {x.resolved === null
                    ? <span className="egress-unresolved"><IconWarn size={13} /> Name nicht auflösbar – gilt erst, wenn er auflöst</span>
                    : x.resolved.length ? `→ ${x.resolved.join(', ')}` : null}
                  {x.note ? <> {x.resolved?.length || x.resolved === null ? '· ' : ''}{x.note}</> : null}
                </span>
                {!readOnly && (
                  <button type="button" className="button-small" onClick={() => remove.mutate(x)} disabled={remove.isPending} aria-label={`Ausnahme ${targetText(x.target, x.port)} entfernen`}>
                    Entfernen
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      {!readOnly && (
        <form
          className="egress-form"
          onSubmit={(ev) => {
            ev.preventDefault()
            setTouched(true)
            if (kind && portOk && !full) add.mutate()
          }}
        >
          <div className="field">
            <label htmlFor={`${uid}-target`}>Ziel</label>
            <input
              id={`${uid}-target`} ref={targetRef} value={target} placeholder="192.168.1.10 oder nas.lan"
              onChange={(ev) => setTarget(ev.target.value)} onBlur={() => setTouched(true)}
              autoComplete="off" spellCheck={false}
              aria-invalid={targetError ? true : undefined} aria-describedby={`${uid}-target-hint`}
            />
            <p className={targetError ? 'field-error' : 'hint'} id={`${uid}-target-hint`}>
              {targetError ?? (hostInIsolated ? 'Abgeschottet: der Container kann Namen nicht auflösen – besser die IP eintragen.' : 'IP, Netz (CIDR) oder Hostname (wird beim Anwenden aufgelöst)')}
            </p>
          </div>
          <div className="field egress-port">
            <label htmlFor={`${uid}-port`}>Port <span className="field-optional">(optional)</span></label>
            <input id={`${uid}-port`} value={port} inputMode="numeric" onChange={(ev) => setPort(ev.target.value)} placeholder="alle" autoComplete="off" aria-invalid={!portOk || undefined} aria-describedby={`${uid}-port-hint`} />
            <p className={portOk ? 'hint' : 'field-error'} id={`${uid}-port-hint`}>{portOk ? 'leer = alle' : '1 bis 65535'}</p>
          </div>
          <div className="field egress-proto">
            <label htmlFor={`${uid}-proto`}>Protokoll</label>
            <select id={`${uid}-proto`} value={protocol} onChange={(ev) => setProtocol(ev.target.value as 'tcp' | 'udp')} disabled={port.trim() === ''}>
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
            </select>
          </div>
          <div className="field egress-note">
            <label htmlFor={`${uid}-note`}>Notiz <span className="field-optional">(optional)</span></label>
            <input id={`${uid}-note`} value={note} maxLength={80} onChange={(ev) => setNote(ev.target.value)} placeholder="z. B. NAS" autoComplete="off" />
          </div>
          <div className="egress-form-actions">
            <button type="submit" className="button-small" disabled={add.isPending || full} aria-busy={add.isPending || undefined}>Ausnahme hinzufügen</button>
          </div>
          {add.isError && <p className="error egress-form-error" role="alert">{(add.error as Error).message}</p>}
          {full && <p className="hint egress-form-error">Höchstens {EGRESS_MAX_EXCEPTIONS} Ausnahmen je Projekt.</p>}
        </form>
      )}
    </div>
  )
}

function Attempts({ e }: { e: ProjectEgressDto }) {
  const observed = e.attempts.filter((a) => a.verdict === 'beobachtet').length
  return (
    <div className="set-row-block egress-block">
      <h3 className="egress-sub">Versuche der letzten 7 Tage</h3>
      {e.attempts.length === 0 ? (
        <p className="hint egress-empty">
          {e.mode === 'frei' ? 'Im Modus «Frei» zählt Airlock nichts.' : 'Keine – das Projekt hat weder das Heimnetz noch den Server zu erreichen versucht.'}
        </p>
      ) : (
        <>
          <div className="table-scroll">
            <table className="table egress-table">
              <thead>
                <tr><th scope="col">Urteil</th><th scope="col">Ziel</th><th scope="col">Protokoll</th><th scope="col" className="num-col">Anzahl</th><th scope="col">Zuletzt</th></tr>
              </thead>
              <tbody>
                {e.attempts.map((a) => (
                  <tr key={`${a.verdict}|${a.protocol}|${a.destination}|${a.port}`}>
                    <td>
                      <span className={`egress-verdict egress-verdict-${a.verdict}`}>
                        {a.verdict === 'gesperrt' ? <IconAlert size={13} /> : <IconWarn size={13} />} {attemptVerb(a)}
                      </span>
                    </td>
                    <td>
                      <code>{targetText(a.destination, a.port)}</code>
                      {a.toServer && <span className="chip egress-server"><IconServer size={12} /> Server</span>}
                    </td>
                    <td>{a.protocol === 'andere' ? 'anderes' : a.protocol.toUpperCase()}</td>
                    <td className="num-col num">{a.count}×</td>
                    <td><span title={fmtDateTime(a.lastSeen, '')}>{relativeTime(a.lastSeen)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {observed > 0 && !e.enforce && (
            <p className="hint egress-hint">Beim Durchsetzen würden diese Verbindungen abgewiesen. Was das Projekt wirklich braucht, oben als Ausnahme eintragen, dann «Sperren» einschalten.</p>
          )}
          <p className="hint egress-hint">Gezählt werden höchstens 20 Versuche pro Minute und Projekt.</p>
        </>
      )}
    </div>
  )
}

/* --- Server › Übersicht --------------------------------------------------------------------- */

const SERVICE_WORD: Record<EgressServerDto['service']['state'], string> = {
  laeuft: 'läuft', aus: 'meldet sich nicht', fehler: 'letzter Stand abgelehnt', abgeschaltet: 'Notausgang aktiv', 'nicht-unterstuetzt': 'nft geht nicht',
}

export function EgressOverview() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['egress-server'], queryFn: () => api.egressServer(), refetchInterval: 60_000 })
  const [confirm, setConfirm] = useState(false)
  const all = useMutation({
    mutationFn: () => api.enforceAllEgress(),
    onSuccess: (r) => {
      qc.setQueryData(['egress-server'], { egress: r.egress })
      void qc.invalidateQueries({ queryKey: ['egress'] })
      setConfirm(false)
      notifyOk(`${r.changed} ${r.changed === 1 ? 'Projekt setzt' : 'Projekte setzen'} jetzt durch`, { id: 'egress-all' })
    },
  })
  const e = q.data?.egress
  if (!e) return q.isError ? <ErrorState compact what="Der Ausgang" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} /> : <Loading label="Ausgang wird geladen"><SkLines n={2} /></Loading>
  const s = e.service
  const facts = [s.version, s.networks !== null ? `${s.networks} ${s.networks === 1 ? 'Projekt-Netz' : 'Projekt-Netze'}` : null, s.appliedAt ? `angewendet ${relativeTime(s.appliedAt)}` : null].filter(Boolean).join(' · ')
  const counts = [
    `${e.projects.enforce} ${e.projects.enforce === 1 ? 'setzt' : 'setzen'} durch`,
    `${e.projects.observe} ${e.projects.observe === 1 ? 'beobachtet' : 'beobachten'}`,
    e.projects.abgeschottet ? `${e.projects.abgeschottet} abgeschottet` : null,
    e.projects.frei ? `${e.projects.frei} frei` : null,
  ].filter(Boolean).join(' · ')
  return (
    <>
      <ul className="check-list">
        <li className={s.state === 'laeuft' ? 'check-ok' : 'check-fail'}>
          <span className="check-name">Firewall-Dienst</span>
          <span className="check-detail">{SERVICE_WORD[s.state]}{facts ? <span className="muted"> · {facts}</span> : null}{s.message ? <> · {s.message}</> : null}</span>
        </li>
        <li className="check-none">
          <span className="check-name">Projekte</span>
          <span className="check-detail">{counts}</span>
        </li>
        <li className="check-none">
          <span className="check-name">Letzte 24 Stunden</span>
          <span className="check-detail">{e.last24h.gesperrt} gesperrt · {e.last24h.beobachtet} hätte gesperrt <span className="muted">(Einzelheiten je Projekt unter Einstellungen › Ausgehende Verbindungen)</span></span>
        </li>
      </ul>
      {e.projects.observe > 0 && (
        <div className="form-actions">
          <button type="button" onClick={() => setConfirm(true)}>Alle auf Durchsetzen …</button>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title={`${e.projects.observe} ${e.projects.observe === 1 ? 'Projekt' : 'Projekte'} auf Durchsetzen umstellen?`}
        confirmLabel="Durchsetzen"
        busy={all.isPending}
        error={all.isError ? (all.error as Error).message : null}
        onCancel={() => setConfirm(false)}
        onConfirm={() => all.mutate()}
      >
        <p>Danach weist Airlock Verbindungen ins Heimnetz, zu anderen Projekten und zum Server ab. Vorher je Projekt die Liste «hätte gesperrt» ansehen und Gebrauchtes als Ausnahme eintragen.</p>
        <p className="hint">Zurück geht es je Projekt mit dem Schalter «Sperren».</p>
      </ConfirmDialog>
    </>
  )
}

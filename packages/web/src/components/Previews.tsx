import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PREVIEW_ENV_PATH, previewStateLabel, putEnvSchema, type PreviewDto, type PreviewsDto } from '@airlock/shared'
import { api } from '../api.js'
import { poll } from '../lib/live.js'
import { notifyOk } from '../lib/feedback.js'
import { fieldId, useFormErrors } from '../lib/form.js'
import { useUnsaved } from '../lib/unsaved.js'
import { relativeTime, shortVersion } from '../lib/format.js'
import { fmtDate, fmtDateTime } from '../lib/dates.js'
import { ErrorState, Loading, SkLines } from './States.js'
import { InlineConfirm } from './Confirm.js'
import { DeployLog } from './DeployList.js'
import { EnvEditor, type EnvRow } from './EnvEditor.js'
import { SetRow } from './Publication.js'
import { Switch } from './Switch.js'
import { IconCheck, IconExternal, IconGit } from './Icons.js'

/**
 * Etappe 6 «Vorschau-Deploys»: eine Fassung je Branch bzw. Pull Request
 * unter <branch>--<projekt>.int.<basis>, immer nur intern.
 *
 * - Reiter Deployments: Abschnitt «Vorschauen» (Branch, PR, Zustand,
 *   Adresse, Log, Löschen mit Bestätigung).
 * - Einstellungen: Schalter «Vorschauen» (Standard aus; nur Git-Projekte mit
 *   GitHub-App, sonst deaktiviert mit Begründung) und die Variablen-Ebene
 *   «Vorschau».
 *
 * Zustände stehen immer als Wort da (Pille), Farbe nur zusätzlich.
 */

export function usePreviews(projectId: string) {
  return useQuery({ queryKey: ['previews', projectId], queryFn: () => api.previews(projectId), refetchInterval: poll })
}

// Strich 1,6 wie die übrigen Zeichen (DeployList)
const svg = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
const IconX = () => <svg {...svg}><path d="m4.8 4.8 6.4 6.4M11.2 4.8l-6.4 6.4" /></svg>
const IconWait = () => <svg {...svg}><circle cx="8" cy="8" r="5" strokeDasharray="2.4 2.2" /></svg>

const PILL: Record<PreviewDto['state'], string> = { ready: 'dl-pill-ok', failed: 'dl-pill-bad', deploying: 'dl-pill-info', stopped: 'dl-pill-same' }

function mark(s: PreviewDto['state']) {
  if (s === 'ready') return <IconCheck />
  if (s === 'failed') return <IconX />
  if (s === 'deploying') return <IconWait />
  return <IconGit size={16} />
}

function scanText(p: PreviewDto): string | null {
  if (p.state !== 'ready') return null
  const s = p.scan
  if (!s) return 'Scan folgt'
  if (s.status === 'queued' || s.status === 'running') return 'Scan läuft'
  if (s.status !== 'done') return 'Scan nicht abgeschlossen'
  const crit = s.open.critical ? ` · ${s.open.critical} kritisch` : ''
  return `Note ${s.grade ?? '–'}${crit}`
}

/* --- Reiter Deployments ---------------------------------------------------------------- */

export function PreviewsSection({ projectId, onSettings }: { projectId: string; onSettings: () => void }) {
  const q = usePreviews(projectId)
  if (!q.data && q.isError) return <ErrorState compact plural what="Die Vorschauen" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
  if (!q.data) return null
  const d = q.data.previews
  // Nicht möglich und nichts da: kein Abschnitt (die Einstellungen erklären warum)
  if (!d.available && !d.enabled && d.previews.length === 0) return null
  return (
    <section className="panel panel-pad ov-section pv-section" aria-labelledby="pv-title">
      <div className="ov-head">
        <h2 className="ov-title" id="pv-title">Vorschauen</h2>
        <span className="muted num">{d.enabled ? `${d.previews.length} von höchstens ${d.max}` : 'aus'}</span>
      </div>
      <p className="hint pv-intro">
        Je Branch oder Pull Request eine eigene Fassung unter <code className="pv-pattern">{d.pattern ?? '<branch>--<projekt>'}</code> –
        nur im Heimnetz und im Tailnet, nie öffentlich. Datenbanken aus der compose.yaml starten leer.
      </p>
      {!d.enabled && (
        <div className="pv-off">
          <p>Vorschauen sind für dieses Projekt aus.</p>
          {d.available
            ? <button type="button" className="button-small" onClick={onSettings}>In den Einstellungen einschalten</button>
            : d.reason && <p className="muted">{d.reason}</p>}
        </div>
      )}
      {d.enabled && d.previews.length === 0 && (
        <p className="pv-empty">
          Noch keine Vorschau. Airlock legt eine an, sobald auf einen Branch gepusht oder ein Pull Request geöffnet wird
          {d.checkedAt ? <> (zuletzt nachgesehen <time dateTime={d.checkedAt} title={fmtDateTime(d.checkedAt)}>{relativeTime(d.checkedAt)}</time>)</> : ' (Abfrage alle 5 Minuten)'}.
        </p>
      )}
      {d.previews.length > 0 && (
        <ol className="dl-list pv-list">
          {d.previews.map((p) => <PreviewRow key={p.id} projectId={projectId} p={p} onSettings={onSettings} />)}
        </ol>
      )}
      {d.enabled && (
        <p className="dl-note pv-note">
          Weg, sobald der Pull Request geschlossen oder gemergt bzw. der Branch gelöscht ist, spätestens nach {d.idleDays} Tagen ohne Push.
          Pull Requests aus Forks bekommen keine Vorschau.
        </p>
      )}
    </section>
  )
}

/**
 * Fehlende Geheimnisse: der Weg in der Meldung («Einstellungen › Vorschauen ›
 * Variablen») wird zum Link auf die Ebene «Vorschau».
 */
function FailureText({ p, onSettings }: { p: PreviewDto; onSettings: () => void }) {
  const text = p.failure ?? ''
  const at = p.failureSecrets ? text.indexOf(PREVIEW_ENV_PATH) : -1
  if (at < 0) return <p className="dl-error">{text}</p>
  return (
    <p className="dl-error">
      {text.slice(0, at)}
      <a href="?tab=einstellungen#set-vorschauen" onClick={(e) => { e.preventDefault(); onSettings() }}>{PREVIEW_ENV_PATH}</a>
      {text.slice(at + PREVIEW_ENV_PATH.length)}
    </p>
  )
}

function PreviewRow({ projectId, p, onSettings }: { projectId: string; p: PreviewDto; onSettings: () => void }) {
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [log, setLog] = useState(false)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const remove = useMutation({
    meta: { errorTitle: 'Vorschau nicht gelöscht' },
    mutationFn: () => api.deletePreview(projectId, p.id),
    onSuccess: () => {
      setConfirming(false)
      void qc.invalidateQueries({ queryKey: ['previews', projectId] })
      notifyOk(`Vorschau «${p.branch}» gelöscht`, { description: 'Container, Volumes und Adresse sind weg. Ein neuer Push legt sie wieder an.' })
    },
  })
  const scan = scanText(p)
  return (
    <li className={`dl pv pv-${p.state}`}>
      <span className="dl-mark" aria-hidden="true">{mark(p.state)}</span>
      <div className="dl-body">
        <div className="dl-title">
          <span className="dl-name pv-branch">{p.branch}</span>
          <span className={`dl-pill ${PILL[p.state]}`}>{previewStateLabel(p.state)}</span>
          {p.prNumber !== null && p.prUrl && (
            <a className="pv-pr" href={p.prUrl} target="_blank" rel="noreferrer">
              Pull Request #{p.prNumber}<IconExternal /><span className="sr-only"> (öffnet GitHub in neuem Tab)</span>
            </a>
          )}
        </div>
        <div className="dl-meta">
          {/* Fassung vorn wie in der Deployments-Liste (der Trennpunkt steht vor dem nächsten Eintrag) */}
          {p.headSha && <code className="dl-version" title={p.headSha}>{shortVersion(p.headSha)}</code>}
          {/* Link in einem span: der Trennpunkt (::before) soll nicht unterstrichen sein */}
          <span className="pv-addr">{p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.host ?? p.url}</a> : p.label}</span>
          <span>Push <time dateTime={p.lastPushAt} title={fmtDateTime(p.lastPushAt)}>{relativeTime(p.lastPushAt)}</time></span>
          {scan && <span>{scan}</span>}
          <span>weg ab {fmtDate(p.expiresAt)}</span>
        </div>
        {p.state === 'failed' && p.failure && <FailureText p={p} onSettings={onSettings} />}
        {log && p.deploymentId && <DeployLog id={p.deploymentId} />}
      </div>
      <div className="dl-aside">
        {p.deploymentId && (
          <button type="button" className="button-small button-ghost" aria-expanded={log} onClick={() => setLog(!log)}>
            {log ? 'Log schliessen' : 'Log'}
          </button>
        )}
        {!confirming && (
          <button ref={deleteRef} type="button" className="button-small" onClick={() => setConfirming(true)} aria-label={`Vorschau ${p.branch} löschen …`}>Löschen …</button>
        )}
        {confirming && (
          <InlineConfirm
            label={`Vorschau ${p.branch} löschen`}
            small
            confirmLabel="Ja, löschen"
            note="Löscht Container, Volumes und Adresse"
            busy={remove.isPending}
            onCancel={() => setConfirming(false)}
            onConfirm={() => remove.mutate()}
            returnFocusTo={deleteRef}
          />
        )}
      </div>
    </li>
  )
}

/* --- Einstellungen: Schalter und Variablen-Ebene «Vorschau» ------------------------------ */

export function PreviewSettings({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const titleId = useId()
  const labelId = useId()
  const reasonId = useId()
  const q = usePreviews(projectId)
  const set = useMutation({
    meta: { errorTitle: 'Vorschauen nicht geändert' },
    mutationFn: ({ enabled }: { enabled: boolean; undo?: boolean }) => api.setPreviews(projectId, enabled),
    onSuccess: (r, v) => {
      qc.setQueryData(['previews', projectId], r)
      notifyOk(`${v.undo ? 'Rückgängig: ' : ''}Vorschauen ${v.enabled ? 'an' : 'aus'}`, {
        id: `previews-${projectId}`,
        description: v.enabled
          ? 'Airlock sieht gleich bei GitHub nach; offene Pull Requests bekommen eine Vorschau.'
          : 'Alle Vorschauen des Projekts samt Volumes werden entfernt.',
        // Wieder ein: legt neu an (leere Datenbanken) – deshalb kein «Rückgängig» nach dem Ausschalten
        undo: v.undo || !v.enabled ? undefined : () => set.mutate({ enabled: false, undo: true }),
      })
    },
  })
  return (
    <section className="set-card" id="set-vorschauen" aria-labelledby={titleId}>
      <div className="set-head">
        <h2 id={titleId} tabIndex={-1}>Vorschauen</h2>
      </div>
      {!q.data && q.isError && <ErrorState compact plural what="Die Vorschauen" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />}
      {!q.data && !q.isError && <Loading label="Vorschauen werden geladen"><SkLines n={2} /></Loading>}
      {q.data && <PreviewSettingsBody d={q.data.previews} labelId={labelId} reasonId={reasonId} busy={set.isPending} pending={set.isPending ? Boolean(set.variables?.enabled) : null} onToggle={(v) => set.mutate({ enabled: v })} projectId={projectId} />}
    </section>
  )
}

function PreviewSettingsBody({ d, labelId, reasonId, busy, pending, onToggle, projectId }: {
  d: PreviewsDto; labelId: string; reasonId: string; busy: boolean; pending: boolean | null; onToggle: (v: boolean) => void; projectId: string
}) {
  const value = pending ?? d.enabled
  // Aus und nicht möglich: Schalter gesperrt, Begründung daneben. Ist er an (App später getrennt), bleibt Ausschalten möglich.
  const locked = !d.available && !d.enabled
  return (
    <>
      <SetRow label={<span id={labelId}>Pro Branch</span>} action={<Switch checked={value} labelledBy={labelId} describedBy={locked ? reasonId : undefined} disabled={locked} busy={busy} onChange={onToggle} />}>
        <strong className="set-strong">{value ? 'An' : 'Aus'}</strong>
        {locked
          ? <span className="muted" id={reasonId}> · {d.reason}</span>
          : <span className="muted"> · nur intern unter <code className="pv-pattern">{d.pattern}</code>{d.repo ? ` · ${d.repo}` : ''} · prüft alle 5 Minuten</span>}
      </SetRow>
      {!locked && (
        <SetRow label="Regeln">
          <span className="muted">
            Höchstens {d.max} gleichzeitig (die mit dem ältesten Push fällt raus), weg nach {d.idleDays} Tagen ohne Push, beim Schliessen des Pull Requests oder Löschen des Branches.
            Kommentar mit Link und Scan-Ergebnis am Pull Request.
          </span>
        </SetRow>
      )}
      {!locked && <PreviewEnv projectId={projectId} />}
    </>
  )
}

/**
 * Variablen-Ebene «Vorschau»: erbt die normalen Variablen des Projekts, die
 * geheimen nicht (stehen als «nicht vererbt» da; ohne eigenen Wert scheitert
 * der Vorschau-Deploy). Was hier steht, überschreibt gleichnamige (z. B.
 * Test-Schlüssel statt echter).
 */
function PreviewEnv({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['preview-env', projectId], queryFn: () => api.previewEnv(projectId) })
  const [editing, setEditing] = useState(false)
  const [rows, setRows] = useState<EnvRow[]>([])
  const fromServer = () => (q.data?.env ?? []).map((e) => ({ key: e.key, value: e.value ?? '', isSecret: e.isSecret, stored: true }))
  useEffect(() => { if (!editing) setRows(fromServer()) }, [q.data, editing]) // eslint-disable-line react-hooks/exhaustive-deps
  const entries = () => rows.map((r) => ({ key: r.key, value: r.value, isSecret: r.isSecret }))
  // Eigene IDs: der Editor der Projekt-Variablen kann gleichzeitig offen sein
  const form = useFormErrors({ schema: putEnvSchema, values: () => ({ entries: entries() }), idFor: (n) => fieldId(`pv-${n}`) })
  const save = useMutation({
    meta: { errorTitle: 'Vorschau-Variablen nicht gespeichert' },
    mutationFn: () => api.putPreviewEnv(projectId, entries()),
    onSuccess: (r) => {
      qc.setQueryData(['preview-env', projectId], r)
      setEditing(false)
      notifyOk('Vorschau-Variablen gespeichert', { description: 'Wirken beim nächsten Push auf eine Vorschau.' })
    },
    onError: (err) => void form.setServerErrors(err),
  })
  const initial = JSON.stringify((q.data?.env ?? []).map((e) => ({ key: e.key, value: e.value ?? '', isSecret: e.isSecret })))
  useUnsaved(editing && JSON.stringify(entries()) !== initial, 'Vorschau-Variablen')
  if (!q.data) return q.isError ? <ErrorState compact plural what="Die Vorschau-Variablen" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} /> : null
  const inherited = q.data.inherited.filter((i) => i.source === 'projekt').map((i) => i.key)
  const overridden = q.data.inherited.filter((i) => i.source === 'ueberschrieben').map((i) => i.key)
  const notInherited = q.data.inherited.filter((i) => i.source === 'nicht_vererbt').map((i) => i.key)
  const own = q.data.env
  return (
    <>
      <SetRow
        label="Variablen"
        action={!editing ? <button type="button" className="button-small" onClick={() => { setRows(fromServer()); setEditing(true) }}>{own.length ? 'Bearbeiten' : 'Überschreiben …'}</button> : undefined}
      >
        <span className="pv-env-sum">
          {inherited.length > 0 && <span>erbt vom Projekt: <strong className="set-strong">{inherited.join(', ')}</strong></span>}
          {notInherited.length > 0 && (
            <span>geheim, nicht vererbt: <strong className="set-strong">{notInherited.join(', ')}</strong> <span className="muted">– ohne eigenen Wert scheitert der Vorschau-Deploy</span></span>
          )}
          {overridden.length > 0 && <span>für Vorschauen überschrieben: <strong className="set-strong">{overridden.join(', ')}</strong></span>}
          {own.filter((e) => !overridden.includes(e.key)).length > 0 && <span>nur in Vorschauen: <strong className="set-strong">{own.filter((e) => !overridden.includes(e.key)).map((e) => e.key).join(', ')}</strong></span>}
          {q.data.inherited.length === 0 && <span className="muted">keine – weder im Projekt noch für Vorschauen</span>}
        </span>
      </SetRow>
      {editing && (
        <form className="set-row-block" noValidate ref={form.formRef} onSubmit={(ev) => { ev.preventDefault(); if (form.validateAll()) save.mutate() }}>
          <p className="hint">Gleicher Name wie im Projekt: gilt in Vorschauen statt des Projektwerts. Normale Variablen erben Vorschauen unverändert, geheime nicht – für die braucht es hier einen eigenen Wert, etwa einen Test-Schlüssel.</p>
          <EnvEditor rows={rows} onChange={setRows} prefix="entries" errors={form.errors} field={form.field} legend="Variablen für Vorschauen" />
          <div className="form-actions">
            <button type="submit" className="button-primary" disabled={save.isPending} aria-busy={save.isPending || undefined}>Vorschau-Variablen speichern</button>
            <button type="button" onClick={() => { setEditing(false); form.reset() }}>Abbrechen</button>
          </div>
        </form>
      )}
    </>
  )
}

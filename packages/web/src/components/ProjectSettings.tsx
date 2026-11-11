import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { putEnvSchema, type EnvEntryDto, type ProjectDto } from '@airlock/shared'
import { api } from '../api.js'
import { useFormErrors } from '../lib/form.js'
import { relativeTime } from '../lib/format.js'
import { EnvEditor, type EnvRow } from './EnvEditor.js'
import { Field } from './Field.js'
import { Publication, SetRow } from './Publication.js'
import { Reachability } from './Reachability.js'
import { useHeaderRules } from './HeaderFix.js'
import { Switch } from './Switch.js'
import { MoveProject } from './MoveProject.js'

/**
 * Projekt → Einstellungen: Abschnitte als Karten mit kompakten Zeilen
 * (Beschriftung · Wert · Aktion rechts), links eine Sprungnavigation, die den
 * Abschnitt im Blick markiert. Seltenes ist eingeklappt (Header-Liste),
 * Schalter speichern sofort, die Gefahrenzone steht ganz unten.
 */

type Section = { id: string; label: string; danger?: boolean }

const HEADER_SHORT: Record<string, string> = {
  'strict-transport-security': 'HSTS', 'x-content-type-options': 'nosniff', 'referrer-policy': 'Referrer-Policy',
  'frame-ancestors': 'X-Frame-Options', 'content-security-policy': 'CSP', 'permissions-policy': 'Permissions-Policy',
}

export function ProjectSettings({
  p, env, onDeleted, onManageHeaders, deleteRequested, onDeleteShown,
}: {
  p: ProjectDto
  env: EnvEntryDto[]
  onDeleted: () => void
  /** «Verwalten» bei den Security-Headern: zum Security-Reiter */
  onManageHeaders: () => void
  /** «Löschen …» aus dem Kopfmenü: Rückfrage öffnen und hinscrollen */
  deleteRequested?: boolean
  onDeleteShown?: () => void
}) {
  const auto = useQuery({ queryKey: ['auto-deploy', p.id], queryFn: () => api.autoDeploy(p.id) })
  const sections: Section[] = [
    { id: 'set-veroeffentlichung', label: 'Veröffentlichung' },
    { id: 'set-erreichbarkeit', label: 'Erreichbarkeit' },
    { id: 'set-umgebung', label: 'Umgebung' },
    { id: 'set-header', label: 'Security-Header' },
    ...(auto.data?.available ? [{ id: 'set-auto-deploy', label: 'Auto-Deploy' }] : []),
    { id: 'set-ablauf', label: 'Ablauf' },
    { id: 'set-verschieben', label: 'Verschieben' },
    { id: 'set-gefahrenzone', label: 'Gefahrenzone', danger: true },
  ]
  const active = useActiveSection(sections.map((s) => s.id))

  return (
    <div className="tab-panel set-layout">
      <nav className="set-nav" aria-label="Abschnitte der Einstellungen">
        <ul>
          {sections.map((s) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className={`set-nav-link${s.danger ? ' set-nav-danger' : ''}`}
                aria-current={active === s.id ? 'location' : undefined}
                onClick={(e) => {
                  e.preventDefault()
                  const el = document.getElementById(s.id)
                  if (!el) return
                  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
                  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
                  el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
                  history.replaceState(null, '', `${location.pathname}${location.search}#${s.id}`)
                }}
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="set-sections">
        <Publication p={p} />
        <Reachability p={p} />
        <Environment p={p} env={env} />
        <HeaderSection projectId={p.id} onManage={onManageHeaders} />
        {auto.data?.available && <AutoDeploy projectId={p.id} on={auto.data.autoDeploy} checkedAt={auto.data.checkedAt} viaApp={auto.data.viaGithubApp} />}
        <Expiry p={p} />
        {/* M9: in andere Umgebung verschieben, direkt vor der Gefahrenzone */}
        <section id="set-verschieben" className="set-move" aria-label="In andere Umgebung verschieben">
          <MoveProject p={p} />
        </section>
        <DangerZone p={p} onDeleted={onDeleted} requested={deleteRequested} onShown={onDeleteShown} />
      </div>
    </div>
  )
}

/** Welcher Abschnitt ist im Blick? Der oberste, dessen Kopf über der Mitte des Fensters liegt. */
function useActiveSection(ids: string[]): string {
  const [active, setActive] = useState(ids[0]!)
  const key = ids.join()
  useEffect(() => {
    const pick = () => {
      const line = window.innerHeight * 0.35
      let best = ids[0]!
      for (const id of ids) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top <= line) best = id
      }
      // Am Seitenende: der letzte Abschnitt, auch wenn er kurz ist
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) best = ids.at(-1)!
      setActive(best)
    }
    pick()
    window.addEventListener('scroll', pick, { passive: true })
    window.addEventListener('resize', pick)
    return () => { window.removeEventListener('scroll', pick); window.removeEventListener('resize', pick) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return active
}

/* --- Umgebung ----------------------------------------------------------------- */

function Environment({ p, env }: { p: ProjectDto; env: EnvEntryDto[] }) {
  const qc = useQueryClient()
  const titleId = useId()
  const isStatic = p.runtimeKind === 'static'
  const [rows, setRows] = useState<EnvRow[]>(env.map((e) => ({ key: e.key, value: e.value ?? '', isSecret: e.isSecret, stored: true })))
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState(false)
  const entries = () => rows.map((r) => ({ key: r.key, value: r.value, isSecret: r.isSecret }))
  const envForm = useFormErrors({ schema: putEnvSchema, values: () => ({ entries: entries() }) })
  const save = useMutation({
    mutationFn: () => api.putEnv(p.id, entries()),
    onSuccess: () => {
      setSaved(true)
      setEditing(false)
      setTimeout(() => setSaved(false), 2000)
      void qc.invalidateQueries({ queryKey: ['project', p.id] })
    },
    onError: (err) => void envForm.setServerErrors(err),
  })
  const secret = env.filter((e) => e.isSecret).length
  const add = () => {
    setEditing(true)
    setRows((r) => [...r, { key: '', value: '', isSecret: false }])
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('#set-umgebung .env-row:last-child input')?.focus())
  }
  return (
    <section className="set-card" id="set-umgebung" aria-labelledby={titleId}>
      <div className="set-head">
        <h2 id={titleId} tabIndex={-1}>Umgebung</h2>
        {saved && <span className="set-saved set-saved-on" role="status">✓ gespeichert · wirkt beim nächsten Deploy</span>}
        <div className="set-head-actions">
          {!editing && env.length > 0 && <button type="button" className="button-small" onClick={() => setEditing(true)}>Bearbeiten</button>}
          <button type="button" className="button-small" onClick={add}>Variable hinzufügen</button>
        </div>
      </div>
      {!editing && (
        <SetRow label="Variablen">
          {env.length === 0
            ? <span className="muted">keine{isStatic ? ' – bei einer statischen Seite nicht nötig' : ''}</span>
            : <><strong className="set-strong">{env.map((e) => e.key).join(', ')}</strong>{secret > 0 && <span className="muted"> · {secret} geheim</span>}</>}
        </SetRow>
      )}
      {editing && (
        <form className="set-row-block" noValidate ref={envForm.formRef} onSubmit={(ev) => { ev.preventDefault(); if (envForm.validateAll()) save.mutate() }}>
          <EnvEditor rows={rows} onChange={setRows} prefix="entries" errors={envForm.errors} field={envForm.field} />
          <div className="form-actions">
            <button type="submit" className="button-primary" disabled={save.isPending}>{save.isPending ? 'Wird gespeichert…' : 'Variablen speichern'}</button>
            <button type="button" onClick={() => { setEditing(false); setRows(env.map((e) => ({ key: e.key, value: e.value ?? '', isSecret: e.isSecret, stored: true }))); envForm.reset() }}>Abbrechen</button>
            <span className="hint">Wirksam beim nächsten Deploy.</span>
          </div>
          {save.isError && <p role="alert" className="error">{(save.error as Error).message}</p>}
        </form>
      )}
    </section>
  )
}

/* --- Security-Header ------------------------------------------------------------ */

function HeaderSection({ projectId, onManage }: { projectId: string; onManage: () => void }) {
  const q = useHeaderRules(projectId)
  const titleId = useId()
  const listId = useId()
  const [open, setOpen] = useState(false)
  const rules = q.data?.rules ?? []
  const names = rules.map((r) => `${HEADER_SHORT[r.header] ?? r.header}${r.mode === 'report-only' ? ' (Report-Only)' : ''}`)
  return (
    <section className="set-card" id="set-header" aria-labelledby={titleId}>
      <div className="set-head">
        <h2 id={titleId} tabIndex={-1}>Security-Header</h2>
        <span className="set-count">{rules.length} aktiv</span>
        <div className="set-head-actions"><button type="button" className="button-small" onClick={onManage}>Verwalten</button></div>
      </div>
      {q.isLoading ? <p className="set-row-note">Wird geladen…</p> : rules.length === 0 ? (
        <SetRow label="Über Caddy"><span className="muted">keine – die App setzt ihre Header selbst, oder es fehlt noch einer (siehe Security)</span></SetRow>
      ) : (
        <>
          <div className="set-row set-row-toggle">
            <div className="set-row-value set-row-wide muted">{names.join(' · ')}</div>
            <div className="set-row-action">
              <button type="button" className="link-button set-disclose" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
                {open ? 'einklappen' : 'aufklappen'}
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
              </button>
            </div>
          </div>
          <div className="set-collapse" data-open={open || undefined} id={listId}>
            <dl className="set-rules" inert={!open || undefined}>
              {rules.map((r) => (
                <div key={r.header}>
                  <dt>{HEADER_SHORT[r.header] ?? r.header}{r.mode === 'report-only' && <span className="set-mode"> Report-Only</span>}</dt>
                  <dd><code>{r.value}</code><span className="muted"> · seit {relativeTime(r.updatedAt).replace(/^vor /, '')}</span></dd>
                </div>
              ))}
            </dl>
          </div>
        </>
      )}
    </section>
  )
}

/* --- Auto-Deploy (nur Repo-Projekte) --------------------------------------------- */

function AutoDeploy({ projectId, on, checkedAt, viaApp }: { projectId: string; on: boolean; checkedAt: string | null; viaApp: boolean }) {
  const qc = useQueryClient()
  const titleId = useId()
  const labelId = useId()
  const set = useMutation({
    mutationFn: (enabled: boolean) => api.setAutoDeploy(projectId, enabled),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['auto-deploy', projectId] }),
  })
  const value = set.isPending ? Boolean(set.variables) : on
  return (
    <section className="set-card" id="set-auto-deploy" aria-labelledby={titleId}>
      <div className="set-head">
        <h2 id={titleId} tabIndex={-1}>Auto-Deploy</h2>
        {set.isSuccess && <span className="set-saved set-saved-on" role="status">✓ gespeichert</span>}
      </div>
      <SetRow label={<span id={labelId}>Nach Merge</span>} action={<Switch checked={value} labelledBy={labelId} busy={set.isPending} onChange={(v) => set.mutate(v)} />}>
        <strong className="set-strong">{value ? 'An' : 'Aus'}</strong>
        <span className="muted"> · prüft alle 5 Minuten auf neue Commits{viaApp ? ' (GitHub App)' : ' (öffentliches Repo)'}{value && checkedAt ? ` · zuletzt ${relativeTime(checkedAt)}` : ''}</span>
      </SetRow>
      {set.isError && <p role="alert" className="error set-row-note">{(set.error as Error).message}</p>}
    </section>
  )
}

/* --- Ablauf -------------------------------------------------------------------- */

function Expiry({ p }: { p: ProjectDto }) {
  const qc = useQueryClient()
  const titleId = useId()
  const keep = useMutation({
    mutationFn: (value: boolean) => api.updateProject(p.id, { keep: value }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['project', p.id] }),
  })
  const files = p.sourceType === 'files'
  const date = p.expiresAt ? new Date(p.expiresAt).toLocaleDateString('de-CH') : null
  return (
    <section className="set-card" id="set-ablauf" aria-labelledby={titleId}>
      <div className="set-head">
        <h2 id={titleId} tabIndex={-1}>Ablauf</h2>
        {files && (
          <div className="set-head-actions">
            {p.keep
              ? <button type="button" className="button-small" onClick={() => keep.mutate(false)} disabled={keep.isPending}>Ablauf wieder aktivieren</button>
              : <button type="button" className="button-small" onClick={() => keep.mutate(true)} disabled={keep.isPending}>Behalten</button>}
          </div>
        )}
      </div>
      <SetRow label={files ? 'Chat-Projekt' : 'Projekt'}>
        {!files ? <span className="muted">kein Ablauf ({p.sourceType === 'image' ? 'Image' : 'Repo oder Upload'})</span>
          : p.keep || !date ? <><strong className="set-strong">läuft unbegrenzt</strong> <span className="muted">· «Behalten» ist gesetzt</span></>
          : <><strong className="set-strong">stoppt am {date}</strong> <span className="muted">· wenn sich nichts ändert ({p.expiryDays ?? 30} Tage ohne Änderung)</span></>}
      </SetRow>
      {keep.isError && <p role="alert" className="error set-row-note">{(keep.error as Error).message}</p>}
    </section>
  )
}

/* --- Gefahrenzone -------------------------------------------------------------- */

function DangerZone({ p, onDeleted, requested, onShown }: { p: ProjectDto; onDeleted: () => void; requested?: boolean; onShown?: () => void }) {
  const titleId = useId()
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [purge, setPurge] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const ref = useRef<HTMLElement>(null)
  const remove = useMutation({ mutationFn: () => api.deleteProject(p.id, purge), onSuccess: onDeleted })
  useEffect(() => {
    if (!requested) return
    setOpen(true)
    requestAnimationFrame(() => {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ref.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
      document.getElementById('f-delete-confirm')?.focus({ preventScroll: true })
      onShown?.()
    })
  }, [requested]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="set-card set-danger danger-zone" id="set-gefahrenzone" aria-labelledby={titleId} ref={ref}>
      <div className="set-head"><h2 id={titleId} tabIndex={-1}>Gefahrenzone</h2></div>
      {/* «Verschieben …» (in eine andere Umgebung) erscheint hier, sobald es Umgebungen gibt (Meilenstein 9) */}
      <SetRow
        label="Löschen"
        action={!open ? <button type="button" className="button-small button-danger" onClick={() => { setOpen(true); requestAnimationFrame(() => document.getElementById('f-delete-confirm')?.focus()) }}>Projekt löschen …</button> : undefined}
      >
        <span className="muted">Container, Dateien, Adressen und Verlauf werden entfernt</span>
      </SetRow>
      {open && (
        <form
          className="set-row-block set-delete"
          noValidate
          onSubmit={(ev) => {
            ev.preventDefault()
            if (confirm.trim() !== p.slug) {
              setConfirmError(confirm.trim() ? `Das ist nicht «${p.slug}». Tippe den Kurznamen genau so ein, um das Löschen zu bestätigen.` : `Tippe «${p.slug}» ein, um das Löschen zu bestätigen.`)
              requestAnimationFrame(() => document.getElementById('f-delete-confirm')?.focus())
              return
            }
            setConfirmError(null)
            remove.mutate()
          }}
        >
          <p className="set-delete-lede">Lässt sich nicht rückgängig machen. Öffentliche Namen, DNS-Einträge und die Tunnel-Regel gehen mit.</p>
          <Field id="f-delete-confirm" label="Kurzname zur Bestätigung" error={confirmError ?? undefined}>
            <input
              id="f-delete-confirm"
              aria-invalid={confirmError ? true : undefined}
              aria-describedby={confirmError ? 'f-delete-confirm-error' : undefined}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onBlur={() => { if (confirmError && confirm.trim() === p.slug) setConfirmError(null) }}
              placeholder={p.slug}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {p.runtimeKind !== 'static' && (
            <label className="choice">
              <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
              <span>Auch die Daten-Volumes löschen <small>Ohne Haken bleiben benannte Volumes (z.B. einer Datenbank) erhalten.</small></span>
            </label>
          )}
          <div className="confirm-inline">
            <button type="button" onClick={() => { setOpen(false); setConfirm(''); setConfirmError(null) }}>Abbrechen</button>
            <button type="submit" className="button-danger-solid" disabled={remove.isPending}>{remove.isPending ? 'Wird gelöscht…' : 'Endgültig löschen'}</button>
          </div>
          {remove.isError && <p role="alert" className="error">{(remove.error as Error).message}</p>}
        </form>
      )}
    </section>
  )
}

import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { putEnvSchema, showsOnStatusPage, updateProjectSchema, type EnvEntryDto, type ProjectDto } from '@airlock/shared'
import { api } from '../api.js'
import { notifyOk } from '../lib/feedback.js'
import { useFormErrors } from '../lib/form.js'
import { useUnsaved } from '../lib/unsaved.js'
import { gb, relativeTime } from '../lib/format.js'
import { fmtDate } from '../lib/dates.js'
import { parseNumber, serverFreeMb, suggestCpuLimit, suggestMemoryLimit, usageOf, type LimitSuggestion } from '../lib/limits.js'
import { ErrorState, Loading, SkLines } from './States.js'
import { Field } from './Field.js'
import { useSystem } from './ServerName.js'
import { useProjectHealth } from './ProjectOverview.js'
import { EnvEditor, type EnvRow } from './EnvEditor.js'
import { Publication, SetRow } from './Publication.js'
import { Reachability } from './Reachability.js'
import { useHeaderRules } from './HeaderFix.js'
import { Switch } from './Switch.js'
import { MoveProject } from './MoveProject.js'
import { PreviewSettings } from './Previews.js'
import { ConfirmDialog } from './Confirm.js'

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
  p, env, onDeleted, onManageHeaders, deleteRequested, onDeleteShown, envRequest, onEnvShown,
  containerRequest, onContainerShown, onContainerSaved, onDeploy, deploying, publishRequested, onPublishShown,
}: {
  /** «Veröffentlichen →» im Reiter «Aufbau»: Karte «Veröffentlichung» mit offenem Ablauf */
  publishRequested?: boolean
  onPublishShown?: () => void
  /** Fehlerbox «Hinzufügen»: Variable mit diesem Namen vorbelegen und den Wert fokussieren */
  envRequest?: string | null
  onEnvShown?: () => void
  /** Fehlerbox «Port ändern», «Grenze erhöhen» …: Feld im Abschnitt Container vorbelegen und fokussieren */
  containerRequest?: ContainerRequest | null
  onContainerShown?: () => void
  /** Gespeichert bzw. rückgängig gemacht (für den Hinweis in der Fehlerbox) */
  onContainerSaved?: (patch: ContainerPatch, undo: boolean) => void
  /** «Neu deployen» nach einer Änderung am Container */
  onDeploy: () => void
  deploying: boolean
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
  // Antwort 8: Port, Healthcheck und Grenzen nur bei Projekten mit Container (nicht bei statischen Seiten)
  const hasContainer = p.runtimeKind !== 'static'
  const sections: Section[] = [
    { id: 'set-veroeffentlichung', label: 'Veröffentlichung' },
    { id: 'set-erreichbarkeit', label: 'Erreichbarkeit' },
    { id: 'set-statusseite', label: 'Statusseite' },
    { id: 'set-umgebung', label: 'Umgebungsvariablen' },
    ...(hasContainer ? [{ id: 'set-container', label: 'Container' }] : []),
    { id: 'set-header', label: 'Security-Header' },
    ...(auto.data?.available ? [{ id: 'set-auto-deploy', label: 'Auto-Deploy' }] : []),
    // Etappe 6: immer da – bei Projekten ohne Git-Repo und GitHub-App deaktiviert mit Begründung
    { id: 'set-vorschauen', label: 'Vorschauen' },
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
        <Publication p={p} request={publishRequested} onShown={onPublishShown} />
        <Reachability p={p} />
        <StatusPageSection p={p} />
        <Environment p={p} env={env} request={envRequest ?? null} onShown={onEnvShown} />
        {hasContainer && (
          <Container p={p} request={containerRequest ?? null} onShown={onContainerShown} onSaved={onContainerSaved} onDeploy={onDeploy} deploying={deploying} />
        )}
        <HeaderSection projectId={p.id} onManage={onManageHeaders} />
        {auto.data?.available && <AutoDeploy projectId={p.id} on={auto.data.autoDeploy} checkedAt={auto.data.checkedAt} viaApp={auto.data.viaGithubApp} />}
        <PreviewSettings projectId={p.id} />
        <Expiry p={p} />
        {/* M9: in eine andere Umgebung verschieben */}
        <section className="set-card" id="set-verschieben" aria-label="In andere Umgebung verschieben">
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

/* --- Umgebungsvariablen --------------------------------------------------------- */

function Environment({ p, env, request, onShown }: { p: ProjectDto; env: EnvEntryDto[]; request: string | null; onShown?: () => void }) {
  const qc = useQueryClient()
  const titleId = useId()
  const isStatic = p.runtimeKind === 'static'
  const [rows, setRows] = useState<EnvRow[]>(env.map((e) => ({ key: e.key, value: e.value ?? '', isSecret: e.isSecret, stored: true })))
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState(false)
  const entries = () => rows.map((r) => ({ key: r.key, value: r.value, isSecret: r.isSecret }))
  const envForm = useFormErrors({ schema: putEnvSchema, values: () => ({ entries: entries() }) })
  const save = useMutation({
    meta: { errorTitle: 'Umgebungsvariablen nicht gespeichert' },
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
  // UI-Qualität 8: ungespeicherte Variablen → Rückfrage beim Verlassen
  const initialRows = JSON.stringify(env.map((e) => ({ key: e.key, value: e.value ?? '', isSecret: e.isSecret })))
  const dirty = editing && JSON.stringify(rows.map((r) => ({ key: r.key, value: r.value, isSecret: r.isSecret }))) !== initialRows
  useUnsaved(dirty, 'Umgebungsvariablen')
  const add = () => {
    setEditing(true)
    setRows((r) => [...r, { key: '', value: '', isSecret: false }])
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('#set-umgebung .env-row:last-child input')?.focus())
  }
  // Aus der Fehlerbox: Zeile mit dem Namen (neu oder vorhanden), Fokus auf den Wert
  useEffect(() => {
    if (!request) return
    setEditing(true)
    setRows((r) => (r.some((x) => x.key === request) ? r : [...r, { key: request, value: '', isSecret: false }]))
    requestAnimationFrame(() => {
      const row = [...document.querySelectorAll<HTMLElement>('#set-umgebung .env-row')].find((el) => el.querySelector('input')?.value === request)
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      row?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
      row?.querySelectorAll('input')[1]?.focus({ preventScroll: true })
      onShown?.()
    })
  }, [request]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="set-card" id="set-umgebung" aria-labelledby={titleId}>
      <div className="set-head">
        <h2 id={titleId} tabIndex={-1}>Umgebungsvariablen</h2>
        {saved && <span className="set-saved set-saved-on" role="status">✓ gespeichert · wirkt beim nächsten Deploy</span>}
        <div className="set-head-actions">
          {!editing && env.length > 0 && <button type="button" className="button-small" onClick={() => setEditing(true)}>Bearbeiten</button>}
          <button type="button" className="button-small" onClick={add}>Umgebungsvariable hinzufügen</button>
        </div>
      </div>
      {!editing && (
        <SetRow label="Gesetzt">
          {env.length === 0
            ? <span className="muted">keine{isStatic ? ' – bei einer statischen Seite nicht nötig' : ''}</span>
            : <><strong className="set-strong">{env.map((e) => e.key).join(', ')}</strong>{secret > 0 && <span className="muted"> · {secret} geheim</span>}</>}
        </SetRow>
      )}
      {editing && (
        <form className="set-row-block" noValidate ref={envForm.formRef} onSubmit={(ev) => { ev.preventDefault(); if (envForm.validateAll()) save.mutate() }}>
          <EnvEditor rows={rows} onChange={setRows} prefix="entries" errors={envForm.errors} field={envForm.field} />
          <div className="form-actions">
            <button type="submit" className="button-primary" disabled={save.isPending} aria-busy={save.isPending || undefined}>Umgebungsvariablen speichern</button>
            <button type="button" onClick={() => { setEditing(false); setRows(env.map((e) => ({ key: e.key, value: e.value ?? '', isSecret: e.isSecret, stored: true }))); envForm.reset() }}>Abbrechen</button>
            <span className="hint">Wirksam beim nächsten Deploy.</span>
          </div>
        </form>
      )}
    </section>
  )
}

/* --- Container (Antwort 8) -------------------------------------------------------- */

export type ContainerKey = 'port' | 'healthcheckPath' | 'cpuLimit' | 'memoryLimitMb'
export type ContainerPatch = Partial<{ port: number; healthcheckPath: string; cpuLimit: number; memoryLimitMb: number }>
/**
 * Sprung aus der Fehlerbox: Feld fokussieren und vorbelegen – mit value (Port
 * aus dem Log), mit dem Vorschlag (suggest: «Grenze erhöhen») oder mit dem
 * aktuellen Wert.
 */
export type ContainerRequest = { field: ContainerKey; value?: number | string | null; suggest?: boolean }

type Draft = Record<ContainerKey, string>
const draftOf = (p: ProjectDto): Draft => ({
  port: p.port === null ? '' : String(p.port),
  healthcheckPath: p.healthcheckPath,
  cpuLimit: String(p.cpuLimit),
  memoryLimitMb: String(p.memoryLimitMb),
})

/** Was sich gegenüber dem Projekt ändert (ungültige Eingaben als NaN, damit die Prüfung sie meldet) */
function patchOf(p: ProjectDto, d: Draft): ContainerPatch {
  const out: ContainerPatch = {}
  if (!(d.port.trim() === '' && p.port === null)) {
    const port = parseNumber(d.port)
    if (port !== p.port) out.port = port
  }
  const path = d.healthcheckPath.trim()
  if (path !== p.healthcheckPath) out.healthcheckPath = path
  const cpu = parseNumber(d.cpuLimit)
  if (cpu !== p.cpuLimit) out.cpuLimit = cpu
  const mem = parseNumber(d.memoryLimitMb)
  if (mem !== p.memoryLimitMb) out.memoryLimitMb = mem
  return out
}

const fmtMb = (v: number) => `${Math.round(v).toLocaleString('de-CH')} MB`
const fmtCpu = (v: number) => v.toLocaleString('de-CH', { maximumFractionDigits: 2 })

/** «RAM-Grenze 1’024 MB, Port 3000» */
function patchText(patch: ContainerPatch): string {
  const parts: string[] = []
  if (patch.port !== undefined) parts.push(`Port ${patch.port}`)
  if (patch.healthcheckPath !== undefined) parts.push(`Healthcheck ${patch.healthcheckPath}`)
  if (patch.cpuLimit !== undefined) parts.push(`CPU-Grenze ${fmtCpu(patch.cpuLimit)}`)
  if (patch.memoryLimitMb !== undefined) parts.push(`RAM-Grenze ${fmtMb(patch.memoryLimitMb)}`)
  return parts.join(', ')
}

/** Satz zum Vorschlag: woher er kommt und was ihn begrenzt hat */
function suggestionText(s: LimitSuggestion, before: string, room: string | null): string {
  if (!s.raised) return s.capped === 'max' ? `Schon am Höchstwert (${before}).` : `Mehr geht nicht: auf dem Server ist ${room ? `nur ${room}` : 'kaum etwas'} frei.`
  const base = `Vorschlag: doppelt so viel wie bisher (${before})`
  if (s.capped === 'server') return `${base}, gedeckelt durch den Server${room ? ` (${room} frei)` : ''}.`
  if (s.capped === 'max') return `${base}, gedeckelt durch den Höchstwert.`
  return `${base}.`
}

function Container({ p, request, onShown, onSaved, onDeploy, deploying }: {
  p: ProjectDto
  request: ContainerRequest | null
  onShown?: () => void
  onSaved?: (patch: ContainerPatch, undo: boolean) => void
  onDeploy: () => void
  deploying: boolean
}) {
  const qc = useQueryClient()
  const titleId = useId()
  const health = useProjectHealth(p)
  const sys = useSystem()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Draft>(() => draftOf(p))
  /** Woher die Vorbelegung kam (Hinweis unter dem Feld) und welches Feld den Fokus bekommt */
  const [from, setFrom] = useState<{ field: ContainerKey; text: string } | null>(null)
  const [focus, setFocus] = useState<{ field: ContainerKey; scroll: boolean } | null>(null)
  /** Nach dem Speichern: Hinweis «wirkt beim nächsten Deploy» mit «Neu deployen» */
  const [pending, setPending] = useState<string | null>(null)

  const samples = health.data?.samples ?? []
  const mem = usageOf(samples, (s) => s.memMb)
  const cpu = usageOf(samples, (s) => s.cpu)
  const freeMb = serverFreeMb(sys.data?.server)
  const room = sys.data?.server.memTotalBytes != null && sys.data.server.memUsedBytes != null
    ? `${gb(sys.data.server.memTotalBytes - sys.data.server.memUsedBytes)} GB`
    : null

  const patch = () => patchOf(p, draft)
  const form = useFormErrors({ schema: updateProjectSchema, values: patch, idFor: (n) => `ct-${n}` })
  const dirty = editing && Object.keys(patch()).length > 0
  // UI-Qualität 8: Rückfrage beim Verlassen, auch nach einem Sprung aus der Fehlerbox (vorbelegt = geändert)
  useUnsaved(dirty, 'Container-Einstellungen')

  const save = useMutation({
    meta: { errorTitle: 'Container-Einstellungen nicht gespeichert' },
    mutationFn: (v: { patch: ContainerPatch; before: ContainerPatch; undo?: boolean }) => api.updateProject(p.id, v.patch),
    onSuccess: (_r, v) => {
      // Rückgängig aus dem Toast: Fokus bleibt, wo er ist
      if (editing) setRefocus(true)
      setEditing(false)
      setFrom(null)
      form.reset()
      void qc.invalidateQueries({ queryKey: ['project', p.id] })
      void qc.invalidateQueries({ queryKey: ['projects'] })
      onSaved?.(v.undo ? v.before : v.patch, Boolean(v.undo))
      setPending(v.undo ? null : patchText(v.patch))
      notifyOk(v.undo ? 'Rückgängig: Container-Einstellungen' : 'Container-Einstellungen gespeichert', {
        id: `container-${p.id}`,
        description: `${patchText(v.patch)}. Wirkt beim nächsten Deploy.`,
        undo: v.undo || Object.keys(v.before).length === 0 ? undefined : () => save.mutate({ patch: v.before, before: v.patch, undo: true }),
      })
    },
    onError: (err) => void form.setServerErrors(err),
  })

  // Nach Abbrechen bzw. Speichern zurück auf «Bearbeiten» (das Formular verschwindet, der Fokus nicht auf <body>)
  const editRef = useRef<HTMLButtonElement>(null)
  const [refocus, setRefocus] = useState(false)
  useEffect(() => {
    if (!refocus || editing) return
    editRef.current?.focus()
    setRefocus(false)
  }, [refocus, editing])
  const start = () => { setDraft(draftOf(p)); setFrom(null); form.reset(); setEditing(true); setFocus({ field: 'port', scroll: false }) }
  const cancel = () => { setEditing(false); setFrom(null); setDraft(draftOf(p)); form.reset(); setRefocus(true) }
  const submit = () => {
    if (!form.validateAll()) return
    const ch = patch()
    if (Object.keys(ch).length === 0) { cancel(); return }
    // Rückweg für «Rückgängig»; ein vorher fehlender Port lässt sich nicht wieder leeren
    const before: ContainerPatch = {}
    for (const k of Object.keys(ch) as ContainerKey[]) if (p[k] !== null) (before as Record<string, unknown>)[k] = p[k]
    save.mutate({ patch: ch, before })
  }

  // Aus der Fehlerbox: Feld vorbelegen. Der Vorschlag braucht den freien RAM; erst rechnen, wenn der Systemstatus da ist
  const sysReady = !sys.isLoading
  useEffect(() => {
    if (!request || (request.suggest && !sysReady)) return
    let value: string
    let text: string
    if (request.suggest && request.field === 'memoryLimitMb') {
      const s = suggestMemoryLimit({ currentMb: p.memoryLimitMb, serverFreeMb: freeMb, containerUsedMb: health.data?.container?.running ? mem?.now : 0 })
      value = String(s.value)
      text = suggestionText(s, fmtMb(p.memoryLimitMb), room)
    } else if (request.suggest && request.field === 'cpuLimit') {
      // Kernzahl des Servers ist nicht bekannt: höchstens 16 (Grenze der API)
      const s = suggestCpuLimit({ current: p.cpuLimit, serverCores: null })
      value = String(s.value)
      text = suggestionText(s, `${fmtCpu(p.cpuLimit)} CPU`, null)
    } else if (request.value !== undefined && request.value !== null) {
      value = String(request.value)
      text = request.field === 'port' ? `Aus dem Log: die App lauscht auf ${request.value} (bisher ${p.port ?? 'kein Port'}).` : `Bisher ${String(p[request.field] ?? '–')}.`
    } else {
      value = draftOf(p)[request.field]
      text = ''
    }
    setDraft((d) => ({ ...(editing ? d : draftOf(p)), [request.field]: value }))
    form.reset()
    setFrom(text ? { field: request.field, text } : null)
    setEditing(true)
    setFocus({ field: request.field, scroll: true })
    onShown?.()
  }, [request, sysReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fokus erst, wenn das Formular gerendert ist; markiert, damit Tippen den Vorschlag ersetzt
  useEffect(() => {
    if (!focus || !editing) return
    const el = document.getElementById(`ct-${focus.field}`) as HTMLInputElement | null
    if (!el) return
    if (focus.scroll) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      el.closest('.field')?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
    }
    el.focus({ preventScroll: focus.scroll })
    el.select()
    setFocus(null)
  }, [focus, editing])

  // Spitze nur, wenn sie über dem jetzigen Wert liegt (sonst ist «jetzt» die Spitze)
  const usage = (u: { now: number; peak: number } | null, f: (v: number) => string) => !u ? null
    : f(u.peak) === f(u.now) ? `jetzt ${f(u.now)}, zugleich die Spitze der letzten Stunde` : `jetzt ${f(u.now)}, Spitze ${f(u.peak)} in der letzten Stunde`
  const usageMem = usage(mem, fmtMb)
  const usageCpu = usage(cpu, fmtCpu)
  const noUsage = health.data?.container?.running === false || !p.activeDeployment || p.desiredState !== 'running'
    ? 'keine Messung, der Container läuft nicht' : 'noch keine Messung'
  const hint = (k: ContainerKey, base: string) => (from?.field === k ? <><strong className="set-strong">{from.text}</strong> {base}</> : base)
  const input = (k: ContainerKey, inputMode?: 'numeric' | 'decimal') => (
    <input
      {...form.field(k, `ct-${k}-hint`)}
      value={draft[k]}
      inputMode={inputMode}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
    />
  )

  return (
    <section className="set-card" id="set-container" aria-labelledby={titleId}>
      <div className="set-head">
        <h2 id={titleId} tabIndex={-1}>Container</h2>
        {!editing && <div className="set-head-actions"><button ref={editRef} type="button" className="button-small" onClick={start}>Bearbeiten</button></div>}
      </div>
      {!editing && (
        <>
          <SetRow label="Port im Container">
            {p.port === null ? <span className="muted">nicht gesetzt</span> : <><strong className="set-strong num">{p.port}</strong> <span className="muted">· dorthin gehen die Anfragen</span></>}
          </SetRow>
          <SetRow label="Healthcheck-Pfad">
            <code>{p.healthcheckPath}</code> <span className="muted">· muss mit 2xx oder 3xx antworten</span>
          </SetRow>
          <SetRow label="CPU-Grenze">
            <strong className="set-strong num">{fmtCpu(p.cpuLimit)} CPU</strong> <span className="muted">· {usageCpu ?? noUsage}</span>
          </SetRow>
          <SetRow label="RAM-Grenze">
            <strong className="set-strong num">{fmtMb(p.memoryLimitMb)}</strong> <span className="muted">· {usageMem ?? noUsage}</span>
          </SetRow>
        </>
      )}
      {editing && (
        <form className="set-row-block" noValidate ref={form.formRef} onSubmit={(ev) => { ev.preventDefault(); submit() }}>
          <div className="ct-fields">
            <Field id="ct-port" label="Port im Container" error={form.errors.port} hint={hint('port', 'Auf diesem Port lauscht die App, z.B. 80 oder 3000.')}>
              {input('port', 'numeric')}
            </Field>
            <Field id="ct-healthcheckPath" label="Healthcheck-Pfad" error={form.errors.healthcheckPath} hint={hint('healthcheckPath', 'Muss mit 2xx oder 3xx antworten, z.B. / oder /health.')}>
              {input('healthcheckPath')}
            </Field>
            <Field id="ct-cpuLimit" label="CPU-Grenze (Kerne)" error={form.errors.cpuLimit} hint={hint('cpuLimit', `0.1 bis 16. Verbrauch: ${usageCpu ?? noUsage}.`)}>
              {input('cpuLimit', 'decimal')}
            </Field>
            <Field id="ct-memoryLimitMb" label="RAM-Grenze (MB)" error={form.errors.memoryLimitMb}
              hint={hint('memoryLimitMb', `64 bis 32768. Verbrauch: ${usageMem ?? noUsage}.${room ? ` Frei auf dem Server: ${room}.` : ''}`)}>
              {input('memoryLimitMb', 'numeric')}
            </Field>
          </div>
          <div className="form-actions">
            <button type="submit" className="button-primary" disabled={save.isPending} aria-busy={save.isPending || undefined}>Speichern</button>
            <button type="button" onClick={cancel}>Abbrechen</button>
            <span className="hint">Wirkt beim nächsten Deploy.</span>
          </div>
        </form>
      )}
      {!editing && pending && (
        <div className="set-row set-row-toggle">
          <div className="set-row-value set-row-wide"><span className="set-strong">✓ {pending}</span> <span className="muted">· wirkt beim nächsten Deploy</span></div>
          <div className="set-row-action">
            <button type="button" className="button-small button-primary" onClick={onDeploy} disabled={deploying} aria-busy={deploying || undefined}>Neu deployen</button>
          </div>
        </div>
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
      {!q.data && q.isError ? <div className="set-row-note"><ErrorState compact plural what="Die Header-Regeln" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} /></div>
        : !q.data ? <Loading label="Header werden geladen" className="set-row-note"><SkLines n={2} /></Loading> : rules.length === 0 ? (
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

/* --- Statusseite (Etappe 5) ------------------------------------------------------- */

function StatusPageSection({ p }: { p: ProjectDto }) {
  const qc = useQueryClient()
  const titleId = useId()
  const labelId = useId()
  const isPublic = p.routes.some((r) => r.target === 'public')
  const explicit = p.showOnStatus ?? null
  const set = useMutation({
    meta: { errorTitle: 'Statusseite nicht geändert' },
    mutationFn: ({ show }: { show: boolean | null; before: boolean | null; undo?: boolean }) => api.updateProject(p.id, { showOnStatus: show }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ['project', p.id] })
      void qc.invalidateQueries({ queryKey: ['status-page'] })
      const on = showsOnStatusPage(v.show, isPublic)
      notifyOk(`${v.undo ? 'Rückgängig: ' : ''}«${p.name}» ${on ? 'steht auf der Statusseite' : 'nicht auf der Statusseite'}`, {
        id: `status-page-${p.id}`,
        description: v.show === null ? 'Wieder der Standard.' : on ? 'Mit Name, Zustand und Verfügbarkeit.' : 'Name und Verlauf erscheinen dort nicht mehr.',
        undo: v.undo ? undefined : () => set.mutate({ show: v.before, before: v.show, undo: true }),
      })
    },
  })
  const pendingShow = set.isPending ? set.variables?.show : undefined
  const value = showsOnStatusPage(pendingShow !== undefined ? pendingShow : explicit, isPublic)
  return (
    <section className="set-card" id="set-statusseite" aria-labelledby={titleId}>
      <div className="set-head">
        <h2 id={titleId} tabIndex={-1}>Statusseite</h2>
        {explicit !== null && (
          <div className="set-head-actions">
            <button type="button" className="button-small" onClick={() => set.mutate({ show: null, before: explicit })} disabled={set.isPending}>Standard verwenden</button>
          </div>
        )}
      </div>
      <SetRow label={<span id={labelId}>Auf Statusseite zeigen</span>} action={<Switch checked={value} labelledBy={labelId} busy={set.isPending} onChange={(v) => set.mutate({ show: v, before: explicit })} />}>
        <strong className="set-strong">{value ? 'An' : 'Aus'}</strong>
        <span className="muted"> · {explicit === null ? `Standard für ${isPublic ? 'öffentliche' : 'interne'} Projekte` : 'selbst gewählt'} · nur Name, Zustand und Verfügbarkeit, keine Adressen</span>
      </SetRow>
    </section>
  )
}

/* --- Auto-Deploy (nur Repo-Projekte) --------------------------------------------- */

function AutoDeploy({ projectId, on, checkedAt, viaApp }: { projectId: string; on: boolean; checkedAt: string | null; viaApp: boolean }) {
  const qc = useQueryClient()
  const titleId = useId()
  const labelId = useId()
  const set = useMutation({
    meta: { errorTitle: 'Auto-Deploy nicht geändert' },
    mutationFn: ({ enabled }: { enabled: boolean; undo?: boolean }) => api.setAutoDeploy(projectId, enabled),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ['auto-deploy', projectId] })
      notifyOk(`${v.undo ? 'Rückgängig: ' : ''}Auto-Deploy ${v.enabled ? 'an' : 'aus'}`, {
        id: `auto-deploy-${projectId}`,
        description: v.enabled ? 'Neue Commits gehen nach dem Merge von selbst live.' : 'Neue Commits deployst du selbst.',
        undo: v.undo ? undefined : () => set.mutate({ enabled: !v.enabled, undo: true }),
      })
    },
  })
  const value = set.isPending ? Boolean(set.variables?.enabled) : on
  return (
    <section className="set-card" id="set-auto-deploy" aria-labelledby={titleId}>
      <div className="set-head">
        <h2 id={titleId} tabIndex={-1}>Auto-Deploy</h2>
      </div>
      <SetRow label={<span id={labelId}>Nach Merge</span>} action={<Switch checked={value} labelledBy={labelId} busy={set.isPending} onChange={(v) => set.mutate({ enabled: v })} />}>
        <strong className="set-strong">{value ? 'An' : 'Aus'}</strong>
        <span className="muted"> · prüft alle 5 Minuten auf neue Commits{viaApp ? ' (GitHub App)' : ' (öffentliches Repo)'}{value && checkedAt ? ` · zuletzt ${relativeTime(checkedAt)}` : ''}</span>
      </SetRow>
    </section>
  )
}

/* --- Ablauf -------------------------------------------------------------------- */

/** «Behalten» an/aus, mit Toast und «Rückgängig» – gemeinsam für Eckdaten und Einstellungen */
export function useKeepToggle(p: { id: string; name: string }) {
  const qc = useQueryClient()
  const m = useMutation({
    meta: { errorTitle: 'Ablauf nicht geändert' },
    mutationFn: ({ keep }: { keep: boolean; undo?: boolean }) => api.updateProject(p.id, { keep }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ['project', p.id] })
      void qc.invalidateQueries({ queryKey: ['projects'] })
      notifyOk(`${v.undo ? 'Rückgängig: ' : ''}${v.keep ? `«${p.name}» läuft unbegrenzt` : `Ablauf für «${p.name}» wieder an`}`, {
        id: `keep-${p.id}`,
        description: v.keep ? 'Wird nicht mehr automatisch gestoppt.' : 'Stoppt, wenn sich lange nichts ändert.',
        undo: v.undo ? undefined : () => m.mutate({ keep: !v.keep, undo: true }),
      })
    },
  })
  return m
}

function Expiry({ p }: { p: ProjectDto }) {
  const titleId = useId()
  const keep = useKeepToggle(p)
  const files = p.sourceType === 'files'
  const date = fmtDate(p.expiresAt, '') || null
  return (
    <section className="set-card" id="set-ablauf" aria-labelledby={titleId}>
      <div className="set-head">
        <h2 id={titleId} tabIndex={-1}>Ablauf</h2>
        {files && (
          <div className="set-head-actions">
            {p.keep
              ? <button type="button" className="button-small" onClick={() => keep.mutate({ keep: false })} disabled={keep.isPending} aria-busy={keep.isPending || undefined}>Ablauf wieder aktivieren</button>
              : <button type="button" className="button-small" onClick={() => keep.mutate({ keep: true })} disabled={keep.isPending} aria-busy={keep.isPending || undefined}>Behalten</button>}
          </div>
        )}
      </div>
      <SetRow label={files ? 'Chat-Projekt' : 'Projekt'}>
        {!files ? <span className="muted">kein Ablauf ({p.sourceType === 'image' ? 'Image' : 'Repo oder Upload'})</span>
          : p.keep || !date ? <><strong className="set-strong">läuft unbegrenzt</strong> <span className="muted">· «Behalten» ist gesetzt</span></>
          : <><strong className="set-strong">stoppt am {date}</strong> <span className="muted">· wenn sich nichts ändert ({p.expiryDays ?? 30} Tage ohne Änderung)</span></>}
      </SetRow>
    </section>
  )
}

/* --- Gefahrenzone -------------------------------------------------------------- */

function DangerZone({ p, onDeleted, requested, onShown }: { p: ProjectDto; onDeleted: () => void; requested?: boolean; onShown?: () => void }) {
  const titleId = useId()
  const [open, setOpen] = useState(false)
  const [purge, setPurge] = useState(false)
  const ref = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  // Fehler zeigt der Dialog selbst (quiet), dort bleibt er offen
  const remove = useMutation({ mutationFn: () => api.deleteProject(p.id, purge), onSuccess: onDeleted, meta: { errorTitle: 'Projekt nicht gelöscht', noRetry: true, quiet: true } })
  const show = () => { setPurge(false); remove.reset(); setOpen(true) }
  // «Löschen …» aus dem Kopfmenü: zur Gefahrenzone und gleich der Dialog
  useEffect(() => {
    if (!requested) return
    show()
    requestAnimationFrame(() => {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ref.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
      onShown?.()
    })
  }, [requested]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="set-card set-danger danger-zone" id="set-gefahrenzone" aria-labelledby={titleId} ref={ref}>
      <div className="set-head"><h2 id={titleId} tabIndex={-1}>Gefahrenzone</h2></div>
      {/* «Verschieben …» (in eine andere Umgebung) erscheint hier, sobald es Umgebungen gibt (Meilenstein 9) */}
      <SetRow
        label="Löschen"
        action={<button ref={trigger} type="button" className="button-small button-danger" onClick={show}>Projekt löschen …</button>}
      >
        <span className="muted">Container, Dateien, Adressen und Verlauf werden entfernt</span>
      </SetRow>
      <ConfirmDialog
        open={open}
        title={<>«{p.name}» löschen?</>}
        confirmLabel="Endgültig löschen"
        busy={remove.isPending}
        error={remove.isError ? (remove.error as Error).message : null}
        typeToConfirm={{ value: p.slug, label: 'Kurzname zur Bestätigung' }}
        returnFocusTo={trigger}
        onCancel={() => setOpen(false)}
        onConfirm={() => remove.mutate()}
      >
        <p>Lässt sich nicht rückgängig machen. Öffentliche Namen, DNS-Einträge und die Tunnel-Regel gehen mit.</p>
        {p.runtimeKind !== 'static' && (
          <label className="choice">
            <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
            <span>Auch die Daten-Volumes löschen <small>Ohne Haken bleiben benannte Volumes (z.B. einer Datenbank) erhalten.</small></span>
          </label>
        )}
      </ConfirmDialog>
    </section>
  )
}

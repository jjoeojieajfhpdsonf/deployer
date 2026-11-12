import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { AddressRowInput, ContainerField, DeploymentDto, EnvEntryDto, FailureAction, FailureExplanation, ProjectDto, ProjectHealthDto, ResourceSample } from '@airlock/shared'
import { browserCanProbe, deployFixPrompt, envTexts, explainFailure, logTail, missingEnvVar, sourceSchema, splitAddresses } from '@airlock/shared'
import type { ContainerPatch, ContainerRequest } from './ProjectSettings.js'
import { copyText } from '../lib/clipboard.js'
import { FALLBACK_MS, poll } from '../lib/live.js'
import { Field } from './Field.js'
import { IconSpark } from './Actor.js'
import { api, probeUrl } from '../api.js'
import { relativeTime, shortVersion, since } from '../lib/format.js'
import { fmtDayTime, fmtTime, msOf } from '../lib/dates.js'
import { bundle, isNotifyEvent, isReadOnly } from '../lib/activity.js'
import { ActivityList } from './ActivityList.js'
import { IconWarn } from './Security.js'
import { DeployList, useDeployments } from './DeployList.js'
import { SecurityCard } from './SecurityCard.js'
import { VisitorsCard } from './Traffic.js'
import { KeyFacts } from './KeyFacts.js'
import { deployFailedState } from '../lib/projects.js'
import { IconBad, IconCheck, IconOk, IconPending } from './Icons.js'
import { EmptyState, ErrorState, Loading, PartialNote, Sk, SkLog, SkRows, errorReason } from './States.js'
import { useEnvPath } from '../lib/env.js'
import { useFixRequest } from '../lib/fix-request.js'

type Tab = 'uebersicht' | 'deployments' | 'logs' | 'besucher' | 'security' | 'einstellungen'

const svg = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
const IconCopy = () => <svg {...svg}><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" /></svg>

/** Läuft der Container der aktiven Fassung wirklich? (für Kopf und Übersicht) */
export function useProjectHealth(p: ProjectDto) {
  return useQuery({
    queryKey: ['health', p.id],
    queryFn: () => api.health(p.id, true),
    // Bestehender Dienst: ohne Fassung, Healthcheck = HTTP auf das Ziel
    enabled: (Boolean(p.activeDeployment) || p.sourceType === 'external') && p.desiredState === 'running',
    // Messwerte (CPU, RAM) sind keine Ereignisse: einmal pro Minute, Zustandswechsel kommen über den Strom
    refetchInterval: FALLBACK_MS,
  })
}

export function ProjectOverview({
  p, env, onTab, onDeploy, deploying, onRollback, onToggleKeep, keepBusy, onAddEnv, onContainerField, containerSaved,
}: {
  p: ProjectDto
  env: EnvEntryDto[]
  onTab: (t: Tab) => void
  onDeploy: () => void
  deploying: boolean
  onRollback: (deploymentId: string) => void
  onToggleKeep: () => void
  keepBusy?: boolean
  /** Fehlerbox «Hinzufügen»: zu den Einstellungen, Variable vorbelegt */
  onAddEnv: (name: string) => void
  /** Fehlerbox «Port ändern», «Grenze erhöhen» …: zu Einstellungen › Container, Feld vorbelegt */
  onContainerField: (r: ContainerRequest) => void
  /** Seit dem letzten Deploy unter Einstellungen › Container gespeichert */
  containerSaved: ContainerPatch
}) {
  const fix: FixProps = { onAddEnv, onContainerField, containerSaved }
  // Einzige Quelle: der Zustand vom Server (p.state). Die Gesundheitsabfrage liefert nur
  // Einzelheiten (Exit-Code, Messwerte), entscheidet aber nichts.
  const st = p.state.key
  const health = useProjectHealth(p)
  const h = health.data
  const live = st === 'running' || st === 'failed_old_running' || st === 'paused'
  const deployFailed = deployFailedState(p)
  const containerDown = st === 'down' && Boolean(p.activeDeployment)

  return (
    <div className="overview">
      {deployFailed && p.lastDeployment && (
        <DeployFailure p={p} env={env} dep={p.lastDeployment} stillRunning={st === 'failed_old_running'} onTab={onTab} onDeploy={onDeploy} deploying={deploying} fix={fix} />
      )}
      {containerDown && (
        <ContainerDown p={p} env={env} fix={fix} exitCode={h?.container?.exitCode ?? null} missing={Boolean(h?.container?.missing)} onTab={onTab} onDeploy={onDeploy} deploying={deploying} />
      )}

      <div className="overview-grid">
        <div className="overview-main">
          {/* Bestehender Dienst: Ziel und Healthcheck statt Container-Messwerten und Deploys */}
          {p.sourceType === 'external' && <ExternalPanel p={p} data={h ?? null} loading={health.isLoading} />}
          {p.sourceType !== 'external' && live && <HealthPanel p={p} loading={health.isLoading} data={h ?? null} />}
          {p.sourceType !== 'external' && (st === 'stopped' || (st === 'down' && !deployFailed && !containerDown) || st === 'deploying') && (
            <section className="panel panel-pad ov-section">
              <h2 className="ov-title">Zustand</h2>
              <p className="muted ov-empty">
                {st === 'stopped' ? 'Gestoppt. Die Adressen antworten erst wieder nach «Starten».'
                  : st === 'deploying' ? 'Ein Deploy läuft; der Fortschritt steht oben bei «Vorgänge».'
                  : 'Noch nichts deployt. «Neu deployen» startet die erste Fassung.'}
              </p>
            </section>
          )}
          {/* Etappe 3: Aufrufe und Besucher (fehlt ohne Adresse oder ohne Zugriffs-Log) */}
          <VisitorsCard p={p} onOpen={() => onTab('besucher')} />
          {p.sourceType !== 'external' && <DeployTimeline projectId={p.id} onTab={onTab} onRollback={onRollback} />}
          <SecurityCard p={p} onTab={onTab} />
          <Activity projectId={p.id} />
        </div>

        <aside className="overview-side" aria-label="Eckdaten">
          <Addresses p={p} down={containerDown} />
          <KeyFacts p={p} env={env} health={h ?? null} onTab={onTab} onToggleKeep={onToggleKeep} keepBusy={keepBusy} />
        </aside>
      </div>
    </div>
  )
}

/* --- Bestehender Dienst ------------------------------------------------------- */

/**
 * «Wird nicht von Airlock verwaltet»: Ziel, ob es gefunden wird, und der
 * Healthcheck (HTTP auf das Ziel). Keine Aktionen am Ziel – Airlock startet,
 * stoppt und ändert es nicht.
 */
function ExternalPanel({ p, data, loading }: { p: ProjectDto; data: ProjectHealthDto | null; loading: boolean }) {
  const e = p.external
  const missing = e?.found === false
  const hc = data?.health ?? null
  return (
    <section className="panel panel-pad ov-section ext-panel" aria-labelledby="ext-h">
      <h2 className="ov-title" id="ext-h">Wird nicht von Airlock verwaltet</h2>
      <p className="muted">
        {e?.mode === 'address'
          ? 'Läuft schon und bleibt, wie es ist: Airlock macht es nur erreichbar – kein Deploy, keine Änderung am Gerät.'
          : 'Läuft schon und bleibt, wie es ist: Airlock macht es nur erreichbar – kein Deploy, kein Neustart, keine Labels am Container.'}
      </p>
      <dl className="ext-facts">
        <div><dt>Ziel</dt><dd>{e?.label ?? '–'}</dd></div>
        {e?.image && <div><dt>Image</dt><dd><code>{e.image}</code></dd></div>}
        {e?.composeProject && <div><dt>Compose</dt><dd>{e.composeProject}{e.composeService ? ` · Dienst ${e.composeService}` : ''}</dd></div>}
        {e?.mode === 'container' && <div><dt>Weg für Caddy</dt><dd>{e.network === 'host' ? 'Host-Netz über host-gateway' : e.network ? `Netz ${e.network}` : '–'}</dd></div>}
        {e?.mode === 'address' && e.url?.startsWith('https:') && <div><dt>HTTPS zum Ziel</dt><dd>{e.insecureTls ? 'eigenes Zertifikat erlaubt' : 'Zertifikat wird geprüft'}</dd></div>}
        <div>
          <dt>Healthcheck</dt>
          <dd>
            {loading && !hc ? 'wird geprüft …'
              : !hc ? '–'
              : hc.ok ? <><IconOk /> antwortet{hc.status ? ` mit HTTP ${hc.status}` : ''} · {hc.ms} ms</>
              : <><IconBad /> {hc.error ?? 'antwortet nicht'}</>}
          </dd>
        </div>
      </dl>
      {missing && (
        <p className="ext-missing" role="status">
          <IconWarn /> <strong>Ziel fehlt.</strong> Airlock sucht den Container jede Minute am Namen und an den Compose-Labels.
          Bis er wieder da ist, zeigt die Adresse die Pause-Seite.
        </p>
      )}
    </section>
  )
}

/* --- Fehler ---------------------------------------------------------------- */

const LINES_FROM = { container: 'der Container-Ausgabe', build: 'des Build-Logs', deploy: 'des Deploy-Logs' } as const

/** Wohin die Aktionen der Fehlerbox führen (Einstellungen › Umgebung bzw. › Container) */
type FixProps = {
  onAddEnv: (name: string) => void
  onContainerField: (r: ContainerRequest) => void
  containerSaved: ContainerPatch
}

function DeployFailure({ p, env, dep, stillRunning, onTab, onDeploy, deploying, fix }: {
  p: ProjectDto; env: EnvEntryDto[]; dep: DeploymentDto; stillRunning: boolean; onTab: (t: Tab) => void; onDeploy: () => void; deploying: boolean
  fix: FixProps
}) {
  // UI-Qualität 2: Erklärung vom Server, beim Scheitern festgehalten (dieselbe wie im MCP-Ergebnis).
  // Nur ältere Deployments ohne gespeicherte Erklärung brauchen das Log, um sie hier zu bilden.
  const stored = dep.failure ?? null
  const d = useQuery({ queryKey: ['deployment', dep.id], queryFn: () => api.getDeployment(dep.id), enabled: !stored })
  const f = stored ?? (d.data
    ? explainFailure({
        message: dep.errorMessage, log: d.data.log, port: p.port, healthcheckPath: p.healthcheckPath,
        image: (p.source as { image?: string } | null)?.image ?? null, memoryLimitMb: p.memoryLimitMb,
        envKeys: env.map((e) => e.key), sourceType: p.sourceType,
      })
    : null)
  return (
    <section className="failure" aria-labelledby="failure-title">
      <div className="failure-head">
        <span className="failure-icon"><IconBad /></span>
        <div>
          {/* Bis die Erklärung da ist: «Deploy fehlgeschlagen», nicht eine vorläufige, die gleich wechselt */}
          <h2 id="failure-title">{f?.title ?? 'Deploy fehlgeschlagen'}</h2>
          <p className="failure-meta">
            Deploy {relativeTime(dep.startedAt)}{dep.version ? <> · <code>{shortVersion(dep.version)}</code></> : null}
            {stillRunning ? ' · die vorherige Fassung läuft weiter' : ' · nichts läuft'}
          </p>
        </div>
      </div>
      {f ? <p className="failure-cause">{f.cause}</p> : !d.isError && <Loading label="Erklärung wird geladen"><SkLog n={2} /></Loading>}
      <div className="failure-log">
        <div className="failure-log-head">
          <span>{f ? linesLabel(f.lines.length, LINES_FROM[f.linesFrom]) : 'Ende des Deploy-Logs'}</span>
          <button type="button" className="link-button" onClick={() => onTab('deployments')}>Ganzes Log</button>
        </div>
        {/* Teilweise: Ursache und Aktionen stehen auch ohne Log */}
        {f ? <LogLines lines={f.lines} label={`Letzte Zeilen ${LINES_FROM[f.linesFrom]}`} empty="Für dieses Deployment wurde kein Log gespeichert." />
          : d.isError ? <PartialNote onRetry={() => void d.refetch()}>Das Deploy-Log ist gerade nicht abrufbar ({errorReason(d.error)})</PartialNote>
          : <Loading label="Log wird geladen"><SkLog n={6} /></Loading>}
      </div>
      <FailureActions p={p} env={env} f={f} onDeploy={onDeploy} deploying={deploying} fix={fix} />
    </section>
  )
}

/** «Letzte Zeile» bzw. «Letzte 5 Zeilen» */
const linesLabel = (n: number, from: string) => (n === 1 ? `Letzte Zeile ${from}` : `Letzte ${n} Zeilen ${from}`)

/** Logzeilen: scrollbar und per Tastatur erreichbar, mit Namen für Screenreader */
function LogLines({ lines, label, empty }: { lines: string[]; label: string; empty: string }) {
  return (
    <pre className="log log-failure" role="region" aria-label={label} tabIndex={0}>{lines.join('\n') || empty}</pre>
  )
}

function ContainerDown({ p, env, exitCode, missing, onTab, onDeploy, deploying, fix }: {
  p: ProjectDto; env: EnvEntryDto[]; exitCode: number | null; missing: boolean; onTab: (t: Tab) => void; onDeploy: () => void; deploying: boolean
  fix: FixProps
}) {
  const logs = useQuery({ queryKey: ['logs-tail', p.id], queryFn: () => api.getLogs(p.id, 15), enabled: !missing, retry: false })
  const lines = logTail(logs.data?.logs ?? '', 15)
  // Dieselben Muster und Worte wie beim Deploy: fehlende Variable (envTexts), Speichergrenze
  const envName = logs.data ? missingEnvVar(lines) : null
  const envT = envName ? envTexts(envName, env.some((e) => e.key === envName)) : null
  const exited = exitCode !== null ? ` (Exit-Code ${exitCode})` : ''
  const action: FailureAction | null = missing ? null
    : envT ? envT.action
    : exitCode === 137 ? { kind: 'set_field', field: 'memoryLimitMb', value: null, label: 'Grenze erhöhen' }
    : null
  const title = missing ? 'Container fehlt' : envT ? envT.title : exitCode !== null ? `Container hat sich beendet${exited}` : 'Container läuft nicht'
  const cause = missing
    ? 'Der Container der aktiven Fassung existiert nicht mehr – er wurde von Hand entfernt, oder der Neustart nach einem Server-Neustart ist gescheitert. Die Adressen antworten nicht. «Erneut deployen» baut ihn neu auf.'
    : envT
    ? `Der Container hat sich beendet${exited}. ${envT.cause}`
    : exitCode === 137
    ? `Der Container wurde beendet (Exit-Code 137) – meist, weil er mehr RAM brauchte als erlaubt (Grenze ${p.memoryLimitMb.toLocaleString('de-CH')} MB).`
    : `Der Container hat sich beendet${exited}. Die Ursache steht meist in den letzten Zeilen seiner Ausgabe.`
  return (
    <section className="failure" aria-labelledby="failure-title">
      <div className="failure-head">
        <span className="failure-icon"><IconBad /></span>
        <div><h2 id="failure-title">{title}</h2><p className="failure-meta">Der letzte Deploy war erfolgreich, der Container ist danach ausgefallen</p></div>
      </div>
      <p className="failure-cause">{cause}</p>
      {!missing && <div className="failure-log">
        <div className="failure-log-head"><span>{logs.data ? linesLabel(lines.length, 'der Container-Ausgabe') : 'Container-Ausgabe'}</span><button type="button" className="link-button" onClick={() => onTab('logs')}>Logs</button></div>
        {!logs.data && logs.isError ? <PartialNote onRetry={() => void logs.refetch()}>Die Container-Ausgabe ist gerade nicht abrufbar ({errorReason(logs.error)})</PartialNote>
          : !logs.data ? <Loading label="Ausgabe wird geladen"><SkLog n={6} /></Loading>
          : <LogLines lines={lines} label="Letzte Zeilen der Container-Ausgabe" empty={logs.data.hint || 'Der Container hat nichts ausgegeben.'} />}
      </div>}
      <FailureActions
        p={p}
        env={env}
        f={action ? { kind: 'exited', title, cause, action, lines, linesFrom: 'container', exitCode } : null}
        onDeploy={onDeploy}
        deploying={deploying}
        fix={fix}
      />
    </section>
  )
}

const FIELD_DONE: Record<ContainerField, (v: string | number) => string> = {
  port: (v) => `Port ist jetzt ${v}.`,
  healthcheckPath: (v) => `Healthcheck-Pfad ist jetzt ${v}.`,
  memoryLimitMb: (v) => `RAM-Grenze ist jetzt ${Number(v).toLocaleString('de-CH')} MB.`,
}

/**
 * Knöpfe der Fehlerbox: die vorgeschlagene Aktion zuerst, dann «Erneut
 * deployen». Einstellungen, die die Aktion ändert, wirken beim nächsten Deploy.
 * Antwort 8: Port, Healthcheck-Pfad und RAM-Grenze ändert man im Abschnitt
 * Container der Einstellungen (Feld vorbelegt und fokussiert); nur das Image
 * bleibt ein Feld in der Box.
 */
function FailureActions({ p, env, f, onDeploy, deploying, fix }: {
  p: ProjectDto; env: EnvEntryDto[]; f: FailureExplanation | null; onDeploy: () => void; deploying: boolean; fix: FixProps
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState<'claude' | 'image' | null>(null)
  const [done, setDone] = useState('')
  const a = f?.action ?? null
  const save = useMutation({
    meta: { errorTitle: 'Image nicht geändert' },
    mutationFn: (image: string) => api.updateProject(p.id, { source: { ...(p.source as object), image } }),
    onSuccess: (_r, image) => {
      setDone(`Image ist jetzt ${image}.`)
      setOpen(null)
      void qc.invalidateQueries({ queryKey: ['project', p.id] })
    },
  })
  const isImage = p.sourceType === 'image'
  // Ursache schon behoben (Variable inzwischen gesetzt, Port schon geändert, Grenze unter
  // Einstellungen erhöht)? Dann bleibt die Erklärung des alten Deploys stehen, und «Erneut
  // deployen» ist der nächste Schritt.
  const saved = a?.kind === 'set_field' ? fix.containerSaved[a.field] : undefined
  const applied = a?.kind === 'add_env' && !a.exists && env.some((e) => e.key === a.name)
    ? `${a.name} ist jetzt gesetzt.`
    : a?.kind === 'set_field' && saved !== undefined
    ? FIELD_DONE[a.field](saved)
    : a?.kind === 'set_field' && a.value !== null && p[a.field] === a.value
    ? FIELD_DONE[a.field](a.value)
    : done || null
  // preview_env: die Ebene «Vorschau» liegt beim Projekt, nicht bei der Vorschau (Link in Deployments › Vorschauen)
  const ownAction = !applied && a && a.kind !== 'redeploy' && a.kind !== 'preview_env' && !(a.kind === 'change_source' && !isImage)
  const toggle = (k: 'claude' | 'image') => { setDone(''); setOpen((o) => (o === k ? null : k)) }
  // Etappe 7: Disketti «Ja» öffnet «Mit Claude lösen» (wenn die Box ihn anbietet)
  useFixRequest(p.lastDeployment ? `deploy:${p.lastDeployment.id}` : null, Boolean(ownAction && a?.kind === 'claude'), () => { setDone(''); setOpen('claude') })
  const panelId = useId()
  // aria-controls nur, solange das Feld existiert
  const controls = (k: 'claude' | 'image') => ({ 'aria-expanded': open === k, 'aria-controls': open === k ? panelId : undefined })
  return (
    <>
      <div className="failure-actions">
        {ownAction && a?.kind === 'add_env' && <button type="button" className="button-primary" onClick={() => fix.onAddEnv(a.name)}>{a.label}</button>}
        {ownAction && a?.kind === 'set_field' && (
          // Port aus dem Log vorbelegt; RAM mit dem Vorschlag (Verdopplung, gedeckelt durch den Server)
          <button type="button" className="button-primary"
            onClick={() => fix.onContainerField({ field: a.field, value: a.value, suggest: a.field === 'memoryLimitMb' && a.value === null })}>
            {a.label}
          </button>
        )}
        {ownAction && a?.kind === 'change_source' && (
          <button type="button" className="button-primary" {...controls('image')} onClick={() => toggle('image')}>{a.label}</button>
        )}
        {ownAction && a?.kind === 'claude' && (
          <button type="button" className="button-primary" {...controls('claude')} onClick={() => toggle('claude')}>
            <span className="claude-spark"><IconSpark /></span>{a.label}
          </button>
        )}
        <button type="button" className={ownAction ? undefined : 'button-primary'} onClick={onDeploy} disabled={deploying} aria-busy={deploying || undefined}>Erneut deployen</button>
        <span className="fix-note" role="status">{applied && <>{applied} Wirksam beim nächsten Deploy.</>}</span>
      </div>
      {open === 'image' && (
        <ImageFix id={panelId} current={(p.source as { image?: string } | null)?.image ?? ''} busy={save.isPending}
          onSave={(v) => save.mutate(v)} onCancel={() => setOpen(null)} />
      )}
      {open === 'claude' && f && (
        <ClaudePrompt id={panelId} prompt={deployFixPrompt({ projectName: p.name, slug: p.slug, sourceType: p.sourceType, explanation: f })} />
      )}
    </>
  )
}

/** Image direkt in der Fehlerbox ändern (geprüft wie in der API) */
function ImageFix({ id, current, busy, onSave, onCancel }: {
  id: string; current: string; busy: boolean; onSave: (v: string) => void; onCancel: () => void
}) {
  // Zum Bearbeiten vorbelegt: meist ist nur der Tag falsch
  const [value, setValue] = useState(current)
  const [error, setError] = useState<string | undefined>()
  const inputId = `${id}-input`
  const cancelRef = useRef<HTMLButtonElement>(null)
  const check = (): string | null => {
    const r = sourceSchema.safeParse({ type: 'image', image: value.trim() })
    if (!r.success) { setError(r.error.issues[0]?.message ?? 'Ungültiges Image'); return null }
    return value.trim()
  }
  return (
    <form id={id} className="failure-fix" noValidate onSubmit={(e) => { e.preventDefault(); const v = check(); if (v !== null) onSave(v) }}>
      <Field id={inputId} label="Image (Name und Tag)" error={error} hint="Wirksam beim nächsten Deploy.">
        <input
          id={inputId}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- geöffnet auf Klick, Eingabe ist der nächste Schritt
          autoFocus
          value={value}
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : `${inputId}-hint`}
          onChange={(e) => { setValue(e.target.value); setError(undefined) }}
          // Beim Verlassen prüfen – aber nicht, wenn es zu «Abbrechen» geht
          onBlur={(e) => { if (value.trim() !== '' && e.relatedTarget !== cancelRef.current) check() }}
        />
      </Field>
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={busy} aria-busy={busy || undefined}>Speichern</button>
        <button type="button" ref={cancelRef} onClick={onCancel}>Abbrechen</button>
      </div>
    </form>
  )
}

/** «Mit Claude lösen»: fertiger Auftrag zum Kopieren */
function ClaudePrompt({ id, prompt }: { id: string; prompt: string }) {
  const [copied, setCopied] = useState<'ok' | 'manual' | null>(null)
  return (
    <div id={id} className="claude-fix failure-fix">
      <p className="claude-fix-label">Auftrag für Claude oder Claude Code (mit dem Airlock-MCP verbunden):</p>
      <pre className="code-block" role="region" aria-label="Auftrag für Claude" tabIndex={0}>{prompt}</pre>
      <div className="claude-fix-actions">
        <button type="button" className="button-small button-primary" onClick={async () => setCopied((await copyText(prompt)) ? 'ok' : 'manual')}>Auftrag kopieren</button>
        <span role="status" className="fix-note">
          {copied === 'ok' && 'Kopiert. In Claude einfügen.'}
          {copied === 'manual' && 'Kopieren ging nicht. Bitte den Text oben von Hand markieren.'}
        </span>
      </div>
    </div>
  )
}

/* --- Zustand --------------------------------------------------------------- */

function fmtCpu(v: number): string {
  return v.toLocaleString('de-CH', { minimumFractionDigits: v >= 1 && Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })
}

function HealthPanel({ p, loading, data }: { p: ProjectDto; loading: boolean; data: import('@airlock/shared').ProjectHealthDto | null }) {
  const isStatic = data?.kind === 'static' || p.runtimeKind === 'static'
  const c = data?.container
  const hc = data?.health
  return (
    <section className="panel panel-pad ov-section" aria-labelledby="ov-state">
      <h2 className="ov-title" id="ov-state">Zustand</h2>
      <dl className="state-rows">
        <dt>Laufzeit</dt>
        <dd>
          {isStatic ? <span>Statische Seite, Caddy liefert sie direkt aus</span>
            : loading ? <Sk w={180} h={13} />
            : c?.startedAt ? <><strong className="state-strong">läuft {since(c.startedAt).replace(/^seit /, 'seit ')}</strong> <span className="muted">· gestartet {fmtDayTime(c.startedAt)}</span></>
            : <span className="muted">unbekannt</span>}
        </dd>

        <dt>Healthcheck</dt>
        <dd>
          {isStatic ? <span className="muted">entfällt bei statischen Seiten</span>
            : !hc ? <span className="hc hc-pending"><IconPending /> {loading ? 'Prüfung läuft' : 'noch keiner seit dem Start'}</span>
            : hc.ok ? <span className="hc hc-ok"><IconOk /> gesund <span className="hc-detail">HTTP {hc.status} auf {hc.url} · {hc.ms} ms · {relativeTime(hc.at).replace('gerade eben', 'eben')}</span></span>
            : <span className="hc hc-bad"><IconBad /> antwortet nicht <span className="hc-detail">{hc.error} · {hc.url} · {relativeTime(hc.at)}</span></span>}
        </dd>
      </dl>
      {!isStatic && (
        <div className="ov-meters">
          <Meter label="CPU" unit="CPU" limit={p.cpuLimit} samples={data?.samples ?? []} pick={(s) => s.cpu} fmt={fmtCpu} />
          <Meter label="RAM" unit="MB" limit={p.memoryLimitMb} samples={data?.samples ?? []} pick={(s) => s.memMb} fmt={(v) => Math.round(v).toLocaleString('de-CH')} />
        </div>
      )}
    </section>
  )
}

/**
 * Verlauf der letzten Stunde gegen die Grenze: die Grenze ist die Oberkante,
 * so sieht man sofort, wie viel Luft bleibt. Ein Wert pro Minute.
 */
export function Meter({ label, unit, limit, samples: all, pick, fmt }: {
  label: string; unit: string; limit: number; samples: ResourceSample[]; pick: (s: ResourceSample) => number; fmt: (v: number) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  // Messpunkte mit ungültiger Zeit fallen weg, statt die Linie zu zerreissen
  const samples = all.filter((s) => msOf(s.at) !== null)
  const W = 300
  const H = 56
  const values = samples.map(pick)
  const now = values.at(-1) ?? null
  const peak = values.length ? Math.max(...values) : null
  const ratio = now !== null && limit ? now / limit : 0
  const tone = ratio >= 0.9 ? 'bad' : ratio >= 0.7 ? 'warn' : 'ok'
  // Zeitachse: 60 Minuten, rechts ist jetzt
  const t0 = Date.now() - 60 * 60_000
  const x = (t: number) => Math.max(0, Math.min(W, ((t - t0) / (60 * 60_000)) * W))
  const y = (v: number) => H - Math.min(1, v / limit) * (H - 2) - 1
  // Messpunkte mit ungültiger Zeit fallen weg statt die Linie zu zerreissen
  const pts = samples.map((s) => [x(msOf(s.at)!), y(pick(s))] as const)
  const line = pts.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}`).join(' ')
  const area = pts.length ? `${line} L${pts.at(-1)![0].toFixed(1)},${H} L${pts[0]![0].toFixed(1)},${H} Z` : ''
  const hv = hover !== null ? samples[hover] : null

  return (
    <figure className={`ov-meter ov-meter-${tone}`}>
      <figcaption className="ov-meter-head">
        <span className="ov-meter-label">{label}</span>
        <span className="ov-meter-value">
          {now === null ? <span className="muted">noch kein Wert</span> : <><strong>{fmt(now)}</strong> <span className="muted">von {fmt(limit)} {unit}</span></>}
        </span>
      </figcaption>
      <div className="ov-meter-plot">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={now === null ? `${label}: noch keine Messung` : `${label} letzte Stunde: jetzt ${fmt(now)} von ${fmt(limit)} ${unit}, Spitze ${fmt(peak!)}`}
          onMouseMove={(e) => {
            if (!pts.length) return
            const r = e.currentTarget.getBoundingClientRect()
            const mx = ((e.clientX - r.left) / r.width) * W
            let best = 0
            pts.forEach(([a], i) => { if (Math.abs(a - mx) < Math.abs(pts[best]![0] - mx)) best = i })
            setHover(best)
          }}
          onMouseLeave={() => setHover(null)}
        >
          <line x1="0" x2={W} y1="1" y2="1" className="ov-meter-limit" vectorEffect="non-scaling-stroke" />
          <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} className="ov-meter-base" vectorEffect="non-scaling-stroke" />
          {area && <path d={area} className="ov-meter-area" />}
          {pts.length > 1 && <path d={line} className="ov-meter-line" vectorEffect="non-scaling-stroke" />}
          {hv && <line x1={pts[hover!]![0]} x2={pts[hover!]![0]} y1="0" y2={H} className="ov-meter-cross" vectorEffect="non-scaling-stroke" />}
        </svg>
        {pts.length === 1 && <span className="ov-meter-dot" style={{ left: `${(pts[0]![0] / W) * 100}%`, top: `${(pts[0]![1] / H) * 100}%` }} aria-hidden="true" />}
        {hv && (
          <span className="ov-meter-tip" style={{ left: `${(pts[hover!]![0] / W) * 100}%` }}>
            {fmtTime(hv.at)} · {fmt(pick(hv))} {unit}
          </span>
        )}
      </div>
      <div className="ov-meter-foot">
        <span>vor 60 Min.</span>
        <span>{peak !== null ? <>Spitze {fmt(peak)} {unit}</> : `Grenze ${fmt(limit)} ${unit}`}</span>
        <span>jetzt</span>
      </div>
    </figure>
  )
}

/* --- Deployments ------------------------------------------------------------ */

function DeployTimeline({ projectId, onTab, onRollback }: { projectId: string; onTab: (t: Tab) => void; onRollback: (id: string) => void }) {
  const list = useDeployments(projectId)
  const rows = list.data?.deployments ?? []
  const total = rows[0]?.seq ?? rows.length

  return (
    <section className="panel panel-pad ov-section" aria-labelledby="ov-deploys">
      <div className="ov-head">
        <h2 className="ov-title" id="ov-deploys">Deployments</h2>
        {total > 0 && <button type="button" className="link-button" onClick={() => onTab('deployments')}>Alle {total}</button>}
      </div>
      {!list.data && list.isError ? <ErrorState compact plural what="Die Deployments" error={list.error} retrying={list.isFetching} onRetry={() => void list.refetch()} />
        : !list.data ? <Loading label="Deployments werden geladen"><SkRows n={3} card={false} /></Loading>
        : rows.length === 0 ? <EmptyState compact title="Noch kein Deployment.">Das erste startet nach dem Anlegen von selbst.</EmptyState> : (
        <DeployList projectId={projectId} rows={rows} limit={5} onRollback={onRollback} />
      )}
    </section>
  )
}

/* --- Security ---------------------------------------------------------------- */

/* --- Aktivität ---------------------------------------------------------------- */

/** Höchstens so viele Einträge in der Karte */
const ACTIVITY_SHOWN = 5

function Activity({ projectId }: { projectId: string }) {
  const ep = useEnvPath()
  const a = useQuery({ queryKey: ['audit-project', projectId], queryFn: () => api.audit(60, projectId), refetchInterval: poll })
  const items = useMemo(() => bundle((a.data?.events ?? []).filter((e) => !isReadOnly(e) && !isNotifyEvent(e))), [a.data])
  const shown = items.slice(0, ACTIVITY_SHOWN)
  const more = items.length - shown.length
  return (
    <section className="panel panel-pad ov-section" aria-labelledby="ov-act">
      <div className="ov-head">
        <h2 className="ov-title" id="ov-act">Aktivität</h2>
        <Link to={ep('/audit')}>Audit-Log</Link>
      </div>
      {!a.data && a.isError ? <ErrorState compact what="Die Aktivität" error={a.error} retrying={a.isFetching} onRetry={() => void a.refetch()} />
        : !a.data ? <Loading label="Aktivität wird geladen"><SkRows n={3} card={false} /></Loading>
        : <ActivityList items={shown} />}
      {more > 0 && (
        <p className="act-more">
          {a.data && a.data.events.length >= 60 ? 'Weitere Ereignisse' : `Weitere ${more} ${more === 1 ? 'Ereignis' : 'Ereignisse'}`} · <Link to={ep(`/audit?projekt=${projectId}`)}>Alle anzeigen</Link>
        </p>
      )}
    </section>
  )
}

/* --- Adressen ------------------------------------------------------------------- */

const WAY_LABEL: Record<string, string> = { lan: 'LAN', tailnet: 'Tailnet', public: 'Öffentlich' }

function Addresses({ p, down }: { p: ProjectDto; down: boolean }) {
  const { primary, more } = splitAddresses(p.routes)
  // Bestehender Dienst: aktiv, solange das Ziel gefunden wird (ohne Fassung)
  const live = p.desiredState === 'running' && (Boolean(p.activeDeployment) || (p.sourceType === 'external' && p.external?.found !== false)) && !down
  const idle = down ? 'antwortet nicht' : 'nicht aktiv'
  const row = (r: AddressRowInput) => <AddressRow key={r.url} projectId={p.id} url={r.url} ways={r.ways} access={r.access} live={live} idle={idle} />
  const viaServer = live && [...primary, ...more].some((r) => !browserCanProbe(r.url, window.location.protocol))
  return (
    <section className="panel panel-pad ov-section" aria-labelledby="ov-addr">
      <h2 className="ov-title" id="ov-addr">Adressen</h2>
      {primary.length === 0 && more.length === 0 ? <p className="muted ov-empty">Keine. Unter Einstellungen → Erreichbarkeit festlegen.</p> : (
        <ul className="addr-list">{primary.map(row)}</ul>
      )}
      {more.length > 0 && (
        <details className="addr-more">
          <summary>Weitere Adressen ({more.length})</summary>
          <p className="hint">nip.io-Namen ohne Zertifikat, für Geräte ohne passenden DNS.</p>
          <ul className="addr-list">{more.map(row)}</ul>
        </details>
      )}
      {primary.length + more.length > 0 && live && (
        <p className="ov-foot">{viaServer ? 'https-Adressen geprüft von diesem Gerät aus, http-Adressen vom Server aus.' : 'Geprüft von diesem Gerät aus.'}</p>
      )}
    </section>
  )
}

type AddrState = 'idle' | 'checking' | 'ok' | 'bad' | 'routed' | 'unchecked'

function AddressRow({ projectId, url, ways, access, live, idle }: { projectId: string; url: string; ways: string[]; access: boolean; live: boolean; idle: string }) {
  const [state, setState] = useState<AddrState>('idle')
  const [detail, setDetail] = useState('')
  const [copied, setCopied] = useState(false)
  // Auf einer https-Seite blockiert der Browser http-Adressen (Mixed Content):
  // dann prüft der Server über Caddy, und das steht dabei.
  const byServer = !browserCanProbe(url, window.location.protocol)
  const check = () => {
    setState('checking')
    if (!byServer) {
      void probeUrl(url).then((ok) => { setDetail(''); setState(ok ? 'ok' : 'bad') })
      return
    }
    api.addressCheck(projectId, url).then((r) => {
      setDetail(r.detail)
      setState(r.state === 'ok' ? 'ok' : r.state === 'routed' ? 'routed' : r.state === 'error' ? 'unchecked' : 'bad')
    }).catch((err: Error) => {
      setDetail(err.message)
      setState('unchecked')
    })
  }
  useEffect(() => {
    if (live) check()
    else setState('idle')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, live])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ohne Zwischenablage (http) bleibt die Adresse markierbar */ }
  }
  const host = url.replace(/^https?:\/\//, '')
  return (
    <li className="addr">
      <div className="addr-top">
        <a className="addr-url" href={url} target="_blank" rel="noreferrer" title={url}>{host}</a>
        <button type="button" className="icon-button" onClick={copy} aria-label={copied ? 'Kopiert' : `${host} kopieren`} title={copied ? 'Kopiert' : 'Kopieren'}>
          {copied ? <IconCheck /> : <IconCopy />}
        </button>
      </div>
      <div className="addr-bottom">
        <span className="addr-ways">{ways.map((w) => WAY_LABEL[w] ?? w).join(' · ')}{access ? ' · Cloudflare Access' : ''}</span>
        {!live ? <span className={idle === 'antwortet nicht' ? 'addr-state addr-bad' : 'addr-state addr-idle'}>{idle === 'antwortet nicht' && <IconBad />}{idle}</span>
          : state === 'checking' ? <span className="addr-state addr-checking"><IconPending /> prüft…</span>
          : state === 'ok' ? <span className="addr-state addr-ok" title={detail || undefined}><IconOk /> erreichbar{byServer ? ' · vom Server geprüft' : ''}</span>
          : state === 'routed' ? <span className="addr-state addr-ok" title={detail}><IconOk /> Route aktiv · vom Server geprüft</span>
          : state === 'unchecked' ? <button type="button" className="addr-state addr-idle link-button" onClick={check} title={`${detail} Nochmals prüfen.`}><IconPending /> nicht vom Browser prüfbar (http)</button>
          : state === 'bad' ? <button type="button" className="addr-state addr-bad link-button" onClick={check} title={detail ? `${detail} Nochmals prüfen.` : 'Nochmals prüfen'}><IconBad /> nicht erreichbar{byServer ? ' · vom Server geprüft' : ''}</button>
          : null}
      </div>
    </li>
  )
}


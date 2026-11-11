import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BACKUP_DEFAULT_RETENTION, backupSettingsInputSchema,
  type BackupProjectMode, type BackupRunDto, type BackupSettingsDto, type BackupSnapshotDto, type BackupStatusDto,
} from '@airlock/shared'
import { api, ApiError } from '../api.js'
import { ErrorState, EmptyState, Loading, PartialNote, SkCard, SkRows } from './States.js'
import { Field } from './Field.js'
import { useFormErrors } from '../lib/form.js'
import { useUnsaved } from '../lib/unsaved.js'
import { notifyOk } from '../lib/feedback.js'
import { duration, relativeTime, inTime } from '../lib/format.js'
import { fmtDateTimeShort } from '../lib/dates.js'
import { FALLBACK_MS } from '../lib/live.js'
import { IconAlert } from './Icons.js'
import { KeySection, KeyWarning } from './BackupKey.js'

/**
 * Meilenstein Backup, Etappe 3: Server › Backup. Stand (letztes erfolgreiches
 * Backup, Grösse, Dauer, Ziel), «Jetzt sichern», letzte Läufe, Stände im
 * Repository und die Einstellungen. Geheimnisse (Repository-Passwort,
 * S3-Schlüssel) gehen nur hinein; die API sagt nur, ob sie gesetzt sind.
 */

/** Während eines Laufs öfter nachsehen; sonst wie die übrigen Messwerte */
export const BACKUP_RUNNING_POLL_MS = 3_000

export function useBackupStatus() {
  return useQuery({
    queryKey: ['backup'],
    queryFn: api.backup,
    refetchInterval: (q) => (q.state.data?.running ? BACKUP_RUNNING_POLL_MS : FALLBACK_MS),
  })
}

/** «12,4 MB», «1,2 GB», «830 KB» */
export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '–'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${v.toLocaleString('de-CH', { maximumFractionDigits: i === 0 || v >= 100 ? 0 : 1 })} ${units[i]}`
}

export function describeTarget(s: BackupSettingsDto): string {
  const t = s.target
  if (!t) return 'kein Ziel'
  if (t.kind === 'local') return `lokal ${t.path}`
  return `S3 ${t.endpoint.replace(/^https?:\/\//, '')}/${t.bucket}${t.prefix ? `/${t.prefix}` : ''}`
}

const RUN_STATUS: Record<BackupRunDto['status'], { label: string; cls: string }> = {
  running: { label: 'Läuft', cls: 'status-deploying' },
  ok: { label: 'Gesichert', cls: 'status-running' },
  warning: { label: 'Mit Hinweisen', cls: 'status-warn' },
  failed: { label: 'Fehlgeschlagen', cls: 'status-failed' },
}

export function RunStatus({ status }: { status: BackupRunDto['status'] }) {
  const s = RUN_STATUS[status]
  return <span className={`status ${s.cls}`}><span className="status-dot" aria-hidden="true" />{s.label}</span>
}

export function BackupSection() {
  const q = useBackupStatus()
  if (!q.data) {
    return q.isError
      ? <ErrorState what="Der Stand der Sicherung" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
      : <Loading label="Sicherung wird geladen"><SkCard lines={5} /><SkCard lines={4} className="sk-gap-lg" /></Loading>
  }
  const s = q.data
  return (
    <div className="backup">
      <BackupWarnings s={s} />
      <KeyWarning k={s.key} />
      <BackupOverview s={s} />
      <BackupRuns runs={s.runs} />
      {s.settings.configured && <BackupSnapshots />}
      <KeySection k={s.key} />
      <BackupSettingsForm s={s} />
    </div>
  )
}

function BackupWarnings({ s }: { s: BackupStatusDto }) {
  const last = s.lastRun
  return (
    <>
      {s.stale && (
        <div role="alert" className="banner banner-warn">
          <p>
            <strong>Seit über 48 Stunden kein erfolgreiches Backup.</strong>{' '}
            {s.lastSuccessAt ? <>Das letzte ist vom {fmtDateTimeShort(s.lastSuccessAt)}.</> : 'Es gibt noch keins.'}
            {last?.status === 'failed' && last.error ? <> Letzter Fehler: {last.error}</> : null}
          </p>
        </div>
      )}
      {!s.settings.configured && (
        <p className="banner banner-info">
          <strong>Die Sicherung ist noch nicht eingerichtet.</strong> Unten Ziel und Repository-Passwort
          festlegen, speichern und «Verbindung testen» – danach sichert Airlock jede Nacht.
        </p>
      )}
      {s.settings.configured && !s.settings.enabled && (
        <p className="banner banner-warn">
          <strong>Der nächtliche Lauf ist ausgeschaltet.</strong> Gesichert wird nur noch von Hand.
        </p>
      )}
    </>
  )
}

function BackupOverview({ s }: { s: BackupStatusDto }) {
  const qc = useQueryClient()
  const last = s.lastRun
  const lastOk = s.runs.find((r) => r.status === 'ok' || r.status === 'warning') ?? null
  const run = useMutation({
    mutationFn: api.runBackup,
    onSuccess: () => {
      notifyOk('Sicherung gestartet', { description: 'Der Fortschritt steht unter «Vorgänge».' })
      void qc.invalidateQueries({ queryKey: ['backup'] })
    },
    meta: { errorTitle: 'Sicherung nicht gestartet' },
  })
  const test = useMutation({
    mutationFn: api.testBackup,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['backup'] }),
    meta: { errorTitle: 'Verbindung nicht getestet' },
  })
  const running = s.running || last?.status === 'running'
  return (
    <section aria-labelledby="backup-stand-h">
      <h2 id="backup-stand-h">Stand</h2>
      <dl className="facts backup-facts">
        <dt>Letztes erfolgreiches</dt>
        <dd>{s.lastSuccessAt ? <>{fmtDateTimeShort(s.lastSuccessAt)} <span className="muted">· {relativeTime(s.lastSuccessAt)}</span></> : 'noch keins'}</dd>
        <dt>Grösse</dt>
        <dd>{lastOk ? <>{fmtBytes(lastOk.bytesTotal)} gesichert <span className="muted">· davon neu {fmtBytes(lastOk.bytesNew)}</span></> : '–'}</dd>
        <dt>Dauer</dt>
        <dd>{lastOk ? duration(lastOk.durationMs) : '–'}</dd>
        <dt>Ziel</dt>
        <dd>{s.settings.target ? <code>{describeTarget(s.settings)}</code> : 'noch keins'}</dd>
        <dt>Nächster Lauf</dt>
        <dd>{s.nextRunAt ? <>{fmtDateTimeShort(s.nextRunAt)} <span className="muted">· {inTime(s.nextRunAt)}</span></> : s.settings.configured ? 'aus – nur von Hand' : '–'}</dd>
        <dt>Prüfung des Repositorys</dt>
        <dd>{s.settings.lastCheckAt ? <>zuletzt {fmtDateTimeShort(s.settings.lastCheckAt)} <span className="muted">· einmal pro Woche</span></> : 'noch nicht – läuft einmal pro Woche mit'}</dd>
      </dl>
      <div className="form-actions">
        <button
          type="button"
          className="button-primary"
          onClick={() => run.mutate()}
          disabled={!s.settings.configured || running || run.isPending}
          aria-busy={run.isPending || running || undefined}
        >
          {running ? 'Sicherung läuft' : 'Jetzt sichern'}
        </button>
        <button type="button" onClick={() => test.mutate()} disabled={!s.settings.configured || test.isPending} aria-busy={test.isPending || undefined}>
          Verbindung testen
        </button>
        <span role="status" className="hint">
          {test.data ? (test.data.ok ? `✓ ${test.data.message}` : '') : !s.settings.configured ? 'Erst Ziel und Passwort speichern.' : ''}
        </span>
      </div>
      {test.data && !test.data.ok && (
        <p className="field-error backup-test-error" role="alert"><IconAlert size={14} /><span>{test.data.message}</span></p>
      )}
    </section>
  )
}

function BackupRuns({ runs }: { runs: BackupRunDto[] }) {
  return (
    <section aria-labelledby="backup-laeufe-h">
      <h2 id="backup-laeufe-h">Letzte Läufe</h2>
      {runs.length === 0 ? (
        <EmptyState compact title="Noch kein Lauf">Der erste läuft in der Nacht nach dem Einrichten – oder sofort mit «Jetzt sichern».</EmptyState>
      ) : (
        <div className="table-scroll">
          <table className="table backup-table">
            <thead><tr><th>Gestartet</th><th>Auslöser</th><th>Ergebnis</th><th>Neu / gesamt</th><th>Dauer</th></tr></thead>
            <tbody>
              {runs.slice(0, 8).map((r) => (
                <tr key={r.id}>
                  <td>{fmtDateTimeShort(r.startedAt)}</td>
                  <td>{r.trigger === 'schedule' ? 'Zeitplan' : 'von Hand'}</td>
                  <td>
                    <RunStatus status={r.status} />
                    {r.error && <span className="backup-run-note">{r.error}</span>}
                    {!r.error && r.warnings.length > 0 && <span className="backup-run-note">{r.warnings.join(' · ')}</span>}
                  </td>
                  <td>{r.bytesTotal !== null ? `${fmtBytes(r.bytesNew)} / ${fmtBytes(r.bytesTotal)}` : '–'}</td>
                  <td>{duration(r.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** «Version 0.1.0 · Umgebungen privat, verein» aus den Tags eines Stands */
export function snapshotContent(s: BackupSnapshotDto): string {
  const version = s.tags.find((t) => t.startsWith('airlock-'))?.slice('airlock-'.length)
  const envs = s.tags.filter((t) => t.startsWith('env-')).map((t) => t.slice(4))
  return [version ? `Version ${version}` : null, envs.length ? `Umgebungen ${envs.join(', ')}` : null].filter(Boolean).join(' · ') || 'Datenbank und Dateien'
}

function BackupSnapshots() {
  // Fragt das Ziel live ab (restic snapshots): nur auf dieser Seite, nicht im Takt
  const q = useQuery({ queryKey: ['backup', 'snapshots'], queryFn: api.backupSnapshots, staleTime: 60_000 })
  return (
    <section aria-labelledby="backup-staende-h">
      <h2 id="backup-staende-h">Stände im Repository</h2>
      {q.data ? (
        q.data.snapshots.length === 0 ? (
          <EmptyState compact title="Noch kein Stand">Nach dem ersten erfolgreichen Lauf steht er hier.</EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="table backup-table">
              <thead><tr><th>Zeitpunkt</th><th>Stand</th><th>Grösse</th><th>Inhalt</th></tr></thead>
              <tbody>
                {q.data.snapshots.map((sn) => (
                  <tr key={sn.id}>
                    <td>{fmtDateTimeShort(sn.time)}</td>
                    <td><code>{sn.shortId}</code></td>
                    <td>{fmtBytes(sn.bytesTotal)}</td>
                    <td>{snapshotContent(sn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : q.isError ? (
        <PartialNote onRetry={() => void q.refetch()}>Die Stände konnten nicht gelesen werden: {q.error instanceof ApiError ? q.error.message : 'unbekannter Fehler'}</PartialNote>
      ) : (
        <Loading label="Stände werden gelesen"><SkRows n={3} /></Loading>
      )}
    </section>
  )
}

/* --- Einstellungen ---------------------------------------------------------------- */

interface Form {
  kind: 'local' | 's3'
  path: string
  endpoint: string
  bucket: string
  prefix: string
  region: string
  enabled: boolean
  time: string
  daily: string
  weekly: string
  monthly: string
  projects: Record<string, BackupProjectMode>
}

function formOf(s: BackupSettingsDto): Form {
  const t = s.target
  return {
    kind: t?.kind ?? 'local',
    path: t?.kind === 'local' ? t.path : '/target/airlock',
    endpoint: t?.kind === 's3' ? t.endpoint : '',
    bucket: t?.kind === 's3' ? t.bucket : '',
    prefix: t?.kind === 's3' ? t.prefix : '',
    region: t?.kind === 's3' ? t.region : '',
    enabled: s.enabled,
    time: s.time,
    daily: String(s.retention.daily),
    weekly: String(s.retention.weekly),
    monthly: String(s.retention.monthly),
    projects: { ...s.projects },
  }
}

const MODES: { value: BackupProjectMode; label: string }[] = [
  { value: 'live', label: 'Live sichern' },
  { value: 'stop', label: 'Kurz stoppen' },
  { value: 'skip', label: 'Nicht sichern' },
]

const num = (v: string) => (v.trim() === '' ? NaN : Number(v))

function BackupSettingsForm({ s }: { s: BackupStatusDto }) {
  const qc = useQueryClient()
  const [form, setForm] = useState<Form>(() => formOf(s.settings))
  const [password, setPassword] = useState('')
  const [accessKey, setAccessKey] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [base, setBase] = useState<Form>(() => formOf(s.settings))
  // Neu geladene Einstellungen übernehmen, solange nichts geändert ist
  useEffect(() => {
    const next = formOf(s.settings)
    if (JSON.stringify(form) === JSON.stringify(base) && JSON.stringify(next) !== JSON.stringify(base)) {
      setForm(next)
      setBase(next)
    }
    // Nur bei neuen Einstellungen vom Server, nicht bei jeder Eingabe
  }, [s.settings])

  const dirty = JSON.stringify(form) !== JSON.stringify(base) || password !== '' || accessKey !== '' || secretKey !== ''
  useUnsaved(dirty, 'Backup-Einstellungen')

  const targetChanged = JSON.stringify([form.kind, form.path, form.endpoint, form.bucket, form.prefix, form.region]) !== JSON.stringify([base.kind, base.path, base.endpoint, base.bucket, base.prefix, base.region])

  function payload() {
    const target = form.kind === 'local'
      ? { kind: 'local' as const, path: form.path }
      : {
          kind: 's3' as const, endpoint: form.endpoint, bucket: form.bucket, prefix: form.prefix, region: form.region,
          ...(accessKey ? { accessKeyId: accessKey } : {}), ...(secretKey ? { secretAccessKey: secretKey } : {}),
        }
    return {
      ...(targetChanged || !s.settings.target || accessKey || secretKey ? { target } : {}),
      ...(password ? { password } : {}),
      enabled: form.enabled,
      time: form.time,
      retention: { daily: num(form.daily), weekly: num(form.weekly), monthly: num(form.monthly) },
      projects: form.projects,
    }
  }

  const v = useFormErrors({
    schema: backupSettingsInputSchema,
    values: payload,
    extra: () => {
      const e: Record<string, string> = {}
      if (!s.settings.hasPassword && !password) e.password = 'Ohne Repository-Passwort kein Backup'
      const old = s.settings.target
      if (form.kind === 's3' && !(old?.kind === 's3' && old.hasAccessKey) && !accessKey) e['target.accessKeyId'] = 'Access-Key fehlt'
      if (form.kind === 's3' && !(old?.kind === 's3' && old.hasSecretKey) && !secretKey) e['target.secretAccessKey'] = 'Secret-Key fehlt'
      return e
    },
  })

  const save = useMutation({
    mutationFn: () => api.putBackupSettings(payload()),
    onSuccess: (settings) => {
      const next = formOf(settings)
      setForm(next)
      setBase(next)
      setPassword('')
      setAccessKey('')
      setSecretKey('')
      v.reset()
      notifyOk('Backup-Einstellungen gespeichert', settings.configured && !s.settings.configured ? { description: 'Jetzt «Verbindung testen»: das legt das Repository an.' } : {})
      qc.setQueryData<BackupStatusDto>(['backup'], (old) => (old ? { ...old, settings } : old))
      void qc.invalidateQueries({ queryKey: ['backup'] })
    },
    onError: (err) => void v.setServerErrors(err),
    meta: { errorTitle: 'Backup-Einstellungen nicht gespeichert' },
  })

  const e = v.errors
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch })
  const old = s.settings.target
  return (
    <section aria-labelledby="backup-einstellungen-h">
      <h2 id="backup-einstellungen-h">Einstellungen</h2>
      <form
        className="notify-form backup-form"
        noValidate
        ref={v.formRef}
        onSubmit={(ev) => {
          ev.preventDefault()
          if (v.validateAll()) save.mutate()
        }}
      >
        <fieldset>
          <legend>Ziel</legend>
          <div className="backup-kind" role="radiogroup" aria-label="Art des Ziels">
            <label className="checkbox"><input type="radio" name="backup-kind" checked={form.kind === 'local'} onChange={() => set({ kind: 'local' })} /> Lokal oder NAS</label>
            <label className="checkbox"><input type="radio" name="backup-kind" checked={form.kind === 's3'} onChange={() => set({ kind: 's3' })} /> S3-kompatibel (Backblaze B2, Cloudflare R2, MinIO)</label>
          </div>
          {form.kind === 'local' ? (
            <Field id={v.idFor('target.path')} label="Pfad im Backup-Container" error={e['target.path']} hint={<>Unter <code>/target</code> hängt <code>BACKUP_LOCAL_DIR</code> aus <code>.env</code> – ein Ordner auf dem Server oder ein NAS-Mount.</>}>
              <input {...v.field('target.path', `${v.idFor('target.path')}-hint`)} value={form.path} spellCheck={false} onChange={(x) => set({ path: x.target.value })} />
            </Field>
          ) : (
            <>
              <Field id={v.idFor('target.endpoint')} label="Endpoint" error={e['target.endpoint']}>
                <input {...v.field('target.endpoint')} value={form.endpoint} inputMode="url" spellCheck={false} placeholder="https://s3.eu-central-003.backblazeb2.com" onChange={(x) => set({ endpoint: x.target.value })} />
              </Field>
              <div className="field-row">
                <Field id={v.idFor('target.bucket')} label="Bucket" error={e['target.bucket']}>
                  <input {...v.field('target.bucket')} value={form.bucket} spellCheck={false} onChange={(x) => set({ bucket: x.target.value })} />
                </Field>
                <Field id={v.idFor('target.prefix')} label="Unterordner" optional error={e['target.prefix']}>
                  <input {...v.field('target.prefix')} value={form.prefix} spellCheck={false} placeholder="airlock" onChange={(x) => set({ prefix: x.target.value })} />
                </Field>
              </div>
              <Field id={v.idFor('target.region')} label="Region" optional error={e['target.region']}>
                <input {...v.field('target.region')} value={form.region} spellCheck={false} placeholder="leer = Vorgabe des Anbieters" onChange={(x) => set({ region: x.target.value })} />
              </Field>
              <div className="field-row">
                <Field id={v.idFor('target.accessKeyId')} label="Access-Key" error={e['target.accessKeyId']}>
                  <input {...v.field('target.accessKeyId')} type="password" autoComplete="off" value={accessKey} placeholder={old?.kind === 's3' && old.hasAccessKey ? 'gesetzt – leer lassen für unverändert' : ''} onChange={(x) => setAccessKey(x.target.value)} />
                </Field>
                <Field id={v.idFor('target.secretAccessKey')} label="Secret-Key" error={e['target.secretAccessKey']}>
                  <input {...v.field('target.secretAccessKey')} type="password" autoComplete="off" value={secretKey} placeholder={old?.kind === 's3' && old.hasSecretKey ? 'gesetzt – leer lassen für unverändert' : ''} onChange={(x) => setSecretKey(x.target.value)} />
                </Field>
              </div>
            </>
          )}
        </fieldset>

        <fieldset>
          <legend>Repository-Passwort</legend>
          <Field
            id={v.idFor('password')}
            label="Passwort"
            error={e.password}
            hint="Ohne dieses Passwort ist jedes Backup wertlos. Bewahre es getrennt auf, z. B. im Passwort-Manager: Airlock speichert es verschlüsselt in der Datenbank – und die steckt selbst im Backup."
          >
            <input {...v.field('password', `${v.idFor('password')}-hint`)} type="password" autoComplete="new-password" value={password} placeholder={s.settings.hasPassword ? 'gesetzt – leer lassen für unverändert' : 'mindestens 12 Zeichen'} onChange={(x) => setPassword(x.target.value)} />
          </Field>
          {s.settings.hasPassword && password !== '' && (
            <p className="hint">Ein neues Passwort ändert nur die Einstellung, nicht ein bestehendes Repository. Für ein bestehendes Repository muss es das bisherige bleiben.</p>
          )}
        </fieldset>

        <fieldset>
          <legend>Zeitplan und Aufbewahrung</legend>
          <label className="checkbox"><input type="checkbox" checked={form.enabled} onChange={(x) => set({ enabled: x.target.checked })} /> Jede Nacht sichern</label>
          <Field id={v.idFor('time')} label={`Uhrzeit (${s.settings.timeZone})`} error={e.time}>
            <input {...v.field('time')} value={form.time} inputMode="numeric" placeholder="03:30" className="backup-time" onChange={(x) => set({ time: x.target.value })} />
          </Field>
          <div className="backup-retention">
            <Field id={v.idFor('retention.daily')} label="Tägliche Stände" error={e['retention.daily'] ?? e.retention}>
              <input {...v.field('retention.daily')} inputMode="numeric" value={form.daily} onChange={(x) => set({ daily: x.target.value.replace(/[^0-9]/g, '') })} />
            </Field>
            <Field id={v.idFor('retention.weekly')} label="Wöchentliche" error={e['retention.weekly']}>
              <input {...v.field('retention.weekly')} inputMode="numeric" value={form.weekly} onChange={(x) => set({ weekly: x.target.value.replace(/[^0-9]/g, '') })} />
            </Field>
            <Field id={v.idFor('retention.monthly')} label="Monatliche" error={e['retention.monthly']}>
              <input {...v.field('retention.monthly')} inputMode="numeric" value={form.monthly} onChange={(x) => set({ monthly: x.target.value.replace(/[^0-9]/g, '') })} />
            </Field>
          </div>
          <p className="hint">Vorgabe {BACKUP_DEFAULT_RETENTION.daily} / {BACKUP_DEFAULT_RETENTION.weekly} / {BACKUP_DEFAULT_RETENTION.monthly}. Ältere Stände entfernt Airlock nach jedem Lauf.</p>
        </fieldset>

        <fieldset>
          <legend>Volumes der Projekte</legend>
          <p className="hint">
            Live geht ohne Unterbruch, kann aber bei einer Datenbank im Projekt einen inkonsistenten Stand ergeben.
            «Kurz stoppen» hält die Container während der Kopie an.
          </p>
          {s.projects.length === 0 ? (
            <p className="hint">Kein Compose-Projekt – nur Compose-Projekte haben eigene Volumes.</p>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead><tr><th>Projekt</th><th>Umgebung</th><th>Volumes</th></tr></thead>
                <tbody>
                  {s.projects.map((p) => (
                    <tr key={p.slug}>
                      <td>{p.name} <span className="muted">· {p.slug}</span></td>
                      <td>{p.environment}</td>
                      <td>
                        <select
                          aria-label={`Volumes von ${p.name}`}
                          value={form.projects[p.slug] ?? 'live'}
                          onChange={(x) => set({ projects: { ...form.projects, [p.slug]: x.target.value as BackupProjectMode } })}
                        >
                          {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </fieldset>

        <div className="form-actions">
          <button className="button-primary" type="submit" disabled={save.isPending} aria-busy={save.isPending || undefined}>Speichern</button>
        </div>
      </form>
    </section>
  )
}

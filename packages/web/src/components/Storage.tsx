import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  DISK_BLOCK_PERCENT, DISK_HINT_PERCENT, DISK_NOTIFY_PERCENT, STORAGE_KEEP_VERSIONS_MAX,
  type CleanupItemKind, type DiskDto, type OrphanVolumeDto, type StorageDto,
} from '@airlock/shared'
import { api, ApiError } from '../api.js'
import { ErrorState, EmptyState, Loading, SkCard } from './States.js'
import { ConfirmDialog } from './Confirm.js'
import { Field } from './Field.js'
import { Switch } from './Switch.js'
import { fmtBytes } from './Backup.js'
import { notifyOk } from '../lib/feedback.js'
import { fmtDateTimeShort } from '../lib/dates.js'
import { inTime, relativeTime } from '../lib/format.js'
import { useUnsaved } from '../lib/unsaved.js'

/**
 * Nacht 3, Etappe 3: Server › Speicher. Belegung der Platte und je Bereich
 * (wie `docker system df` plus die Ablagen von Airlock), was das Aufräumen
 * freigeben würde, «Jetzt aufräumen» (sonst wöchentlich), die Grenze für
 * Rollbacks und verwaiste Volumes (nur einzeln, mit Namen und Bestätigung).
 * Nur bestehende Bausteine; Stufen immer mit Text, nie nur über Farbe.
 */

const KIND: Record<CleanupItemKind, { one: string; many: string }> = {
  deployment: { one: 'Fassung über der Grenze', many: 'Fassungen über der Grenze' },
  image: { one: 'Image', many: 'Images' },
  container: { one: 'Wegwerf-Container', many: 'Wegwerf-Container' },
  'site-version': { one: 'Ordner einer statischen Seite', many: 'Ordner statischer Seiten' },
  upload: { one: 'Upload', many: 'Uploads' },
  artifact: { one: 'Deploy-Artefakt', many: 'Deploy-Artefakte' },
  log: { one: 'Deploy-Log', many: 'Deploy-Logs' },
}

const LEVEL: Record<DiskDto['level'], { label: string; cls: string }> = {
  ok: { label: 'Genug Platz', cls: 'status-running' },
  hinweis: { label: `Über ${DISK_HINT_PERCENT} %`, cls: 'status-warn' },
  warnung: { label: `Über ${DISK_NOTIFY_PERCENT} %`, cls: 'status-failed' },
  gesperrt: { label: 'Deploys gesperrt', cls: 'status-failed' },
}

export function useStorage() {
  return useQuery({ queryKey: ['storage'], queryFn: () => api.storage(), select: (r) => r.storage })
}

export function StorageSection() {
  const q = useStorage()
  if (!q.data) {
    return q.isError
      ? <ErrorState what="Die Belegung des Servers" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
      : <Loading label="Belegung wird gemessen"><SkCard lines={3} /><SkCard lines={6} className="sk-gap-lg" /></Loading>
  }
  const s = q.data
  return (
    <div className="backup storage">
      <StorageWarnings s={s} />
      <DiskSection s={s} />
      <UsageSection s={s} />
      <CleanupSection s={s} />
      <OrphanVolumes s={s} />
      <StorageSettingsForm s={s} />
    </div>
  )
}

/** Hinweis ab 80 %, Warnung ab 90 %, ab 95 % keine Deploys – mit Text, nicht nur Farbe */
export function DiskBanner({ disk, withLink }: { disk: Pick<DiskDto, 'percent' | 'level'> | null; withLink?: boolean }) {
  if (!disk || disk.level === 'ok') return null
  const where = withLink ? <> Aufräumen unter <Link to="/server/speicher">Server › Speicher</Link>.</> : null
  if (disk.level === 'gesperrt') {
    return (
      <p role="alert" className="banner banner-warn">
        <strong>Platte zu {disk.percent} % belegt – Deploys sind gesperrt.</strong> Ab {DISK_BLOCK_PERCENT} % nimmt Airlock keine Deploys an; ein Rollback geht weiterhin.{where}
      </p>
    )
  }
  return (
    <p className="banner banner-warn">
      <strong>Platte zu {disk.percent} % belegt.</strong>{' '}
      {disk.level === 'warnung' ? 'Eine Benachrichtigung ist unterwegs (einmal pro Tag). ' : ''}
      Ab {DISK_BLOCK_PERCENT} % nimmt Airlock keine Deploys mehr an.{where}
    </p>
  )
}

function StorageWarnings({ s }: { s: StorageDto }) {
  return (
    <>
      <DiskBanner disk={s.disk} />
      {s.problems.map((p) => <p key={p} className="banner banner-warn"><strong>Nicht gemessen.</strong> {p}</p>)}
    </>
  )
}

function DiskSection({ s }: { s: StorageDto }) {
  const d = s.disk
  if (!d) return null
  const lvl = LEVEL[d.level]
  return (
    <section aria-labelledby="speicher-platte-h">
      <h2 id="speicher-platte-h">Platte</h2>
      <div className="storage-disk">
        <div className="meter-head">
          <span><span className={`status ${lvl.cls}`}><span className="status-dot" aria-hidden="true" />{lvl.label}</span></span>
          <span className="num">{d.percent} % belegt · {fmtBytes(d.usedBytes)} von {fmtBytes(d.totalBytes)}</span>
        </div>
        <div className="meter-track" role="progressbar" aria-label="Platte belegt" aria-valuemin={0} aria-valuemax={100} aria-valuenow={d.percent} aria-valuetext={`${d.percent} % belegt`}>
          <div className={`meter-fill${d.level === 'ok' ? '' : d.level === 'hinweis' ? ' tone-warn' : ' tone-bad'}`} style={{ width: `${d.percent}%` }} />
        </div>
        <p className="meter-note">Hinweis ab {DISK_HINT_PERCENT} %, Benachrichtigung ab {DISK_NOTIFY_PERCENT} %, keine Deploys ab {DISK_BLOCK_PERCENT} %.</p>
      </div>
    </section>
  )
}

function UsageSection({ s }: { s: StorageDto }) {
  const qc = useQueryClient()
  const remeasure = useMutation({
    mutationFn: () => api.storage(true),
    onSuccess: (r) => qc.setQueryData(['storage'], r),
    meta: { errorTitle: 'Nicht neu gemessen' },
  })
  if (!s.categories.length) return null
  return (
    <section aria-labelledby="speicher-belegung-h">
      <h2 id="speicher-belegung-h">Belegung</h2>
      <div className="table-scroll">
        <table className="table storage-table">
          <thead><tr><th>Bereich</th><th className="num-col">Grösse</th><th className="num-col">Davon freigebbar</th></tr></thead>
          <tbody>
            {s.categories.map((c) => (
              <tr key={c.key}>
                <td>
                  <span className="storage-cat">{c.label}{c.count !== null ? <span className="muted"> · {c.count}</span> : null}</span>
                  {c.note && <span className="storage-note">{c.note}</span>}
                </td>
                <td className="num num-col">{fmtBytes(c.bytes)}</td>
                <td className="num num-col">{c.reclaimableBytes > 0 ? fmtBytes(c.reclaimableBytes) : <span className="muted">nichts</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="form-actions">
        <button type="button" onClick={() => remeasure.mutate()} disabled={remeasure.isPending} aria-busy={remeasure.isPending || undefined}>Neu messen</button>
        <span className="hint">Gemessen {fmtDateTimeShort(s.measuredAt)} · Volumes auszumessen dauert, darum zwischengespeichert (10 Minuten).</span>
      </div>
    </section>
  )
}

function planSummary(s: StorageDto): string[] {
  const parts = s.plan.byKind.map((k) => `${k.count} ${k.count === 1 ? KIND[k.kind].one : KIND[k.kind].many}`)
  if (s.plan.buildCache && s.plan.buildCache.count > 0) parts.push(`Build-Cache (${s.plan.buildCache.count} Einträge)`)
  return parts
}

function CleanupSection({ s }: { s: StorageDto }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const run = useMutation({
    mutationFn: api.runStorageCleanup,
    onSuccess: (r) => {
      qc.setQueryData(['storage'], { storage: r.storage })
      setOpen(false)
      const res = r.result
      notifyOk(res.run.ok ? 'Aufgeräumt' : 'Aufgeräumt, nicht alles', {
        description: `Etwa ${fmtBytes(res.run.freedBytes)} frei, ${res.run.removed} entfernt${res.run.failed ? `, ${res.run.failed} nicht (steht im Audit-Log)` : ''}.`,
      })
    },
  })
  const parts = planSummary(s)
  const nothing = parts.length === 0
  const last = s.lastRun
  return (
    <section aria-labelledby="speicher-aufraeumen-h">
      <h2 id="speicher-aufraeumen-h">Aufräumen</h2>
      <dl className="facts backup-facts">
        <dt>Würde freigeben</dt>
        <dd>{nothing ? 'nichts – alles ist innerhalb der Grenzen' : <>etwa <strong>{fmtBytes(s.plan.bytes)}</strong> <span className="muted">· {parts.join(', ')}</span></>}</dd>
        <dt>Zuletzt</dt>
        <dd>
          {last
            ? <>{fmtDateTimeShort(last.at)} <span className="muted">· {relativeTime(last.at)} · {last.trigger === 'schedule' ? 'wöchentlich' : last.trigger === 'cli' ? 'Kommandozeile' : 'von Hand'} · {fmtBytes(last.freedBytes)} frei{last.failed ? ` · ${last.failed} nicht entfernt` : ''}</span></>
            : 'noch nie'}
        </dd>
        <dt>Nächster Lauf</dt>
        <dd>{s.nextRunAt ? <>{fmtDateTimeShort(s.nextRunAt)} <span className="muted">· {inTime(s.nextRunAt)} · wöchentlich</span></> : '–'}</dd>
        <dt>Bleibt immer</dt>
        <dd>Das aktive Image jedes Projekts, Images in Benutzung, alles ohne Airlock-Label (Portainer usw.) und alle Volumes.</dd>
      </dl>
      {!nothing && (
        <details className="storage-items">
          <summary>Alle Posten ansehen ({s.plan.total})</summary>
          <div className="table-scroll">
            <table className="table storage-table">
              <thead><tr><th>Was</th><th>Name</th><th>Projekt</th><th>Warum</th><th className="num-col">Grösse</th></tr></thead>
              <tbody>
                {s.plan.items.map((i, n) => (
                  <tr key={`${i.kind}-${i.name}-${n}`}>
                    <td>{KIND[i.kind].one}</td>
                    <td><code>{i.name}</code></td>
                    <td>{i.project ?? <span className="muted">–</span>}</td>
                    <td>{i.reason}</td>
                    <td className="num num-col">{i.bytes !== null ? fmtBytes(i.bytes) : <span className="muted">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {s.plan.total > s.plan.items.length && <p className="hint">… und {s.plan.total - s.plan.items.length} weitere.</p>}
        </details>
      )}
      <div className="form-actions">
        <button type="button" className="button-primary" onClick={() => setOpen(true)} disabled={nothing || s.running || run.isPending} aria-busy={s.running || run.isPending || undefined}>
          {s.running ? 'Aufräumen läuft' : 'Jetzt aufräumen'}
        </button>
        <span className="hint" role="status">{nothing ? 'Nichts zu tun.' : ''}</span>
      </div>
      <ConfirmDialog
        open={open}
        title={`Etwa ${fmtBytes(s.plan.bytes)} freigeben?`}
        confirmLabel="Aufräumen"
        busy={run.isPending}
        error={run.error ? (run.error instanceof ApiError ? run.error.message : 'Nicht aufgeräumt') : undefined}
        onConfirm={() => run.mutate()}
        onCancel={() => { setOpen(false); run.reset() }}
      >
        <p>Entfernt: {parts.join(', ')}.</p>
        <p>Für ein Rollback bleiben pro Projekt die aktive und die letzten {s.settings.keepVersions} Fassungen. Volumes bleiben immer. Das Ergebnis steht danach im Audit-Log.</p>
      </ConfirmDialog>
    </section>
  )
}

function OrphanVolumes({ s }: { s: StorageDto }) {
  const qc = useQueryClient()
  const [target, setTarget] = useState<OrphanVolumeDto | null>(null)
  const del = useMutation({
    mutationFn: (v: { name: string; confirm: string }) => api.deleteOrphanVolume(v.name, v.confirm),
    onSuccess: (r, v) => {
      qc.setQueryData(['storage'], r)
      setTarget(null)
      notifyOk('Volume gelöscht', { description: v.name })
    },
  })
  return (
    <section aria-labelledby="speicher-volumes-h">
      <h2 id="speicher-volumes-h">Verwaiste Volumes</h2>
      <p className="hint">Volumes mit Airlock-Bezug, deren Projekt es nicht mehr gibt. Sie werden nie automatisch gelöscht – darin können Daten liegen, etwa die einer Datenbank.</p>
      {s.orphanVolumes.length === 0 ? (
        <EmptyState compact title="Keine verwaisten Volumes." />
      ) : (
        <div className="table-scroll">
          <table className="table storage-table">
            <thead><tr><th>Volume</th><th>Projekt</th><th className="num-col">Grösse</th><th>Angelegt</th><th><span className="sr-only">Aktion</span></th></tr></thead>
            <tbody>
              {s.orphanVolumes.map((v) => (
                <tr key={v.name}>
                  <td><code>{v.name}</code></td>
                  <td>{v.project ? <>{v.project} <span className="muted">(gelöscht)</span></> : <span className="muted">–</span>}</td>
                  <td className="num num-col">{v.bytes !== null ? fmtBytes(v.bytes) : <span className="muted">–</span>}</td>
                  <td>{v.createdAt ? fmtDateTimeShort(v.createdAt) : <span className="muted">–</span>}</td>
                  <td className="row-actions">
                    {v.inUse
                      ? <span className="muted">eingehängt</span>
                      : <button type="button" className="button-danger button-small" onClick={() => { del.reset(); setTarget(v) }} aria-label={`Löschen: ${v.name}`}>Löschen</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={target !== null}
        title={target ? `Volume ${target.name} löschen?` : ''}
        confirmLabel="Volume löschen"
        busy={del.isPending}
        error={del.error ? (del.error instanceof ApiError ? del.error.message : 'Nicht gelöscht') : undefined}
        typeToConfirm={target ? { value: target.name, label: 'Name des Volumes zum Bestätigen' } : undefined}
        onConfirm={() => target && del.mutate({ name: target.name, confirm: target.name })}
        onCancel={() => setTarget(null)}
      >
        <p>Alle Daten darin sind danach weg; ein Backup holt sie nur zurück, wenn es das Volume gesichert hat. Danach fragt Airlock noch einmal nach deiner Bestätigung.</p>
      </ConfirmDialog>
    </section>
  )
}

function StorageSettingsForm({ s }: { s: StorageDto }) {
  const qc = useQueryClient()
  const [keep, setKeep] = useState(String(s.settings.keepVersions))
  const [cache, setCache] = useState(s.settings.pruneBuildCache)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setKeep(String(s.settings.keepVersions)); setCache(s.settings.pruneBuildCache) }, [s.settings.keepVersions, s.settings.pruneBuildCache])
  const dirty = keep !== String(s.settings.keepVersions) || cache !== s.settings.pruneBuildCache
  useUnsaved(dirty, 'Aufräumen: Einstellungen')
  const save = useMutation({
    mutationFn: api.putStorageSettings,
    onSuccess: (r) => {
      qc.setQueryData(['storage'], { storage: r.storage })
      notifyOk('Gespeichert')
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Nicht gespeichert'),
  })
  return (
    <section aria-labelledby="speicher-einstellungen-h">
      <h2 id="speicher-einstellungen-h">Einstellungen</h2>
      <form
        noValidate
        className="storage-form"
        onSubmit={(e) => {
          e.preventDefault()
          const n = Number(keep)
          if (!Number.isInteger(n) || n < 1 || n > STORAGE_KEEP_VERSIONS_MAX) {
            setError(`Eine ganze Zahl von 1 bis ${STORAGE_KEEP_VERSIONS_MAX}.`)
            requestAnimationFrame(() => document.getElementById('f-keep-versions')?.focus())
            return
          }
          setError(null)
          save.mutate({ keepVersions: n, pruneBuildCache: cache })
        }}
      >
        <Field id="f-keep-versions" label="Frühere Fassungen pro Projekt" hint="Für ein Rollback; die aktive Fassung bleibt zusätzlich immer." error={error ?? undefined}>
          <input
            id="f-keep-versions"
            inputMode="numeric"
            value={keep}
            onChange={(e) => setKeep(e.target.value.replace(/[^0-9]/g, ''))}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'f-keep-versions-error' : 'f-keep-versions-hint'}
          />
        </Field>
        <div className="storage-switch">
          <Switch checked={cache} onChange={setCache} labelledBy="f-build-cache-l" describedBy="f-build-cache-h" />
          <div>
            <span id="f-build-cache-l" className="storage-switch-label">Build-Cache mitaufräumen</span>
            <span id="f-build-cache-h" className="hint">Einträge, die seit 7 Tagen niemand benutzt hat. Build-Cache hat kein Label; er enthält nur Zwischenstände von Builds, keine Daten.</span>
          </div>
        </div>
        <div className="form-actions">
          <button type="submit" disabled={!dirty || save.isPending} aria-busy={save.isPending || undefined}>Speichern</button>
        </div>
      </form>
    </section>
  )
}

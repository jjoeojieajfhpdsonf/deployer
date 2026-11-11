import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BackupProjectDto, BackupRestoreDto, BackupRestorePartDto, BackupSnapshotDto, BackupStatusDto } from '@airlock/shared'
import { api, ApiError } from '../api.js'
import { Modal } from './Modal.js'
import { Field } from './Field.js'
import { Loading, PartialNote, SkRows } from './States.js'
import { IconAlert } from './Icons.js'
import { notifyOk } from '../lib/feedback.js'
import { fmtDateTimeShort } from '../lib/dates.js'
import { relativeTime } from '../lib/format.js'
import { fmtBytes } from './Backup.js'

/**
 * Meilenstein Backup, Etappe 5: ein Projekt aus einem Stand zurückholen.
 * Zerstörerisch – deshalb modal mit Vorschau (was der Stand vom Projekt
 * enthält, welche Container angehalten werden) und Bestätigung durch
 * Eintippen des Slugs. Die API verlangt dieselbe Bestätigung.
 */

const PART: Record<BackupRestorePartDto['kind'], string> = { volume: 'Volume', site: 'Statische Seite', repo: 'Repository' }

export function RestoreButton({ snapshot, onPick }: { snapshot: BackupSnapshotDto; onPick: (s: BackupSnapshotDto) => void }) {
  return (
    <button type="button" className="button-small" onClick={() => onPick(snapshot)} aria-label={`Projekt aus Stand ${snapshot.shortId} wiederherstellen`}>
      Wiederherstellen
    </button>
  )
}

/** Der Dialog steht ausserhalb der Tabelle (sonst erbt er deren Ausrichtung) */
export function RestoreModal({ snapshot, projects, onClose }: { snapshot: BackupSnapshotDto | null; projects: BackupProjectDto[]; onClose: () => void }) {
  return (
    <Modal open={snapshot !== null} onClose={onClose} labelledBy="restore-h" describedBy="restore-d" wide>
      {snapshot && <RestoreDialog snapshot={snapshot} projects={projects} onClose={onClose} />}
    </Modal>
  )
}

function RestoreDialog({ snapshot, projects, onClose }: { snapshot: BackupSnapshotDto; projects: BackupProjectDto[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [project, setProject] = useState('')
  const [confirm, setConfirm] = useState('')
  const preview = useQuery({
    queryKey: ['backup', 'restore-preview', snapshot.id, project],
    queryFn: () => api.backupRestorePreview(snapshot.id, project),
    enabled: project !== '',
    staleTime: 60_000,
    retry: false,
  })
  const start = useMutation({
    mutationFn: () => api.startBackupRestore({ snapshot: snapshot.id, project, confirm }),
    onSuccess: ({ restore }) => {
      qc.setQueryData<BackupStatusDto>(['backup'], (old) => (old ? { ...old, restore } : old))
      void qc.invalidateQueries({ queryKey: ['backup'] })
      notifyOk(`Wiederherstellung gestartet · ${restore.project.name}`, { description: 'Der Fortschritt steht unter «Vorgänge».' })
      onClose()
    },
    meta: { errorTitle: 'Nicht wiederhergestellt' },
  })
  const p = preview.data
  const empty = p !== undefined && p.parts.length === 0
  const matches = project !== '' && confirm.trim() === project
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        if (matches && p && !empty) start.mutate()
      }}
    >
      <h2 id="restore-h">Projekt aus Stand {snapshot.shortId} wiederherstellen</h2>
      <p id="restore-d" className="dialog-lede">
        Stand vom {fmtDateTimeShort(snapshot.time)} ({relativeTime(snapshot.time)}). Ersetzt, was jetzt in den Volumes, der Seite bzw. dem Repository
        des Projekts liegt – nicht rückgängig zu machen.
      </p>
      <Field id="f-restore-project" label="Projekt">
        <select id="f-restore-project" value={project} onChange={(e) => { setProject(e.target.value); setConfirm('') }}>
          <option value="">Projekt wählen …</option>
          {projects.map((x) => <option key={x.slug} value={x.slug}>{x.name} · {x.slug} ({x.environment})</option>)}
        </select>
      </Field>

      {project !== '' && (
        preview.isFetching && !p ? (
          <Loading label="Inhalt des Stands wird gelesen"><SkRows n={2} card={false} /></Loading>
        ) : preview.isError ? (
          <PartialNote onRetry={() => void preview.refetch()}>Inhalt nicht lesbar: {preview.error instanceof ApiError ? preview.error.message : 'unbekannter Fehler'}</PartialNote>
        ) : p ? (
          empty ? (
            <p className="hint" role="status">Dieser Stand enthält nichts von {p.project.name} – keine Volumes, keine Seite, kein Repository.</p>
          ) : (
            <>
              <table className="table restore-parts">
                <caption className="sr-only">Was zurückkommt</caption>
                <thead><tr><th>Teil</th><th>Name</th><th>Dateien</th><th>Grösse</th></tr></thead>
                <tbody>
                  {p.parts.map((x) => (
                    <tr key={`${x.kind}-${x.name}`}>
                      <td>{PART[x.kind]}</td>
                      <td><code>{x.name}</code></td>
                      <td>{x.files.toLocaleString('de-CH')}{p.truncated ? '+' : ''}</td>
                      <td>{fmtBytes(x.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="field-error restore-warning">
                <IconAlert size={14} />
                <span>
                  {p.runningContainers > 0
                    ? `${p.runningContainers === 1 ? 'Ein laufender Container' : `${p.runningContainers} laufende Container`} von ${p.project.name} ${p.runningContainers === 1 ? 'wird' : 'werden'} dafür angehalten und danach wieder gestartet. `
                    : ''}
                  Was jetzt dort liegt, wird ersetzt.
                </span>
              </p>
              <Field id="f-restore-confirm" label={<>Zur Bestätigung <code>{p.project.slug}</code> eintippen</>}>
                <input id="f-restore-confirm" value={confirm} autoComplete="off" spellCheck={false} onChange={(e) => setConfirm(e.target.value)} />
              </Field>
            </>
          )
        ) : null
      )}

      <div className="dialog-actions">
        <button type="button" onClick={onClose}>Abbrechen</button>
        <button type="submit" className="button-danger-solid" disabled={!matches || !p || empty || start.isPending} aria-busy={start.isPending || undefined}>
          Wiederherstellen
        </button>
      </div>
    </form>
  )
}

/** Laufender oder letzter Restore (seit dem Start von Airlock) */
export function RestoreState({ r }: { r: BackupRestoreDto | null }) {
  if (!r) return null
  if (r.status === 'running') {
    return <p className="banner banner-info" role="status"><strong>Wiederherstellung läuft:</strong> {r.project.name} aus Stand <code>{r.snapshot.shortId}</code>, seit {fmtDateTimeShort(r.startedAt)}.</p>
  }
  if (r.status === 'failed') {
    return <p className="banner banner-warn" role="status"><strong>Wiederherstellung gescheitert:</strong> {r.project.name} aus Stand <code>{r.snapshot.shortId}</code> – {r.error}</p>
  }
  return (
    <p className="banner banner-info" role="status">
      <strong>✓ Wiederhergestellt:</strong> {r.project.name} aus Stand <code>{r.snapshot.shortId}</code> ({r.restored.join(', ')}), {relativeTime(r.finishedAt)}.
      {r.warnings.length ? <> Hinweise: {r.warnings.join(' · ')}</> : null}
    </p>
  )
}

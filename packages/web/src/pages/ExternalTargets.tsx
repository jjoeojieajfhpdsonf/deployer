import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type ExternalTargetDto } from '../api.js'
import { copyText } from '../lib/clipboard.js'
import { ScanReport } from '../components/Security.js'
import { relativeTime } from '../lib/format.js'
import { poll } from '../lib/live.js'
import { PageHead } from '../components/PageHead.js'
import { addExternalTargetSchema } from '@airlock/shared'
import { useFormErrors } from '../lib/form.js'
import { FieldError } from '../components/Field.js'
import { EmptyState, ErrorState, Loading, SkCard, SkRows } from '../components/States.js'

/**
 * Fremde Websites scannen, aber nur nach Nachweis per DNS-TXT-Eintrag
 * (SPEC M6). Ohne Nachweis lehnt der Server jeden Scan ab.
 */
export function ExternalTargets() {
  const qc = useQueryClient()
  const [hostname, setHostname] = useState('')
  const list = useQuery({ queryKey: ['external-targets'], queryFn: api.externalTargets })
  const form = useFormErrors({ schema: addExternalTargetSchema, values: () => ({ hostname }) })
  const add = useMutation({
    mutationFn: () => api.addExternalTarget(hostname.trim()),
    onSuccess: () => {
      setHostname('')
      form.reset()
      void qc.invalidateQueries({ queryKey: ['external-targets'] })
    },
    // Was nur der Server weiss (Basisdomain, schon eingetragen), steht ebenfalls am Feld.
    onError: (err) => form.setErrors({ hostname: err instanceof ApiError ? err.message : 'Nicht hinzugefügt' }),
  })

  return (
    <section className="page page-medium">
      <PageHead crumbs={[{ label: 'externe ziele' }]} title="Externe Ziele">
        <p className="lede">
          Eigene Websites, die nicht über Airlock laufen, lassen sich mit denselben
          passiven Scannern prüfen. Gescannt wird erst, wenn ein TXT-Eintrag zeigt, dass
          die Domain dir gehört.
        </p>
      </PageHead>

      <form
        className="inline-form"
        noValidate
        ref={form.formRef}
        onSubmit={(e) => {
          e.preventDefault()
          if (form.validateAll()) add.mutate()
        }}
      >
        <div className="inline-form-field">
          <label htmlFor={form.idFor('hostname')} className="visually-hidden">Hostname</label>
          <input {...form.field('hostname')} placeholder="www.meine-domain.ch" value={hostname} onChange={(e) => setHostname(e.target.value)} autoComplete="off" spellCheck={false} inputMode="url" />
          {form.errors.hostname && <FieldError id={form.idFor('hostname')} message={form.errors.hostname} />}
        </div>
        <button className="button-primary" type="submit" disabled={add.isPending}>Ziel hinzufügen</button>
      </form>

      {!list.data && list.isError ? (
        <ErrorState what="Die Liste der externen Ziele" error={list.error} retrying={list.isFetching} onRetry={() => void list.refetch()} />
      ) : !list.data ? (
        <Loading label="Externe Ziele werden geladen"><SkRows n={3} /></Loading>
      ) : list.data.targets.length === 0 ? (
        <EmptyState title="Noch keine externen Ziele" action={<button type="button" onClick={() => document.getElementById(form.idFor('hostname'))?.focus()}>Ziel hinzufügen</button>}>
          Trage oben eine eigene Domain ein. Gescannt wird erst, wenn ein TXT-Eintrag beweist, dass sie dir gehört.
        </EmptyState>
      ) : (
        <ul className="target-list">
          {list.data.targets.map((t) => <Target key={t.id} t={t} />)}
        </ul>
      )}
    </section>
  )
}

function Target({ t }: { t: ExternalTargetDto }) {
  const qc = useQueryClient()
  const [showReport, setShowReport] = useState(false)
  const [verifyNote, setVerifyNote] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const refresh = () => void qc.invalidateQueries({ queryKey: ['external-targets'] })

  const verify = useMutation({
    mutationFn: () => api.verifyExternalTarget(t.id),
    onSuccess: (r) => {
      setVerifyNote(
        r.target.verified
          ? `✓ Bestätigt von ${r.target.confirmedBy.join(', ')}`
          : `✕ Nicht bestätigt (${r.target.confirmedBy.length} von 3 Resolvern). ${r.target.errors.join(' · ')}`,
      )
      refresh()
    },
  })
  const interval = useMutation({ mutationFn: (v: string) => api.setExternalInterval(t.id, v), onSuccess: refresh })
  const scan = useMutation({
    mutationFn: () => api.scanExternal(t.id),
    onSuccess: () => {
      setShowReport(true)
      void qc.invalidateQueries({ queryKey: ['external-scan', t.id] })
    },
  })
  const del = useMutation({ mutationFn: () => api.deleteExternalTarget(t.id), onSuccess: refresh })
  const report = useQuery({
    queryKey: ['external-scan', t.id],
    queryFn: () => api.latestExternalScan(t.id),
    enabled: showReport,
    // Fortschritt kommt über den Ereignisstrom; ohne ihn alle 60 s (UI-Qualität 3)
    refetchInterval: (q) => {
      const st = q.state.data?.report?.scan.status
      return st === 'queued' || st === 'running' ? poll() : false
    },
  })

  return (
    <li className="target">
      <div className="target-head">
        <strong>{t.hostname}</strong>
        <span className={t.verified ? 'status status-running' : 'status status-warn'}>
          <span className="status-dot" aria-hidden="true" />{t.verified ? 'verifiziert' : 'nicht verifiziert'}
        </span>
        {t.lastCheckAt && <span className="muted">geprüft {relativeTime(t.lastCheckAt)}</span>}
      </div>

      {!t.verified && (
        <div className="txt-instructions">
          <p>Lege bei deinem DNS-Anbieter diesen TXT-Eintrag an und klicke danach auf «Prüfen»:</p>
          <dl className="facts">
            <dt>Name</dt><dd><code>{t.txt.name}</code></dd>
            <dt>Wert</dt><dd><code>{t.txt.value}</code></dd>
          </dl>
          <button
            onClick={async () => {
              setCopied(await copyText(t.txt.value))
              setTimeout(() => setCopied(false), 2000)
            }}
          >
            {copied ? 'Kopiert' : 'Wert kopieren'}
          </button>
        </div>
      )}

      <div className="form-actions">
        <button onClick={() => verify.mutate()} disabled={verify.isPending} aria-busy={verify.isPending || undefined}>Prüfen</button>
        <label>
          Regelmässig scannen{' '}
          <select value={t.scanInterval} onChange={(e) => interval.mutate(e.target.value)} disabled={!t.verified}>
            <option value="off">aus</option>
            <option value="daily">täglich</option>
            <option value="weekly">wöchentlich</option>
            <option value="monthly">monatlich</option>
          </select>
        </label>
        <button onClick={() => scan.mutate()} disabled={!t.verified || scan.isPending}>Jetzt scannen</button>
        <button onClick={() => setShowReport((v) => !v)}>{showReport ? 'Bericht ausblenden' : 'Letzter Bericht'}</button>
        {!confirmDelete ? (
          <button onClick={() => setConfirmDelete(true)}>Entfernen</button>
        ) : (
          <>
            <button onClick={() => setConfirmDelete(false)}>Abbrechen</button>
            <button className="button-danger-solid" onClick={() => del.mutate()}>Ja, entfernen</button>
          </>
        )}
      </div>
      {verifyNote && <p className="hint" role="status">{verifyNote}</p>}

      {showReport && (
        !report.data && report.isError ? <ErrorState compact what="Der letzte Scan" error={report.error} retrying={report.isFetching} onRetry={() => void report.refetch()} />
        : !report.data ? <Loading label="Scan wird geladen"><SkCard lines={4} /></Loading>
        : report.data.report ? <ScanReport report={report.data.report} onAccepted={() => void report.refetch()} />
        : <EmptyState compact title="Noch kein Scan." action={t.verified ? <button type="button" className="button-small" onClick={() => scan.mutate()}>Jetzt scannen</button> : undefined}>{t.verified ? null : 'Erst die Domain bestätigen.'}</EmptyState>
      )}
    </li>
  )
}

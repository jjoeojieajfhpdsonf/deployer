import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type ExternalTargetDto } from '../api.js'
import { copyText } from '../lib/clipboard.js'
import { ScanReport } from '../components/Security.js'
import { relativeTime } from '../components/Status.js'

/**
 * Fremde Websites scannen, aber nur nach Nachweis per DNS-TXT-Eintrag
 * (SPEC M6). Ohne Nachweis lehnt der Server jeden Scan ab.
 */
export function ExternalTargets() {
  const qc = useQueryClient()
  const [hostname, setHostname] = useState('')
  const list = useQuery({ queryKey: ['external-targets'], queryFn: api.externalTargets })
  const add = useMutation({
    mutationFn: () => api.addExternalTarget(hostname.trim()),
    onSuccess: () => {
      setHostname('')
      void qc.invalidateQueries({ queryKey: ['external-targets'] })
    },
  })

  return (
    <section className="page page-external">
      <h1>Externe Ziele</h1>
      <p className="hint">
        Eigene Websites, die nicht über den deployer laufen, lassen sich mit denselben
        passiven Scannern prüfen. Gescannt wird erst, wenn ein TXT-Eintrag zeigt, dass
        die Domain dir gehört.
      </p>

      <form
        className="form-actions"
        onSubmit={(e) => {
          e.preventDefault()
          if (hostname.trim()) add.mutate()
        }}
      >
        <input aria-label="Hostname" placeholder="www.meine-domain.ch" value={hostname} onChange={(e) => setHostname(e.target.value)} />
        <button className="button-primary" type="submit" disabled={add.isPending || !hostname.trim()}>Ziel hinzufügen</button>
      </form>
      {add.isError && <p role="alert" className="error">{(add.error as Error).message}</p>}

      {list.isLoading ? (
        <p className="state state-loading">Wird geladen…</p>
      ) : list.isError ? (
        <p className="state state-error" role="alert">Liste nicht abrufbar.</p>
      ) : list.data!.targets.length === 0 ? (
        <p className="state state-empty">Noch keine externen Ziele.</p>
      ) : (
        <ul className="target-list">
          {list.data!.targets.map((t) => <Target key={t.id} t={t} />)}
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
    refetchInterval: (q) => {
      const st = q.state.data?.report?.scan.status
      return st === 'queued' || st === 'running' ? 4000 : false
    },
  })

  return (
    <li className="target">
      <div className="target-head">
        <strong>{t.hostname}</strong>
        <span className={t.verified ? 'badge badge-ok' : 'badge badge-warn'}>
          {t.verified ? '✓ verifiziert' : '! nicht verifiziert'}
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
        <button onClick={() => verify.mutate()} disabled={verify.isPending}>{verify.isPending ? 'Prüft …' : 'Prüfen'}</button>
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
          <button onClick={() => setConfirmDelete(true)}>Entfernen …</button>
        ) : (
          <>
            <button className="button-danger" onClick={() => del.mutate()}>Ja, entfernen</button>
            <button onClick={() => setConfirmDelete(false)}>Abbrechen</button>
          </>
        )}
      </div>
      {verifyNote && <p className="hint" role="status">{verifyNote}</p>}
      {[verify, interval, scan, del].map((m, i) =>
        m.isError ? <p key={i} role="alert" className="error">{m.error instanceof ApiError ? m.error.message : 'Fehler'}</p> : null,
      )}

      {showReport && (
        report.isLoading ? <p className="state state-loading">Wird geladen…</p>
        : report.data?.report ? <ScanReport report={report.data.report} onAccepted={() => void report.refetch()} />
        : <p className="state state-empty">Noch kein Scan.</p>
      )}
    </li>
  )
}

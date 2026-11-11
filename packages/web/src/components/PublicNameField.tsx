import { useEffect, useId, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { normalizePublicLabel, type PublicNameCheckDto } from '@airlock/shared'
import { api, ApiError } from '../api.js'
import { applyNameInput, hostOf, verdictOf, type PublicName, type Verdict } from '../lib/public-name.js'
import { FieldError } from './Field.js'
import { IconBad, IconOk, IconPending, IconWarn } from './Icons.js'
import { Switch } from './Switch.js'

/**
 * Öffentlichen Namen beim Tippen prüfen, 300 ms nach der letzten Eingabe:
 * Form, reserviert, in Airlock vergeben, fremder DNS-Eintrag bei Cloudflare.
 * Mit Projekt dessen eigene Prüfung (die eigene Adresse zählt nicht als
 * vergeben), ohne Projekt die der Umgebung (Neues Projekt).
 */
export function usePublicNameCheck(o: {
  projectId: string | null
  name: PublicName
  enabled: boolean
  takeOver: boolean
  /** Fremden Eintrag ersetzen anbieten (beim Anlegen nicht) */
  canTakeOver: boolean
  /** Aktuelle Adresse: gleich = nichts zu prüfen */
  current?: string | null
}) {
  const host = hostOf(o.name)
  const [debounced, setDebounced] = useState<PublicName | null>(null)
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ ...o.name, label: normalizePublicLabel(o.name.label) }), 300)
    return () => clearTimeout(t)
  }, [o.name.label, o.name.zone, o.name.apex]) // eslint-disable-line react-hooks/exhaustive-deps
  const dHost = debounced ? hostOf(debounced) : null
  const same = Boolean(host && o.current && host === o.current)
  const q = useQuery({
    queryKey: ['public-check', o.projectId ?? 'neu', dHost],
    queryFn: ({ signal }) => api.publicCheck(o.projectId, { name: debounced!.label, zone: debounced!.zone, apex: debounced!.apex }, signal).then((r) => r.check),
    enabled: o.enabled && Boolean(dHost) && !same,
    // Kurz frisch halten: ein anderes Projekt oder Cloudflare kann den Namen inzwischen belegen
    staleTime: 5_000,
    retry: false,
  })
  // Nur ein Ergebnis zum angezeigten Namen zählt; davor «wird geprüft»
  const fresh = q.data && q.data.host === host ? q.data : null
  const checking = o.enabled && Boolean(host) && !same && (dHost !== host || q.isFetching)
  const failed = !checking && q.isError && dHost === host ? (q.error instanceof ApiError ? q.error.message : 'Die Prüfung ging nicht.') : null
  const { verdict, blocking } = !o.enabled || !host
    ? { verdict: { tone: 'idle' } as Verdict, blocking: false }
    : same ? verdictOf({ host, label: o.name.label, zone: o.name.zone, apex: o.name.apex, zones: [], problems: [], existing: null }, { checking: false, takeOver: false, canTakeOver: o.canTakeOver, current: o.current })
    : verdictOf(fresh, { checking, takeOver: o.takeOver, canTakeOver: o.canTakeOver, failed })
  return { host, check: fresh as PublicNameCheckDto | null, verdict, blocking, checking, same }
}

export type PublicNameCheck = ReturnType<typeof usePublicNameCheck>

const TONE_ICON = { ok: IconOk, warn: IconWarn, bad: IconBad, checking: IconPending } as const

/**
 * Öffentliche Adresse als geteiltes Feld: Name · «.» · Domain der Umgebung
 * (bei nur einer fester Text), Schalter «Direkt unter <zone>», Vorschau der
 * fertigen Adresse und das Ergebnis der Prüfung als Zeile mit Zeichen und
 * Wort. Ein eingefügter voller Name wird zerlegt; beim Tippen wird
 * normalisiert. Gemeinsam für Veröffentlichen, Adresse ändern und Neues
 * Projekt.
 */
export function PublicNameField({
  inputId, label, zones, value, onChange, takeOver, onTakeOver, canTakeOver, result, error, placeholder, onBlur, hint,
}: {
  inputId: string
  label: ReactNode
  zones: string[]
  value: PublicName
  onChange: (n: PublicName) => void
  takeOver: boolean
  onTakeOver: (b: boolean) => void
  canTakeOver: boolean
  result: PublicNameCheck
  /** Meldung des Formulars oder der API */
  error?: string
  placeholder?: string
  onBlur?: () => void
  hint?: ReactNode
}) {
  const uid = useId()
  const zoneId = `${uid}-zone`
  const apexId = `${uid}-apex`
  const statusId = `${inputId}-status`
  const previewId = `${inputId}-preview`
  const noteId = `${inputId}-note`
  const [note, setNote] = useState<string | null>(null)
  const set = (n: PublicName) => { onChange(n); if (takeOver) onTakeOver(false) }
  const { verdict, host } = result
  const Icon = verdict.tone === 'idle' ? null : TONE_ICON[verdict.tone]
  const showTakeOver = canTakeOver && result.check?.existing && !result.check.existing.worker && verdict.tone === 'warn'
  const describedBy = [error ? `${inputId}-error` : null, note ? noteId : null, previewId, statusId].filter(Boolean).join(' ')

  return (
    <div className={error ? 'field field-invalid pubname' : 'field pubname'}>
      <label htmlFor={value.apex ? (zones.length > 1 ? zoneId : undefined) : inputId}>{label}</label>
      <div className="pubname-row">
        {!value.apex && (
          <>
            <input
              id={inputId}
              value={value.label}
              placeholder={placeholder}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="none"
              maxLength={300}
              aria-invalid={error || verdict.tone === 'bad' ? true : undefined}
              aria-describedby={describedBy}
              onChange={(e) => {
                const r = applyNameInput(e.target.value, zones, value)
                setNote(r.note)
                set(r.name)
              }}
              onBlur={() => {
                const n = normalizePublicLabel(value.label)
                if (n !== value.label) onChange({ ...value, label: n })
                onBlur?.()
              }}
            />
            <span className="pubname-dot" aria-hidden="true">.</span>
          </>
        )}
        {zones.length > 1 ? (
          <>
            <label className="sr-only" htmlFor={zoneId}>Domain</label>
            <select id={zoneId} className="pubname-select" value={value.zone} onChange={(e) => set({ ...value, zone: e.target.value })} aria-describedby={value.apex ? describedBy : undefined}>
              {zones.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </>
        ) : (
          <span className="pubname-zone">{value.zone}</span>
        )}
      </div>
      {error && <FieldError id={inputId} message={error} />}
      {note && <p className="hint pubname-note" id={noteId}><IconWarn /> {note}</p>}
      <p className="pubname-preview" id={previewId} aria-live="polite">
        {host ? <>Adresse: <code>https://{host}</code></> : <span className="muted">Adresse: noch kein Name</span>}
      </p>
      <p className={`pubname-status pubname-${verdict.tone}`} id={statusId} role="status">
        {Icon && <Icon size={14} />}
        {verdict.tone === 'idle'
          ? <span className="muted">{hint ?? 'Nur a–z, 0–9 und Bindestrich; Umlaute werden zu ae, oe, ue.'}</span>
          : <span><strong>{verdict.word}</strong>{'text' in verdict && verdict.text ? <span className="pubname-detail"> · {verdict.text}</span> : null}</span>}
      </p>
      {showTakeOver && (
        <label className="choice pubname-takeover">
          <input type="checkbox" checked={takeOver} onChange={(e) => onTakeOver(e.target.checked)} />
          <span>
            Bestehenden Eintrag ersetzen
            <small>Der Eintrag {result.check!.existing!.type} → {result.check!.existing!.content} wird gelöscht; danach zeigt {host} auf den Tunnel.</small>
          </span>
        </label>
      )}
      <div className="pubname-apex">
        <Switch checked={value.apex} labelledBy={apexId} onChange={(b) => set({ ...value, apex: b })} />
        <span id={apexId}>Direkt unter <code>{value.zone}</code></span>
        <span className="muted">{value.apex ? 'An · ohne Namen davor' : 'Aus'}</span>
      </div>
    </div>
  )
}

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  pausePageSchema, renderPausePage, renderPauseForm, forcePreviewScheme, parseLocalDateTime, toLocalDateTime, backAtProblem,
  PAUSE_HTML_MAX, PAUSE_BACK_MAX_MS, type PausePage,
} from '@airlock/shared'
import { Field } from './Field.js'
import { isoOf } from '../lib/dates.js'

/**
 * Pause-Seite bearbeiten: Felder (Formular) oder eigenes HTML (Code) links,
 * Live-Vorschau rechts. Die Vorschau nutzt denselben Renderer wie der Server
 * (@airlock/shared) in einem iframe ohne Rechte (sandbox), hell oder dunkel.
 * Für Projekte im Dialog (PausePageDialog), für die Vorlage auf der
 * System-Seite.
 */

export type PausePageErrors = Partial<Record<keyof PausePage, string>>

/** Fehler je Feld aus dem gemeinsamen Schema (gleiche Regeln wie der Server). */
export function pausePageErrors(page: PausePage): PausePageErrors {
  const r = pausePageSchema.safeParse(page)
  if (r.success) return {}
  const out: PausePageErrors = {}
  for (const i of r.error.issues) {
    const k = i.path[0] as keyof PausePage
    if (k && !out[k]) out[k] = i.message
  }
  return out
}

export const samePage = (a: PausePage, b: PausePage) =>
  (a.mode ?? 'form') === (b.mode ?? 'form') &&
  (['title', 'message', 'linkText', 'linkUrl', 'contact', 'html'] as const).every((k) => (a[k] ?? '') === (b[k] ?? ''))

/** Kurzbeschreibung für Zusammenfassungen: «Vorlage», «eigene Seite», «eigener Code». */
export const pageKind = (page: PausePage | null) => (!page ? 'Vorlage' : page.mode === 'code' ? 'eigener Code' : 'eigene Seite')

export function PausePageEditor({ value, onChange, errors = {}, backAt, idPrefix, aside }: {
  value: PausePage
  onChange: (p: PausePage) => void
  errors?: PausePageErrors
  /** Nur für die Vorschau: «Voraussichtlich zurück» */
  backAt?: string | null
  idPrefix?: string
  /** Zusätzliches Feld neben dem Kontakt (Projekt: «Voraussichtlich zurück») */
  aside?: ReactNode
}) {
  const auto = useId()
  const id = (k: string) => `${idPrefix ?? auto}-${k}`
  const set = <K extends keyof PausePage>(k: K, v: PausePage[K]) => onChange({ ...value, [k]: v })
  const aria = (k: keyof PausePage) => (errors[k] ? { 'aria-invalid': true, 'aria-describedby': `${id(k)}-error` } : {})
  const code = value.mode === 'code'
  const [regen, setRegen] = useState(false)
  /** HTML aus den Feldern – Ausgangspunkt für eigenen Code */
  const fromForm = () => renderPauseForm({ ...value, mode: 'form' })
  const toMode = (m: 'form' | 'code') => {
    // Erster Wechsel zu Code: mit dem HTML des Formulars beginnen, nicht leer
    if (m === 'code' && !value.html?.trim()) onChange({ ...value, mode: 'code', html: fromForm() })
    else onChange({ ...value, mode: m })
  }

  return (
    <div className="pause-editor">
      <div className="pause-fields">
        <div className="pause-mode">
          <span className="segmented" role="group" aria-label="Pause-Seite als Formular oder als Code">
            <button type="button" aria-pressed={!code} onClick={() => toMode('form')}>Formular</button>
            <button type="button" aria-pressed={code} onClick={() => toMode('code')}>Code</button>
          </span>
          <span className="hint">{code ? 'Eigenes HTML mit Inline-CSS' : 'Titel, Text und Link – die Seite baut der Server'}</span>
        </div>

        {code ? (
          <>
            <Field id={id('html')} label="HTML" error={errors.html}
              hint={<>Ganzes Dokument mit <code>&lt;style&gt;</code>. Kein JavaScript, keine externen Bilder oder Schriften; Bilder als Inline-SVG. Platzhalter: <code>{'{{back_at}}'}</code>, <code>{'{{title}}'}</code>.</>}>
              <textarea id={id('html')} className="code-input" rows={16} spellCheck={false} autoCapitalize="off" autoComplete="off"
                value={value.html ?? ''} onChange={(e) => set('html', e.target.value)} {...aria('html')} />
            </Field>
            <div className="pause-code-actions">
              {!regen ? (
                <button type="button" className="button-small" onClick={() => setRegen(true)}>Aus Formular übernehmen</button>
              ) : (
                <span className="confirm-inline" role="group" aria-label="HTML aus dem Formular übernehmen">
                  <span className="confirm-note">Ersetzt das HTML durch die Seite aus Titel, Text und Link.</span>
                  <button type="button" className="button-small" onClick={() => setRegen(false)}>Abbrechen</button>
                  <button type="button" className="button-small button-primary" onClick={() => { set('html', fromForm()); setRegen(false) }}>Ersetzen</button>
                </span>
              )}
              <span className="hint">{(value.html ?? '').length.toLocaleString('de-CH')} / {PAUSE_HTML_MAX.toLocaleString('de-CH')} Zeichen</span>
            </div>
            {aside && <div className="pause-grid">{aside}</div>}
          </>
        ) : (
          <div className="pause-grid">
            <Field id={id('title')} label="Titel" error={errors.title}>
              <input id={id('title')} value={value.title} maxLength={120} onChange={(e) => set('title', e.target.value)} {...aria('title')} />
            </Field>
            <Field id={id('message')} label="Text" error={errors.message} hint={<>Leerzeile = neuer Absatz · <code>**fett**</code> · <code>[Text](https://…)</code></>}>
              <textarea id={id('message')} rows={4} value={value.message} maxLength={2000} onChange={(e) => set('message', e.target.value)} {...aria('message')} />
            </Field>
            <div className="pause-pair">
              <Field id={id('linkText')} label="Linktext" optional error={errors.linkText}>
                <input id={id('linkText')} value={value.linkText ?? ''} maxLength={80} placeholder="Statusseite" onChange={(e) => set('linkText', e.target.value)} {...aria('linkText')} />
              </Field>
              <Field id={id('linkUrl')} label="Link-Adresse" optional error={errors.linkUrl}>
                <input id={id('linkUrl')} type="url" inputMode="url" value={value.linkUrl ?? ''} placeholder="https://status.example.ch" onChange={(e) => set('linkUrl', e.target.value)} {...aria('linkUrl')} />
              </Field>
            </div>
            <div className="pause-pair">
              <Field id={id('contact')} label="Kontakt-E-Mail" optional error={errors.contact}>
                <input id={id('contact')} type="email" value={value.contact ?? ''} placeholder="hallo@example.ch" onChange={(e) => set('contact', e.target.value)} {...aria('contact')} />
              </Field>
              {aside}
            </div>
          </div>
        )}
      </div>
      <PausePreview page={value} backAt={backAt} />
    </div>
  )
}

/** Vorschau im iframe (srcdoc, sandbox ohne Rechte): genau die ausgelieferte Seite. */
export function PausePreview({ page, backAt }: { page: PausePage; backAt?: string | null }) {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'))
  // Formular: Farben fest einsetzen. Code: Media-Queries für die Vorschau
  // umschreiben (forcePreviewScheme) – ausgeliefert wird das HTML unverändert.
  const html = useMemo(() => {
    try {
      return page.mode === 'code'
        ? forcePreviewScheme(renderPausePage(page, { backAt: backAt || null }), theme)
        : renderPausePage(page, { backAt: backAt || null, theme })
    } catch {
      return ''
    }
  }, [page, backAt, theme])
  return (
    <figure className="pause-preview">
      <figcaption>
        <span>Vorschau</span>
        <span className="segmented" role="group" aria-label="Vorschau hell oder dunkel">
          <button type="button" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>Hell</button>
          <button type="button" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>Dunkel</button>
        </span>
      </figcaption>
      <iframe title="Vorschau der Pause-Seite" sandbox="" srcDoc={html} style={{ colorScheme: theme }} />
      <p className="hint">HTTP 503 · noindex · no-store{backAt ? ' · Retry-After' : ''}</p>
    </figure>
  )
}

/**
 * Pause-Seite eines Projekts im Dialog statt mitten in der Karte: links die
 * Felder, rechts die Vorschau in voller Höhe, Knöpfe unten fest. Arbeitet
 * auf einer Kopie; erst «saveLabel» gibt sie zurück.
 */
export function PausePageDialog({ open, title, initial, template, initialBackAt, saveLabel, saving, error, onCancel, onSave, withBackAt = true, note }: {
  open: boolean
  title: string
  /** «Voraussichtlich zurück» nur beim Pausieren bzw. während der Pause */
  withBackAt?: boolean
  /** Satz unten links statt des Hinweises zu Retry-After */
  note?: string
  /** Eigene Seite des Projekts; null = Vorlage */
  initial: PausePage | null
  template: PausePage
  initialBackAt: string | null
  saveLabel: string
  saving?: boolean
  error?: string | null
  onCancel: () => void
  /** page null = wie Vorlage */
  onSave: (r: { page: PausePage | null; backAt: string | null }) => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const prefix = useId().replace(/:/g, '')
  const [page, setPage] = useState<PausePage>(initial ?? template)
  const [back, setBack] = useState(toLocalInput(initialBackAt))
  const [backBad, setBackBad] = useState(false)
  const [errors, setErrors] = useState<PausePageErrors>({})

  // Beim Öffnen vom aktuellen Stand ausgehen
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      setPage(initial ?? template)
      setBack(toLocalInput(initialBackAt))
      setBackBad(false)
      setErrors({})
      d.showModal()
    }
    if (!open && d.open) d.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const custom = !samePage(page, template)
  // Nie werfen: Unlesbares (Jahr 333333, halbe Eingabe) wird zur Feldmeldung
  const parsed = withBackAt ? parseLocalDateTime(back) : { iso: null, error: null }
  const backIso = parsed.iso
  const backErr = withBackAt ? (backBad ? 'Ungültiges Datum' : parsed.error ?? backAtProblem(backIso) ?? undefined) : undefined
  const now = Date.now()
  const minBack = toLocalDateTime(isoOf(now))
  const maxBack = toLocalDateTime(isoOf(now + PAUSE_BACK_MAX_MS))

  const submit = () => {
    const errs = custom ? pausePageErrors(page) : {}
    setErrors(errs)
    const first = Object.keys(errs)[0]
    if (first) return document.getElementById(`${prefix}-${first}`)?.focus()
    if (backErr) return document.getElementById(`${prefix}-back`)?.focus()
    onSave({ page: custom ? page : null, backAt: withBackAt ? backIso : initialBackAt })
  }

  return (
    <dialog ref={ref} className="dialog pause-dialog" aria-labelledby={`${prefix}-h`} onClose={onCancel}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <form className="pause-dialog-form" noValidate onSubmit={(e) => { e.preventDefault(); submit() }}>
        <header className="pause-dialog-head">
          <h2 id={`${prefix}-h`}>{title}</h2>
          <span className="pause-dialog-kind">
            {custom ? 'Eigene Seite für dieses Projekt' : 'Wie Vorlage (System → Veröffentlichung)'}
            {custom && <button type="button" className="button-small" onClick={() => { setPage(template); setErrors({}) }}>Wie Vorlage</button>}
          </span>
        </header>
        <div className="pause-dialog-body">
          <PausePageEditor value={page} onChange={(p) => { setPage(p); if (Object.keys(errors).length) setErrors(pausePageErrors(p)) }}
            errors={errors} backAt={backErr ? null : backIso} idPrefix={prefix}
            aside={withBackAt ? (
              <Field id={`${prefix}-back`} label="Voraussichtlich zurück" optional error={backErr}>
                <input id={`${prefix}-back`} type="datetime-local" value={back} min={minBack} max={maxBack}
                  // badInput: Browser verwirft eine halbe oder unmögliche Eingabe still (value '') – trotzdem melden
                  onChange={(e) => { setBack(e.target.value); setBackBad(e.target.validity.badInput) }}
                  {...(backErr ? { 'aria-invalid': true, 'aria-describedby': `${prefix}-back-error` } : {})} />
              </Field>
            ) : undefined} />
        </div>
        <footer className="pause-dialog-foot">
          {error
            ? <p role="alert" className="error-inline">{error}</p>
            : <span className="hint">{note ?? '«Voraussichtlich zurück» erscheint auf der Seite und als Retry-After-Header.'}</span>}
          <span className="pause-dialog-buttons">
            <button type="button" onClick={onCancel}>Abbrechen</button>
            <button type="submit" className="button-primary" disabled={saving} aria-busy={saving || undefined}>{saveLabel}</button>
          </span>
        </footer>
      </form>
    </dialog>
  )
}

/** datetime-local (ohne Zone) ⇄ ISO (UTC) */
// Wirft nie (Regeln in @airlock/shared): ungültige Eingaben ergeben '' bzw. einen Fehlertext
export const toLocalInput = toLocalDateTime
export const fromLocalInput = (v: string) => parseLocalDateTime(v).iso

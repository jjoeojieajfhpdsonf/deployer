import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  pausePageSchema, renderPausePage, renderPauseForm, forcePreviewScheme, parseLocalDateTime, toLocalDateTime, backAtProblem,
  pauseHtmlProblems, utf8Length, PAUSE_BACK_MAX_MS, type PausePage,
} from '@airlock/shared'
import { Field } from './Field.js'
import { InlineConfirm } from './Confirm.js'
import { isoOf } from '../lib/dates.js'
import { confirmLeave, useUnsaved } from '../lib/unsaved.js'
import type { CodeEditorHandle } from './CodeEditor.js'
import { formatHtml } from '../lib/format-html.js'

// CodeMirror erst laden, wenn der HTML-Modus offen ist (eigenes Bündel, nicht im Start der App)
const CodeEditor = lazy(() => import('./CodeEditor.js').then((m) => ({ default: m.CodeEditor })))

/**
 * Pause-Seite bearbeiten: «Einfach» (Titel, Text, Link, Voraussichtlich
 * zurück – Standard) oder «HTML» (nur bei Bedarf) links, Live-Vorschau im
 * Browser-Rahmen rechts. Die Vorschau nutzt denselben Renderer wie der Server
 * (@airlock/shared) in einem iframe ohne Rechte (sandbox), startet im
 * aktuellen Modus und lässt sich hell/dunkel umschalten. Im HTML-Modus ein
 * Code-Editor (CodeMirror 6) mit Prüfleiste: Verstösse sperren das Speichern.
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

/** Im HTML-Modus: Verstösse der Prüfleiste (sperren das Speichern) */
export const codeProblems = (page: PausePage) => (page.mode === 'code' ? pauseHtmlProblems(page.html ?? '') : [])

/** Umschalter «Einfach» / «HTML»; beim ersten Wechsel zu HTML beginnt der Code mit der Seite aus den Feldern. */
export function ModeSwitch({ value, onChange }: { value: PausePage; onChange: (p: PausePage) => void }) {
  const code = value.mode === 'code'
  const toMode = (m: 'form' | 'code') => {
    if (m === 'code' && !value.html?.trim()) onChange({ ...value, mode: 'code', html: renderPauseForm({ ...value, mode: 'form' }) })
    else onChange({ ...value, mode: m })
  }
  return (
    <span className="segmented pause-modes" role="group" aria-label="Pause-Seite einfach oder als HTML">
      <button type="button" aria-pressed={!code} onClick={() => toMode('form')}>Einfach</button>
      <button type="button" aria-pressed={code} onClick={() => toMode('code')}>HTML</button>
    </span>
  )
}

export function PausePageEditor({ value, onChange, errors = {}, backAt, idPrefix, aside, hostname, withModeSwitch = true }: {
  value: PausePage
  onChange: (p: PausePage) => void
  errors?: PausePageErrors
  /** Nur für die Vorschau: «Voraussichtlich zurück» */
  backAt?: string | null
  idPrefix?: string
  /** Zusätzliches Feld neben dem Kontakt (Projekt: «Voraussichtlich zurück») */
  aside?: ReactNode
  /** Adresse im Browser-Rahmen der Vorschau */
  hostname?: string | null
  /** Umschalter hier zeigen (im Dialog steht er im Kopf) */
  withModeSwitch?: boolean
}) {
  const auto = useId()
  const id = (k: string) => `${idPrefix ?? auto}-${k}`
  const set = <K extends keyof PausePage>(k: K, v: PausePage[K]) => onChange({ ...value, [k]: v })
  const aria = (k: keyof PausePage) => (errors[k] ? { 'aria-invalid': true, 'aria-describedby': `${id(k)}-error` } : {})
  const code = value.mode === 'code'
  const [full, setFull] = useState(false)

  return (
    <div className={`pause-editor${code ? ' pause-editor-code' : ''}${full && code ? ' pause-editor-full' : ''}`}>
      <div className="pause-fields">
        {withModeSwitch && (
          <div className="pause-mode">
            <ModeSwitch value={value} onChange={onChange} />
            <span className="hint">{code ? 'Eigenes HTML mit Inline-CSS' : 'Titel, Text und Link – die Seite baut der Server'}</span>
          </div>
        )}

        {code ? (
          <HtmlPane value={value} onChange={onChange} error={errors.html} id={id('html')} full={full} onFull={setFull} aside={aside} />
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
              {aside}
              <Field id={id('contact')} label="Kontakt-E-Mail" optional error={errors.contact}>
                <input id={id('contact')} type="email" value={value.contact ?? ''} placeholder="hallo@example.ch" onChange={(e) => set('contact', e.target.value)} {...aria('contact')} />
              </Field>
            </div>
          </div>
        )}
      </div>
      {!(full && code) && <PausePreview page={value} backAt={backAt} hostname={hostname} />}
    </div>
  )
}

const TOKENS = ['{{title}}', '{{back_at}}'] as const

/** HTML-Modus: Werkzeugleiste, Editor, Prüfleiste */
function HtmlPane({ value, onChange, error, id, full, onFull, aside }: {
  value: PausePage; onChange: (p: PausePage) => void; error?: string; id: string; full: boolean; onFull: (v: boolean) => void; aside?: ReactNode
}) {
  const editor = useRef<CodeEditorHandle>(null)
  const [confirmTemplate, setConfirmTemplate] = useState(false)
  const html = value.html ?? ''
  const problems = useMemo(() => pauseHtmlProblems(html), [html])
  const bytes = utf8Length(html)
  const size = bytes < 1000 ? `${bytes} B` : `${(bytes / 1000).toLocaleString('de-CH', { maximumFractionDigits: 1 })} KB`
  const checkId = `${id}-check`
  return (
    <div className="pause-code">
      <div className="pause-tools" role="toolbar" aria-label="HTML-Werkzeuge">
        <span className="pause-tools-label">Platzhalter einfügen:</span>
        {TOKENS.map((t) => (
          <button key={t} type="button" className="pause-token" onClick={() => editor.current?.insert(t)} aria-label={`Platzhalter ${t} einfügen`}>{t}</button>
        ))}
        <span className="pause-tools-gap" />
        <button type="button" className="button-small" onClick={() => editor.current?.replaceAll(formatHtml(html))}>Formatieren</button>
        {!confirmTemplate
          ? <button type="button" className="button-small" onClick={() => setConfirmTemplate(true)}>Vorlage</button>
          : (
            <InlineConfirm label="HTML durch die Vorlage ersetzen" small tone="primary"
              note="Ersetzt das HTML durch die Seite aus Titel und Text." noteIcon={false} confirmLabel="Ersetzen"
              onCancel={() => setConfirmTemplate(false)}
              onConfirm={() => { editor.current?.replaceAll(renderPauseForm({ ...value, mode: 'form' })); setConfirmTemplate(false) }} />
          )}
        <button type="button" className="button-small button-icon" aria-pressed={full} aria-label={full ? 'Vollbild beenden' : 'Editor im Vollbild'} title={full ? 'Vollbild beenden' : 'Vollbild'} onClick={() => onFull(!full)}>
          {full
            ? <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6.5 2.5v4h-4M9.5 13.5v-4h4M6.5 6.5 2 2M9.5 9.5 14 14" /></svg>
            : <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" /></svg>}
        </button>
      </div>
      <Suspense fallback={<div className="code-editor code-editor-loading" role="status">Editor wird geladen…</div>}>
        <CodeEditor ref={editor} value={html} onChange={(v) => onChange({ ...value, html: v })} label="HTML der Pause-Seite" describedBy={error ? `${id}-error ${checkId}` : checkId} invalid={Boolean(error) || problems.length > 0} />
      </Suspense>
      <div id={checkId} className={`pause-check${problems.length ? ' pause-check-bad' : ''}`} role="status" aria-live="polite">
        {problems.length === 0 ? (
          <span><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>Kein JavaScript · keine externen Quellen · {size}</span>
        ) : (
          <>
            <span className="pause-check-head"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m4.8 4.8 6.4 6.4M11.2 4.8l-6.4 6.4" /></svg>{problems.length === 1 ? '1 Verstoss' : `${problems.length} Verstösse`} · Speichern gesperrt</span>
            <ul>{problems.slice(0, 4).map((p, i) => <li key={i}><strong>Zeile {p.line}:</strong> {p.message}</li>)}</ul>
          </>
        )}
      </div>
      {error && !problems.length && <p className="field-error" id={`${id}-error`}>{error}</p>}
      {aside && <div className="pause-code-aside">{aside}</div>}
    </div>
  )
}

/** Vorschau im Browser-Rahmen (iframe srcdoc, sandbox ohne Rechte): genau die ausgelieferte Seite. */
export function PausePreview({ page, backAt, hostname }: { page: PausePage; backAt?: string | null; hostname?: string | null }) {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (['dark', 'terminal'].includes(document.documentElement.dataset.theme ?? '') ? 'dark' : 'light'))
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
    <figure className="pause-preview" aria-label="Vorschau">
      <div className="pause-browser">
        <div className="pause-browser-bar">
          <span className="pause-browser-dots" aria-hidden="true"><i /><i /><i /></span>
          <span className="pause-browser-url" title="Adresse der Seite"><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>{hostname ?? 'projekt.example.ch'}</span>
          <span className="segmented pause-browser-theme" role="group" aria-label="Vorschau hell oder dunkel">
            <button type="button" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>Hell</button>
            <button type="button" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>Dunkel</button>
          </span>
        </div>
        <iframe title="Vorschau der Pause-Seite" sandbox="" srcDoc={html} style={{ colorScheme: theme }} />
      </div>
    </figure>
  )
}

/**
 * Pause-Seite eines Projekts im Dialog: Kopf mit Titel und Umschalter
 * «Einfach»/«HTML», links Felder oder Editor, rechts die Vorschau,
 * Fusszeile mit den Antwort-Infos (503 · noindex · Retry-After) und den
 * Knöpfen. Arbeitet auf einer Kopie; erst «saveLabel» gibt sie zurück.
 */
export function PausePageDialog({ open, title, initial, template, initialBackAt, saveLabel, saving, error, onCancel, onSave, withBackAt = true, note, hostname }: {
  open: boolean
  title: string
  /** «Voraussichtlich zurück» nur beim Pausieren bzw. während der Pause */
  withBackAt?: boolean
  /** Satz unten links neben den Antwort-Infos */
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
  /** Öffentlicher Name für die Adresszeile der Vorschau */
  hostname?: string | null
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

  // UI-Qualität 8: Änderungen im Editor nicht still verwerfen (Abbrechen, Esc, Klick daneben, Neu laden)
  const changed = open && (JSON.stringify(page) !== JSON.stringify(initial ?? template) || back !== toLocalInput(initialBackAt))
  useUnsaved(changed, 'Pause-Seite')
  const cancel = () => { void confirmLeave().then((ok) => { if (ok) onCancel() }) }

  const custom = !samePage(page, template)
  const blocked = codeProblems(page).length > 0
  // Nie werfen: Unlesbares (Jahr 333333, halbe Eingabe) wird zur Feldmeldung
  const parsed = withBackAt ? parseLocalDateTime(back) : { iso: null, error: null }
  const backIso = parsed.iso
  const backErr = withBackAt ? (backBad ? 'Ungültiges Datum' : parsed.error ?? backAtProblem(backIso) ?? undefined) : undefined
  const now = Date.now()
  const minBack = toLocalDateTime(isoOf(now))
  const maxBack = toLocalDateTime(isoOf(now + PAUSE_BACK_MAX_MS))
  const shownBack = withBackAt ? (backErr ? null : backIso) : initialBackAt

  const submit = () => {
    if (blocked) return
    const errs = custom ? pausePageErrors(page) : {}
    setErrors(errs)
    const first = Object.keys(errs)[0]
    if (first) return document.getElementById(`${prefix}-${first}`)?.focus()
    if (backErr) return document.getElementById(`${prefix}-back`)?.focus()
    onSave({ page: custom ? page : null, backAt: withBackAt ? backIso : initialBackAt })
  }

  return (
    <dialog ref={ref} className="dialog pause-dialog" aria-labelledby={`${prefix}-h`}
      // Schliesst der Browser den Dialog selbst (zweites Esc ohne Nutzeraktion), nicht still verwerfen:
      // wieder öffnen und fragen
      onClose={() => { if (!open) return; if (changed) { ref.current?.showModal(); cancel() } else onCancel() }}
      onCancel={(e) => { if (changed) { e.preventDefault(); cancel() } }}
      onClick={(e) => { if (e.target === e.currentTarget) cancel() }}>
      <form className="pause-dialog-form" noValidate onSubmit={(e) => { e.preventDefault(); submit() }}>
        <header className="pause-dialog-head">
          <div>
            <h2 id={`${prefix}-h`}>{title}</h2>
            <p className="pause-dialog-kind">{custom ? 'Eigene Seite für dieses Projekt' : 'Wie Vorlage (System → Veröffentlichung)'}</p>
          </div>
          <ModeSwitch value={page} onChange={(p) => { setPage(p); if (Object.keys(errors).length) setErrors(pausePageErrors(p)) }} />
        </header>
        <div className="pause-dialog-body">
          <PausePageEditor value={page} onChange={(p) => { setPage(p); if (Object.keys(errors).length) setErrors(pausePageErrors(p)) }}
            errors={errors} backAt={shownBack} idPrefix={prefix} hostname={hostname} withModeSwitch={false}
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
            : <span className="pause-dialog-info">Antwort: 503 · noindex{shownBack ? ' · Retry-After' : ''}{note ? <span className="pause-dialog-note"> · {note}</span> : null}</span>}
          <span className="pause-dialog-buttons">
            {custom && <button type="button" onClick={() => { setPage(template); setErrors({}) }}>Auf Vorlage zurücksetzen</button>}
            <button type="button" onClick={cancel}>Abbrechen</button>
            <button type="submit" className="button-primary" disabled={saving || blocked} aria-busy={saving || undefined} aria-describedby={blocked ? `${prefix}-html-check` : undefined}>{saveLabel}</button>
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

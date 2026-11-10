import { useId, useMemo, useState } from 'react'
import { pausePageSchema, renderPausePage, type PausePage } from '@deployer/shared'
import { Field } from './Field.js'

/**
 * Felder der Pause-Seite mit Live-Vorschau daneben. Die Vorschau nutzt
 * denselben Renderer wie der Server (@deployer/shared) und zeigt ihn in einem
 * iframe ohne Script (sandbox) – hell oder dunkel umschaltbar.
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
  (['lang', 'title', 'message', 'linkText', 'linkUrl', 'contact'] as const).every((k) => (a[k] ?? '') === (b[k] ?? ''))

export function PausePageEditor({ value, onChange, errors = {}, backAt, idPrefix }: {
  value: PausePage
  onChange: (p: PausePage) => void
  errors?: PausePageErrors
  /** Nur für die Vorschau: «Voraussichtlich zurück» */
  backAt?: string | null
  idPrefix?: string
}) {
  const auto = useId()
  const id = (k: string) => `${idPrefix ?? auto}-${k}`
  const set = <K extends keyof PausePage>(k: K, v: PausePage[K]) => onChange({ ...value, [k]: v })
  const aria = (k: keyof PausePage) => (errors[k] ? { 'aria-invalid': true, 'aria-describedby': `${id(k)}-error` } : {})

  return (
    <div className="pause-editor">
      <div className="pause-fields">
        <div className="pause-row">
          <Field id={id('title')} label="Titel" error={errors.title}>
            <input id={id('title')} value={value.title} maxLength={120} onChange={(e) => set('title', e.target.value)} {...aria('title')} />
          </Field>
          <Field id={id('lang')} label="Sprache">
            <select id={id('lang')} value={value.lang} onChange={(e) => set('lang', e.target.value as PausePage['lang'])}>
              <option value="de">Deutsch</option>
              <option value="en">Englisch</option>
            </select>
          </Field>
        </div>
        <Field id={id('message')} label="Text" error={errors.message}
          hint={<>Einfaches Markdown: Leerzeile für einen neuen Absatz, <code>**fett**</code>, <code>[Text](https://…)</code>. Kein HTML.</>}>
          <textarea id={id('message')} rows={4} value={value.message} maxLength={2000} onChange={(e) => set('message', e.target.value)} {...aria('message')} />
        </Field>
        <div className="pause-row">
          <Field id={id('linkText')} label="Linktext" optional error={errors.linkText}>
            <input id={id('linkText')} value={value.linkText ?? ''} maxLength={80} placeholder="Statusseite" onChange={(e) => set('linkText', e.target.value)} {...aria('linkText')} />
          </Field>
          <Field id={id('linkUrl')} label="Link-Adresse" optional error={errors.linkUrl} hint="Nur https">
            <input id={id('linkUrl')} type="url" inputMode="url" value={value.linkUrl ?? ''} placeholder="https://status.example.ch" onChange={(e) => set('linkUrl', e.target.value)} {...aria('linkUrl')} />
          </Field>
        </div>
        <Field id={id('contact')} label="Kontakt-E-Mail" optional error={errors.contact}>
          <input id={id('contact')} type="email" value={value.contact ?? ''} placeholder="hallo@example.ch" onChange={(e) => set('contact', e.target.value)} {...aria('contact')} />
        </Field>
      </div>
      <PausePreview page={value} backAt={backAt} />
    </div>
  )
}

/** Vorschau im iframe (srcdoc, sandbox ohne Rechte): genau die ausgelieferte Seite. */
export function PausePreview({ page, backAt }: { page: PausePage; backAt?: string | null }) {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'))
  // Ungültige Zwischenstände (leerer Titel) trotzdem zeigen, nur ohne Absturz
  const html = useMemo(() => {
    try {
      return renderPausePage(page, { backAt: backAt || null, theme })
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
      <iframe title="Vorschau der Pause-Seite" sandbox="" srcDoc={html} />
      <p className="hint">Antwort mit HTTP 503, noindex und no-store{backAt ? ', Retry-After bis zum angegebenen Zeitpunkt' : ''}.</p>
    </figure>
  )
}

/** datetime-local (ohne Zone) ⇄ ISO (UTC) */
export const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null)

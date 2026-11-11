import { useCallback, useRef, useState } from 'react'
import { ApiError } from '../api.js'

/**
 * Eigene Formular-Prüfung statt der des Browsers (Formulare mit noValidate).
 *
 * - Geprüft wird mit den Zod-Schemas aus @airlock/shared – dieselben Regeln
 *   und Meldungen wie in der API.
 * - Beim Absenden alles; danach live beim Verlassen eines Felds.
 * - Beim Absenden springt der Fokus zum ersten fehlerhaften Feld.
 * - Meldungen stehen unter dem Feld (aria-describedby, aria-invalid).
 *
 * Feldnamen sind die Zod-Pfade mit Punkt: "source.image", "env.0.key".
 */
export type Errors = Record<string, string>

/** Nur was gebraucht wird – jedes Zod-Schema aus @airlock/shared passt. */
export interface Schema {
  safeParse(v: unknown): { success: true } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }
}

export function zodErrors(schema: Schema, values: unknown): Errors {
  const r = schema.safeParse(values)
  if (r.success) return {}
  const out: Errors = {}
  for (const i of r.error.issues) {
    const key = i.path.join('.') || '_form'
    if (!out[key]) out[key] = i.message
  }
  return out
}

/** Fehler der API (ZodError mit details) auf Felder verteilen. */
export function apiFieldErrors(err: unknown): Errors {
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return {}
  const out: Errors = {}
  for (const d of err.details as { path?: string; message?: string }[]) {
    if (d.path && d.message && !out[d.path]) out[d.path] = d.message
  }
  return out
}

export function useFormErrors<T>(opts: {
  schema: Schema
  values: () => T
  /** Zusätzliche Prüfungen, die kein Schema ausdrücken kann (z.B. Datei gewählt). */
  extra?: (v: T) => Errors
  /** Feldname -> id des Eingabefelds, falls sie abweichen. */
  idFor?: (name: string) => string
}) {
  const [errors, setErrors] = useState<Errors>({})
  const submitted = useRef(false)
  const formRef = useRef<HTMLFormElement | null>(null)
  const idFor = opts.idFor ?? ((n: string) => fieldId(n))

  // Immer die Eingaben des letzten Renders prüfen, nicht die eines alten Handlers.
  const optsRef = useRef(opts)
  optsRef.current = opts
  const compute = useCallback((): Errors => {
    const o = optsRef.current
    const v = o.values()
    return { ...zodErrors(o.schema, v), ...(o.extra?.(v) ?? {}) }
  }, [])

  /** Beim Absenden: alles prüfen, Fokus ans erste Fehlerfeld. true = gültig. */
  const validateAll = useCallback((): boolean => {
    submitted.current = true
    const e = compute()
    setErrors(e)
    const names = Object.keys(e)
    if (names.length === 0) return true
    // Erstes fehlerhaftes Feld in der Reihenfolge des Formulars
    requestAnimationFrame(() => {
      const form = formRef.current
      const fields = names.map((n) => document.getElementById(idFor(n))).filter((x): x is HTMLElement => !!x)
      const first = form
        ? [...form.querySelectorAll<HTMLElement>('[aria-invalid="true"]')][0] ?? fields[0]
        : fields[0]
      if (first) {
        first.scrollIntoView({ block: 'center', behavior: 'smooth' })
        first.focus({ preventScroll: true })
      } else {
        document.getElementById(idFor('_form'))?.focus()
      }
    })
    return false
  }, [compute, idFor])

  /**
   * Beim Verlassen eines Felds (UI-Qualität 5): sobald in dem Feld etwas
   * eingegeben wurde – nicht während des Tippens und nicht beim blossen
   * Durchtabben; nach dem ersten Absenden für alle Felder.
   */
  const touched = useRef(new Set<string>())
  const validateField = useCallback((name: string) => {
    if (!submitted.current && !touched.current.has(name)) return
    // Ein Frame später: dann ist die letzte Eingabe gerendert.
    requestAnimationFrame(() => applyField(name))
  }, [])
  const applyField = (name: string) => {
    const e = compute()
    setErrors((prev) => {
      const next = { ...prev }
      if (e[name]) next[name] = e[name]
      else delete next[name]
      // Felder, die inzwischen stimmen, verlieren ihre Meldung ebenfalls
      for (const k of Object.keys(next)) if (!e[k]) delete next[k]
      return next
    })
  }

  /** Fehler aus einer API-Antwort übernehmen (gleiche Pfade). */
  const setServerErrors = useCallback((err: unknown): boolean => {
    const e = apiFieldErrors(err)
    if (Object.keys(e).length === 0) return false
    submitted.current = true
    setErrors(e)
    requestAnimationFrame(() => document.getElementById(idFor(Object.keys(e)[0]!))?.focus())
    return true
  }, [idFor])

  /** Eigenschaften für ein Eingabefeld. */
  const field = (name: string, describedBy?: string) => {
    const id = idFor(name)
    const err = errors[name]
    return {
      id,
      name,
      'aria-invalid': err ? (true as const) : undefined,
      'aria-describedby': [err ? `${id}-error` : null, describedBy].filter(Boolean).join(' ') || undefined,
      onInput: () => { touched.current.add(name) },
      // Geht der Fokus auf einen Knopf (Absenden, Abbrechen), nicht prüfen: die Meldung würde
      // das Layout zwischen Drücken und Loslassen verschieben und den Klick verlieren lassen.
      // Absenden prüft ohnehin alles.
      onBlur: (ev: { relatedTarget: EventTarget | null }) => {
        if (ev.relatedTarget instanceof Element && ev.relatedTarget.closest('button')) return
        validateField(name)
      },
    }
  }

  return { errors, setErrors, validateAll, validateField, setServerErrors, field, formRef, idFor, reset: () => { submitted.current = false; touched.current.clear(); setErrors({}) } }
}

/** Stabile id aus einem Feldnamen: "source.image" -> "f-source-image" */
export const fieldId = (name: string) => `f-${name.replace(/[^a-zA-Z0-9]+/g, '-')}`

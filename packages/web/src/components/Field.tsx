import type { ReactNode } from 'react'

/**
 * Beschriftung, Eingabe, Hinweis und Fehlermeldung eines Felds. Die Meldung
 * hat die id `<feld-id>-error`, auf die das Eingabefeld per
 * aria-describedby zeigt (siehe useFormErrors().field).
 */
export function Field({
  id,
  label,
  error,
  hint,
  children,
  optional,
}: {
  id: string
  label: ReactNode
  error?: string
  hint?: ReactNode
  children: ReactNode
  optional?: boolean
}) {
  return (
    <div className={error ? 'field field-invalid' : 'field'}>
      <label htmlFor={id}>
        {label}
        {optional && <span className="field-optional"> (optional)</span>}
      </label>
      {children}
      {error && <FieldError id={id} message={error} />}
      {hint && !error && <p className="hint" id={`${id}-hint`}>{hint}</p>}
    </div>
  )
}

/** Meldung unter einem Feld; mit Zeichen, nicht nur Farbe. */
export function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <p className="field-error" id={`${id}-error`}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
        <circle cx="8" cy="8" r="6.2" /><path d="M8 4.8v3.6M8 10.9v.1" />
      </svg>
      <span>{message}</span>
    </p>
  )
}

/** Fehler, die keinem Feld gehören (z.B. "_form" oder "source"). */
export function FormError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return <p className="error" id={id} role="alert" tabIndex={-1}>{message}</p>
}

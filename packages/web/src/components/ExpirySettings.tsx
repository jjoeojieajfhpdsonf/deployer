import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../api.js'
import { Field } from './Field.js'

const MIN = 4
const MAX = 3650

/**
 * System → Übersicht: Frist der Chat-Projekte. Standard aus CHAT_EXPIRY_DAYS,
 * hier änderbar; gilt sofort für alle Chat-Projekte (Ablauf ab der letzten
 * Änderung gerechnet).
 */
export function ExpirySettings() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['expiry'], queryFn: api.expiry })
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => { if (q.data) setValue(String(q.data.days)) }, [q.data])
  const save = useMutation({
    mutationFn: (days: number) => api.setExpiry(days),
    onSuccess: (r) => {
      qc.setQueryData(['expiry'], r)
      void qc.invalidateQueries({ queryKey: ['project'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Nicht gespeichert'),
  })
  const d = q.data
  return (
    <section className="expiry-settings" aria-labelledby="expiry-h">
      <h2 id="expiry-h">Ablauf von Chat-Projekten</h2>
      <p className="hint">Chat-Projekte stoppen nach dieser Frist ohne Änderung. Ein Projekt mit «Behalten» läuft unbegrenzt.</p>
      <form
        noValidate
        className="expiry-form"
        onSubmit={(e) => {
          e.preventDefault()
          const n = Number(value)
          if (!Number.isInteger(n) || n < MIN || n > MAX) {
            setError(`Eine ganze Zahl zwischen ${MIN} und ${MAX} Tagen.`)
            requestAnimationFrame(() => document.getElementById('f-expiry-days')?.focus())
            return
          }
          setError(null)
          save.mutate(n)
        }}
      >
        <Field id="f-expiry-days" label="Frist in Tagen" error={error ?? undefined}>
          <input
            id="f-expiry-days"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'f-expiry-days-error' : 'f-expiry-days-hint'}
            disabled={!d}
          />
        </Field>
        <button type="submit" disabled={!d || save.isPending} aria-busy={save.isPending || undefined}>Speichern</button>
        <span role="status" className="expiry-saved">{saved ? '✓ gespeichert' : ''}</span>
      </form>
      {d && <p id="f-expiry-days-hint" className="hint">Standard aus <code>CHAT_EXPIRY_DAYS</code>: {d.fromEnv} Tage{d.changed ? ' – hier geändert' : ''}.</p>}
    </section>
  )
}

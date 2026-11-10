import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { DEFAULT_PAUSE_PAGE, type PausePage } from '@deployer/shared'
import { api, ApiError } from '../api.js'
import { PausePageEditor, pausePageErrors, samePage, type PausePageErrors } from './PausePageEditor.js'

/**
 * System → Veröffentlichung: Vorlage der Pause-Seite. Pausierte Projekte
 * ohne eigenen Text zeigen sie sofort nach dem Speichern.
 */
export function PausePageSettings() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['pause-page-template'], queryFn: api.pausePageTemplate })
  const [page, setPage] = useState<PausePage | null>(null)
  const [errors, setErrors] = useState<PausePageErrors>({})
  useEffect(() => { if (q.data && !page) setPage(q.data.page) }, [q.data, page])

  const save = useMutation({
    mutationFn: (p: PausePage | null) => api.putPausePageTemplate(p),
    onSuccess: (r, p) => {
      qc.setQueryData(['pause-page-template'], r)
      setPage(r.page)
      setErrors({})
      toast.success(p ? 'Vorlage gespeichert' : 'Vorlage auf den Standard zurückgesetzt', { description: 'Pausierte Projekte ohne eigenen Text zeigen sie sofort.' })
    },
    onError: (err) => {
      const details = err instanceof ApiError ? (err.details as { path: string; message: string }[] | undefined) : undefined
      if (details?.length) setErrors(Object.fromEntries(details.map((d) => [d.path.replace(/^page\./, ''), d.message])))
    },
  })

  if (q.isLoading || !page) return <p className="state state-loading">Wird geladen…</p>
  if (q.isError) return <p className="state state-error" role="alert">Vorlage nicht abrufbar.</p>

  const dirty = !samePage(page, q.data!.page)
  const isDefault = samePage(page, DEFAULT_PAUSE_PAGE)

  return (
    <form
      className="field-group pause-settings"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        const errs = pausePageErrors(page)
        setErrors(errs)
        if (Object.keys(errs).length === 0) save.mutate(page)
        else document.getElementById(`pause-tpl-${Object.keys(errs)[0]}`)?.focus()
      }}
    >
      <h2>Pause-Seite</h2>
      <p className="hint">
        Das sehen Besucher eines pausierten öffentlichen Projekts. Jedes Projekt kann beim Pausieren einen eigenen Text setzen; sonst gilt diese Vorlage.
      </p>
      <PausePageEditor value={page} onChange={(p) => { setPage(p); if (Object.keys(errors).length) setErrors(pausePageErrors(p)) }} errors={errors} idPrefix="pause-tpl" />
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={!dirty || save.isPending}>{save.isPending ? 'Wird gespeichert…' : 'Vorlage speichern'}</button>
        {dirty && <button type="button" onClick={() => { setPage(q.data!.page); setErrors({}) }} disabled={save.isPending}>Änderungen verwerfen</button>}
        {!isDefault && !dirty && <button type="button" onClick={() => save.mutate(null)} disabled={save.isPending}>Auf Standard zurücksetzen</button>}
      </div>
      {save.isError && !(save.error instanceof ApiError && save.error.details) && <p role="alert" className="error">{(save.error as Error).message}</p>}
    </form>
  )
}

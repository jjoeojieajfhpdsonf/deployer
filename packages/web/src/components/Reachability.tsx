import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type ProjectDto } from '../api.js'

type Internal = 'lan' | 'tailnet'

/**
 * Interne Erreichbarkeit eines Projekts: Tailnet und LAN (M4, dieselbe
 * interne Adresse), mit eigenem Speichern. Öffentlich steht in der eigenen
 * Karte «Veröffentlichung» und wird hier nicht angefasst.
 */
export function Reachability({ p }: { p: ProjectDto }) {
  const qc = useQueryClient()
  const current = new Set<Internal>(p.routes.flatMap((r) => (r.targets ?? [r.target])).filter((t): t is Internal => t !== 'public'))
  const [want, setWant] = useState<Set<Internal>>(current)
  const [saved, setSaved] = useState(false)

  const save = useMutation({
    mutationFn: () => {
      // Eine eigene interne Subdomain behalten: das Label der bisherigen Adresse.
      const internal = p.routes.find((r) => r.target !== 'public')
      const label = internal?.hostname.split('.')[0]
      return api.putInternalRoutes(p.id, [...want], label && label !== p.slug ? label : undefined)
    },
    onSuccess: () => {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      void qc.invalidateQueries({ queryKey: ['project', p.id] })
      void qc.invalidateQueries({ queryKey: ['public', p.id] })
    },
  })

  const toggle = (t: Internal) => {
    const n = new Set(want)
    if (n.has(t)) n.delete(t)
    else n.add(t)
    setWant(n)
  }
  const changed = [...want].sort().join() !== [...current].sort().join()
  const hasPublic = p.routes.some((r) => r.target === 'public')

  return (
    <fieldset className="field-group">
      <legend>Interne Erreichbarkeit</legend>
      <label className="choice">
        <input type="checkbox" checked={want.has('tailnet')} onChange={() => toggle('tailnet')} />
        <span>Tailnet <small>über Tailscale, im Heimnetz und unterwegs – die Hauptadresse des Servers</small></span>
      </label>
      <label className="choice">
        <input type="checkbox" checked={want.has('lan')} onChange={() => toggle('lan')} />
        <span>Heimnetz (LAN) ohne Tailscale <small>für die eigene interne Adresse braucht es einen lokalen DNS, der sie auf die LAN-IP zeigt; sonst nur über die nip.io-Adresse mit der LAN-IP</small></span>
      </label>

      {want.size === 0 && <p className="hint">{hasPublic ? 'Ohne internes Ziel ist das Projekt nur noch öffentlich erreichbar.' : 'Ohne Ziel ist das Projekt nirgends erreichbar.'}</p>}
      <div className="form-actions">
        <button className="button-primary" disabled={!changed || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Wird gespeichert…' : saved ? 'Gespeichert' : 'Interne Ziele speichern'}
        </button>
      </div>
      {save.isError && <p role="alert" className="error">{save.error instanceof ApiError ? save.error.message : 'Nicht gespeichert'}</p>}
    </fieldset>
  )
}

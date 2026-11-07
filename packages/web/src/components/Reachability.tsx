import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type ProjectDto } from '../api.js'

type Target = 'lan' | 'tailnet' | 'public'

/**
 * Erreichbarkeit eines Projekts (M4: LAN und Tailnet unter derselben
 * internen Adresse). Jedes Ziel mit Wort und Häkchen, nicht nur Farbe.
 */
export function Reachability({ p }: { p: ProjectDto }) {
  const qc = useQueryClient()
  const current = new Set<Target>(p.routes.flatMap((r) => (r.targets ?? [r.target]) as Target[]))
  const [want, setWant] = useState<Set<Target>>(current)
  const save = useMutation({
    // Eine eigene Subdomain behalten: das Label der bisherigen Adresse.
    mutationFn: () => {
      const label = p.routes[0]?.hostname.split('.')[0]
      return api.putRoutes(p.id, [...want], label && label !== p.slug ? label : undefined)
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['project', p.id] }),
  })
  const toggle = (t: Target) => {
    const n = new Set(want)
    if (n.has(t)) n.delete(t)
    else n.add(t)
    setWant(n)
  }
  const changed = [...want].sort().join() !== [...current].sort().join()

  return (
    <fieldset className="field-group">
      <legend>Erreichbarkeit</legend>
      <label className="choice">
        <input type="checkbox" checked={want.has('lan')} onChange={() => toggle('lan')} />
        <span>Heimnetz (LAN)</span>
      </label>
      <label className="choice">
        <input type="checkbox" checked={want.has('tailnet')} onChange={() => toggle('tailnet')} />
        <span>Tailnet <small>dieselbe Adresse, unterwegs über Tailscale</small></span>
      </label>
      <label className="choice choice-disabled">
        <input type="checkbox" disabled checked={false} />
        <span>Öffentlich <small>kommt mit Meilenstein 5</small></span>
      </label>
      {want.size === 0 && <p className="hint">Ohne Ziel ist das Projekt nirgends erreichbar.</p>}
      <div className="form-actions">
        <button className="button-primary" disabled={!changed || save.isPending} onClick={() => save.mutate()}>Erreichbarkeit speichern</button>
      </div>
      {save.isError && <p role="alert" className="error">{save.error instanceof ApiError ? save.error.message : 'Nicht gespeichert'}</p>}
    </fieldset>
  )
}

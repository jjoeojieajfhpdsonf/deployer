import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type ProjectDto } from '../api.js'

type Target = 'lan' | 'tailnet' | 'public'

/**
 * Erreichbarkeit eines Projekts: LAN und Tailnet (M4, dieselbe interne
 * Adresse) und öffentlich über Cloudflare Tunnel (M5). Jedes Ziel mit Wort
 * und Häkchen, nicht nur Farbe. Öffentlich verlangt eine Rückfrage.
 */
export function Reachability({ p }: { p: ProjectDto }) {
  const qc = useQueryClient()
  const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
  const pubRoute = p.routes.find((r) => r.target === 'public')
  const current = new Set<Target>(p.routes.flatMap((r) => (r.targets ?? [r.target]) as Target[]))
  const [want, setWant] = useState<Set<Target>>(current)
  const [pubName, setPubName] = useState(pubRoute?.hostname ?? '')
  const [access, setAccess] = useState(Boolean(pubRoute?.accessProtected))
  const [confirming, setConfirming] = useState(false)

  const defaultZone = domains.data?.domains.find((d) => d.isDefault)?.name ?? null
  const publicEnabled = Boolean(domains.data?.publicEnabled)

  const save = useMutation({
    mutationFn: () => {
      // Eine eigene interne Subdomain behalten: das Label der bisherigen Adresse.
      const internal = p.routes.find((r) => r.target !== 'public')
      const label = internal?.hostname.split('.')[0]
      const name = pubName.trim().toLowerCase()
      const pub = want.has('public')
        ? name.includes('.') ? { publicHostname: name, accessProtected: access } : { publicSubdomain: name || p.slug, accessProtected: access }
        : undefined
      return api.putRoutes(p.id, [...want], label && label !== p.slug ? label : undefined, pub)
    },
    onSuccess: () => {
      setConfirming(false)
      void qc.invalidateQueries({ queryKey: ['project', p.id] })
    },
    onError: () => setConfirming(false),
  })

  const toggle = (t: Target) => {
    const n = new Set(want)
    if (n.has(t)) n.delete(t)
    else n.add(t)
    setWant(n)
  }
  const pubChanged = want.has('public') && (pubName.trim().toLowerCase() !== (pubRoute?.hostname ?? '') || access !== Boolean(pubRoute?.accessProtected))
  const changed = [...want].sort().join() !== [...current].sort().join() || pubChanged
  // Rückfrage, sobald "öffentlich" dazukommt oder sich Name/Access ändert.
  const needsConfirm = want.has('public') && (!current.has('public') || pubChanged)

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
      <label className={publicEnabled ? 'choice' : 'choice choice-disabled'}>
        <input type="checkbox" disabled={!publicEnabled} checked={want.has('public')} onChange={() => toggle('public')} />
        <span>
          Öffentlich im Internet{' '}
          <small>{publicEnabled ? 'über Cloudflare Tunnel; nur mit abgeschlossenem Scan ohne kritischen Befund' : 'nicht eingerichtet (Cloudflare-Tunnel fehlt)'}</small>
        </span>
      </label>

      {want.has('public') && publicEnabled && (
        <div className="public-options">
          <label>
            Öffentlicher Name
            <input
              value={pubName}
              placeholder={defaultZone ? `${p.slug}.${defaultZone}` : 'name.deinedomain.ch'}
              onChange={(e) => setPubName(e.target.value)}
            />
          </label>
          <p className="hint">
            Nur die Subdomain ({defaultZone ? <>wird zu <code>…{'.'}{defaultZone}</code></> : 'keine Standard-Domain gesetzt'}) oder ein voller Name in einer Zone des Kontos.
          </p>
          <label className="choice">
            <input type="checkbox" checked={access} onChange={(e) => setAccess(e.target.checked)} />
            <span>Cloudflare Access <small>nur nach Login per E-Mail-Code</small></span>
          </label>
        </div>
      )}

      {want.size === 0 && <p className="hint">Ohne Ziel ist das Projekt nirgends erreichbar.</p>}
      <div className="form-actions">
        {!confirming && (
          <button
            className="button-primary"
            disabled={!changed || save.isPending}
            onClick={() => (needsConfirm ? setConfirming(true) : save.mutate())}
          >
            Erreichbarkeit speichern
          </button>
        )}
        {confirming && (
          <>
            <span className="warn">! «{p.name}» wird für alle im Internet erreichbar. Sicher?</span>
            <button className="button-danger" disabled={save.isPending} onClick={() => save.mutate()}>Ja, öffentlich machen</button>
            <button onClick={() => setConfirming(false)}>Abbrechen</button>
          </>
        )}
      </div>
      {save.isError && <p role="alert" className="error">{save.error instanceof ApiError ? save.error.message : 'Nicht gespeichert'}</p>}
    </fieldset>
  )
}

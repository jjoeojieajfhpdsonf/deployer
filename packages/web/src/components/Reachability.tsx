import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type ProjectDto } from '../api.js'
import { publicNameFormSchema } from '@deployer/shared'
import { useFormErrors } from '../lib/form.js'
import { Field } from './Field.js'

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

  const v = useFormErrors({ schema: publicNameFormSchema, values: () => ({ name: pubName }) })
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
      v.reset()
      void qc.invalidateQueries({ queryKey: ['project', p.id] })
    },
    onError: (err) => {
      setConfirming(false)
      // Was nur der Server prüfen kann (Zone des Kontos, belegt, fremder DNS-Eintrag), steht am Namensfeld.
      if (want.has('public') && err instanceof ApiError && (err.status === 400 || err.status === 409) && err.code !== 'not_publishable' && err.code !== 'public_disabled') {
        v.setErrors({ name: err.message })
        requestAnimationFrame(() => document.getElementById(v.idFor('name'))?.focus())
      }
    },
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
        <input type="checkbox" checked={want.has('tailnet')} onChange={() => toggle('tailnet')} />
        <span>Tailnet <small>über Tailscale, im Heimnetz und unterwegs – die Hauptadresse des Servers</small></span>
      </label>
      <label className="choice">
        <input type="checkbox" checked={want.has('lan')} onChange={() => toggle('lan')} />
        <span>Heimnetz (LAN) ohne Tailscale <small>für die eigene interne Adresse braucht es einen lokalen DNS, der sie auf die LAN-IP zeigt; sonst nur über die nip.io-Adresse mit der LAN-IP</small></span>
      </label>
      <label className={publicEnabled ? 'choice' : 'choice choice-disabled'}>
        <input type="checkbox" disabled={!publicEnabled} checked={want.has('public')} onChange={() => toggle('public')} />
        <span>
          Öffentlich im Internet{' '}
          <small>{publicEnabled ? 'über Cloudflare Tunnel; nur mit abgeschlossenem Scan ohne kritischen Befund' : 'braucht einen Cloudflare-Tunnel – unter System → Cloudflare verbinden einrichten'}</small>
        </span>
      </label>

      {want.has('public') && publicEnabled && (
        <div className="public-options">
          <Field id={v.idFor('name')} label="Öffentlicher Name" optional error={v.errors.name}
            hint={<>Nur die Subdomain ({defaultZone ? <>wird zu <code>…{'.'}{defaultZone}</code></> : 'keine Standard-Domain gesetzt'}) oder ein voller Name in einer Zone des Kontos. Leer = <code>{p.slug}</code>.</>}>
            <input
              {...v.field('name', `${v.idFor('name')}-hint`)}
              value={pubName}
              placeholder={defaultZone ? `${p.slug}.${defaultZone}` : 'name.deinedomain.ch'}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setPubName(e.target.value)}
            />
          </Field>
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
            onClick={() => {
              // Erst prüfen, dann fragen – bestätigt wird nur, was auch gehen kann.
              if (want.has('public') && !v.validateAll()) return
              if (needsConfirm) setConfirming(true)
              else save.mutate()
            }}
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
      {save.isError && !v.errors.name && <p role="alert" className="error">{save.error instanceof ApiError ? save.error.message : 'Nicht gespeichert'}</p>}
    </fieldset>
  )
}

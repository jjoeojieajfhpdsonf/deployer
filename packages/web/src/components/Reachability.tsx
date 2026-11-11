import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, ApiError, type ProjectDto } from '../api.js'
import { SetRow } from './Publication.js'
import { Switch } from './Switch.js'

type Internal = 'lan' | 'tailnet'

/**
 * Die Schalter Tailnet/LAN eines Projekts: speichern sofort, Toast mit
 * «Rückgängig». Gemeinsam für die Karte «Erreichbarkeit intern» und die
 * Seitenkarte im Reiter «Aufbau».
 */
export function useInternalReach(p: ProjectDto) {
  const qc = useQueryClient()
  const current = new Set<Internal>(p.routes.flatMap((r) => (r.targets ?? [r.target])).filter((t): t is Internal => t !== 'public'))
  const [want, setWant] = useState<Set<Internal>>(current)
  const [saved, setSaved] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const internal = p.routes.find((r) => r.target !== 'public')
  const host = internal?.hostname ?? null
  // Eine eigene interne Subdomain behalten: das Label der bisherigen Adresse.
  const label = host?.split('.')[0]
  const key = [...current].sort().join()
  useEffect(() => setWant(new Set(current)), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const save = useMutation({
    meta: { quiet: true },
    mutationFn: ({ targets }: { targets: Internal[]; before: Internal[]; undo?: boolean }) =>
      api.putInternalRoutes(p.id, targets, label && label !== p.slug ? label : undefined),
    onSuccess: (_r, v) => {
      setSaved(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setSaved(false), 2500)
      void qc.invalidateQueries({ queryKey: ['project', p.id] })
      void qc.invalidateQueries({ queryKey: ['public', p.id] })
      void qc.invalidateQueries({ queryKey: ['topology', p.id] })
      const words = (t: Internal[]) => (t.length ? t.map((x) => (x === 'lan' ? 'LAN' : 'Tailnet')).join(' und ') : 'nirgends intern')
      toast.success(v.undo ? 'Rückgängig: Erreichbarkeit wie vorher' : 'Erreichbarkeit gespeichert', {
        id: `reach-${p.id}`,
        description: `Intern: ${words(v.targets)}.`,
        duration: 10_000,
        ...(v.undo ? {} : { action: { label: 'Rückgängig', onClick: () => { setWant(new Set(v.before)); save.mutate({ targets: v.before, before: v.targets, undo: true }) } } }),
      })
    },
    onError: (err, v) => {
      setWant(new Set(v.before))
      toast.error('Nicht gespeichert', { id: `reach-${p.id}`, description: err instanceof ApiError ? err.message : 'Die Erreichbarkeit blieb wie vorher.' })
    },
  })

  const toggle = (t: Internal, on: boolean) => {
    const before = [...want]
    const n = new Set(want)
    if (on) n.add(t)
    else n.delete(t)
    setWant(n)
    save.mutate({ targets: [...n], before })
  }
  return { want, toggle, saved, pending: save.isPending, internal, host }
}

/**
 * Interne Erreichbarkeit eines Projekts: Tailnet und LAN als Schalter (M4,
 * dieselbe interne Adresse). Jeder Schalter speichert sofort, im Kopf steht
 * «✓ gespeichert»; ein Toast bietet 10 s lang «Rückgängig». Öffentlich steht
 * in der Karte «Veröffentlichung» und wird hier nicht angefasst.
 */
export function Reachability({ p }: { p: ProjectDto }) {
  const { want, toggle, saved, pending, internal, host } = useInternalReach(p)
  const titleId = useId()
  const tailId = useId()
  const lanId = useId()
  const hasPublic = p.routes.some((r) => r.target === 'public')

  return (
    <section className="set-card" id="set-erreichbarkeit" aria-labelledby={titleId}>
      <div className="set-head">
        <h2 id={titleId} tabIndex={-1}>Erreichbarkeit intern</h2>
        <span className={`set-saved${saved ? ' set-saved-on' : ''}`} role="status" aria-live="polite">
          {pending ? 'speichert…' : saved ?<><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg> gespeichert</> : ''}
        </span>
      </div>
      <SetRow label={<span id={tailId}>Tailnet</span>} action={<Switch checked={want.has('tailnet')} labelledBy={tailId} busy={pending} onChange={(on) => toggle('tailnet', on)} />}>
        {host ? <a href={internal!.urls[0]} target="_blank" rel="noreferrer">{host}</a> : <strong className="set-strong">{want.has('tailnet') ? 'an' : 'aus'}</strong>}
        <span className="muted"> · im Heimnetz und unterwegs{!want.has('tailnet') ? ' · aus' : ''}</span>
      </SetRow>
      <SetRow label={<span id={lanId}>Heimnetz (LAN)</span>} action={<Switch checked={want.has('lan')} labelledBy={lanId} busy={pending} onChange={(on) => toggle('lan', on)} />}>
        <strong className="set-strong">ohne Tailnet</strong>
        <span className="muted"> · braucht lokalen DNS, sonst nip.io{!want.has('lan') ? ' · aus' : ''}</span>
      </SetRow>
      {want.size === 0 && <p className="set-row-note">{hasPublic ? 'Ohne internes Ziel ist das Projekt nur noch öffentlich erreichbar.' : 'Ohne Ziel ist das Projekt nirgends erreichbar.'}</p>}
    </section>
  )
}

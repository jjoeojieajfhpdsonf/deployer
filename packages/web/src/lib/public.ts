import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, ApiError, type PublicFlowResult } from '../api.js'
import type { PauseOptions } from '@airlock/shared'

/**
 * Übergänge der Veröffentlichung, gemeinsam für die Karte in den
 * Einstellungen und das «…»-Menü der Projektkarte. Jeder Übergang ist sofort
 * wirksam (die Rückfrage stellt der Aufrufer), meldet sich danach mit einem
 * Toast und bietet 10 s lang «Rückgängig» an.
 */

export type PublicAction =
  | { op: 'publish'; name?: string; access: boolean }
  | { op: 'access'; access: boolean }
  /** opts: eigene Pause-Seite und «Voraussichtlich zurück» (fehlt: Vorlage) */
  | { op: 'pause'; opts?: PauseOptions }
  | { op: 'resume' }
  | { op: 'unpublish' }
  /** Rückgängig von «ganz offline»: derselbe Name, derselbe Access */
  | { op: 'republish'; hostname: string; access: boolean }
  /** Öffentliche Adresse ändern (Subdomain oder voller Name); before für «Rückgängig» */
  | { op: 'rename'; name: string; access: boolean; before: string }

type Run = { action: PublicAction; undo?: boolean }

export const UNDO_MS = 10_000

function call(id: string, a: PublicAction): Promise<PublicFlowResult & { removed?: { hostname: string; accessProtected: boolean } }> {
  switch (a.op) {
    case 'publish': {
      const name = a.name?.trim().toLowerCase()
      return api.publish(id, name ? (name.includes('.') ? { publicHostname: name, accessProtected: a.access } : { publicSubdomain: name, accessProtected: a.access }) : { accessProtected: a.access })
    }
    case 'access': return api.publish(id, { accessProtected: a.access })
    case 'pause': return api.pausePublic(id, a.opts)
    case 'resume': return api.resumePublic(id)
    case 'unpublish': return api.unpublish(id)
    case 'republish': return api.publish(id, { publicHostname: a.hostname, accessProtected: a.access })
    case 'rename': {
      const name = a.name.trim().toLowerCase()
      return api.publish(id, name.includes('.') ? { publicHostname: name, accessProtected: a.access } : { publicSubdomain: name, accessProtected: a.access })
    }
  }
}

/** Was «Rückgängig» auslöst; null = nichts anzubieten. */
function inverse(a: PublicAction, r: Awaited<ReturnType<typeof call>>): PublicAction | null {
  switch (a.op) {
    case 'publish': case 'republish': return { op: 'unpublish' }
    case 'access': return { op: 'access', access: !a.access }
    case 'pause': return r.changed ? { op: 'resume' } : null
    case 'resume': return r.changed ? { op: 'pause' } : null
    case 'unpublish': return r.removed ? { op: 'republish', hostname: r.removed.hostname, access: r.removed.accessProtected } : null
    case 'rename': return r.hostname && r.hostname !== a.before ? { op: 'rename', name: a.before, access: a.access, before: r.hostname } : null
  }
}

function message(name: string, a: PublicAction, r: Awaited<ReturnType<typeof call>>): { title: string; description: string } {
  const host = r.hostname ?? r.status.hostname ?? ''
  switch (a.op) {
    case 'publish': case 'republish': return { title: `«${name}» ist öffentlich`, description: `https://${host}` }
    case 'access': return { title: a.access ? 'Cloudflare Access ist an' : 'Cloudflare Access ist aus', description: a.access ? `${host} verlangt jetzt einen Login per E-Mail-Code.` : `${host} ist ohne Login erreichbar.` }
    case 'pause': return { title: `«${name}» ist pausiert`, description: `Unter ${host} erscheint eine Wartungsseite.` }
    case 'resume': return { title: `«${name}» ist wieder online`, description: `https://${host}` }
    case 'unpublish': return { title: `«${name}» ist nicht mehr öffentlich`, description: `${host} ist frei. Intern bleibt das Projekt erreichbar.` }
    case 'rename': return { title: 'Öffentliche Adresse geändert', description: `https://${host} · ${a.before} ist frei.` }
  }
}

export function usePublicActions(p: { id: string; name: string }) {
  const qc = useQueryClient()
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['public', p.id] }),
    qc.invalidateQueries({ queryKey: ['project', p.id] }),
    qc.invalidateQueries({ queryKey: ['projects'] }),
  ])

  const m = useMutation({
    mutationFn: ({ action }: Run) => call(p.id, action),
    onSuccess: (r, { action, undo }) => {
      void refresh()
      const { title, description } = message(p.name, action, r)
      // Prüfung von aussen: ein Fehlschlag ist eine Warnung, kein Abbruch – er steht im Toast
      const warn = r.check && !r.check.ok ? r.check.message : null
      const back = undo ? null : inverse(action, r)
      const opts = {
        id: `public-${p.id}`,
        description: warn ? `${description} · ${warn}` : description,
        duration: UNDO_MS,
        ...(back ? { action: { label: 'Rückgängig', onClick: () => m.mutate({ action: back, undo: true }) } } : {}),
      }
      if (undo) toast.success(`Rückgängig: ${title}`, { ...opts, description: opts.description })
      else if (warn) toast.warning(title, opts)
      else toast.success(title, opts)
    },
    onError: (err, { undo }) => {
      void refresh()
      const msg = err instanceof ApiError ? err.message : 'Nicht geändert'
      toast.error(undo ? 'Rückgängig ging nicht' : 'Nicht geändert', { id: `public-${p.id}`, description: msg, duration: UNDO_MS })
    },
  })

  // Fortschritt live, solange der Aufruf läuft (der Server führt ihn im Speicher)
  const progress = useQuery({
    queryKey: ['public-progress', p.id],
    queryFn: () => api.publicProgress(p.id).then((x) => x.progress),
    enabled: m.isPending,
    refetchInterval: m.isPending ? 500 : false,
    gcTime: 0,
  })

  return {
    run: (action: PublicAction) => m.mutate({ action }),
    pending: m.isPending,
    current: m.isPending ? m.variables?.action ?? null : null,
    error: m.error instanceof ApiError ? m.error : m.error ? new ApiError('unknown', 'Nicht geändert', 0) : null,
    progress: m.isPending ? progress.data ?? null : null,
    reset: m.reset,
  }
}

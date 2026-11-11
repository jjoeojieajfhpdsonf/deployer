import { useQuery } from '@tanstack/react-query'
import { api } from '../api.js'
import { IconKey as IconKeyBase } from './Icons.js'

/**
 * Wer etwas ausgelöst hat – gleich in Deployments und Aktivität:
 *  - «ui:…»    → Kreis mit dem Anfangsbuchstaben, «du»
 *  - «mcp:…»   → Claude-Symbol und Token-Name (über den MCP-Server)
 *  - «token:…» → Schlüssel und Token-Name (REST-API, Skripte)
 *  - «system…» → «automatisch»
 * Das Wort steht immer dabei; das Symbol ist nur Zugabe.
 */
export type ActorKind = 'you' | 'claude' | 'token' | 'system' | 'unknown'

export function actorKind(actor: string | null | undefined): ActorKind {
  if (!actor) return 'unknown'
  if (actor.startsWith('ui:')) return 'you'
  if (actor.startsWith('mcp:')) return 'claude'
  if (actor.startsWith('token:')) return 'token'
  if (actor === 'system' || actor.startsWith('system:')) return 'system'
  return 'unknown'
}

/** Wort für den Auslöser, z. B. für Titel und Screenreader */
export function actorText(actor: string | null | undefined): string {
  const k = actorKind(actor)
  if (k === 'you') return 'du'
  if (k === 'claude') return `Claude (${actor!.slice(4)})`
  if (k === 'token') return actor!.slice(6)
  if (k === 'system') return 'automatisch'
  return actor && !actor.startsWith('ip:') ? actor : 'unbekannt'
}

const svg = { width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': true } as const

/** Vierstrahliger Funke als Zeichen für Claude (kein Nachbau eines Logos) */
export const IconSpark = () => (
  <svg {...svg} fill="currentColor"><path d="M8 1.2c.4 3.3 1.5 4.4 4.8 4.8v.1C9.5 6.5 8.4 7.6 8 10.9h-.1C7.6 7.6 6.5 6.5 3.2 6.1V6C6.5 5.6 7.6 4.5 7.9 1.2Z" transform="translate(0 2)" /></svg>
)
// Schlüssel aus Icons.tsx (ein Bart, Antwort 4), hier 12 px
const IconKey = () => <IconKeyBase size={12} />
const IconAuto = () => (
  <svg {...svg} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.6" /><path d="M13 2.5v2.8h-2.8" /></svg>
)

export function Actor({ actor }: { actor: string | null | undefined }) {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false, staleTime: Infinity })
  const k = actorKind(actor)
  const initial = (me.data?.name ?? 'Du').trim().charAt(0).toUpperCase() || 'D'
  return (
    <span className={`actor actor-${k}`}>
      {k === 'you' && <span className="actor-mark actor-avatar" aria-hidden="true">{initial}</span>}
      {k === 'claude' && <span className="actor-mark actor-spark"><IconSpark /></span>}
      {k === 'token' && <span className="actor-mark"><IconKey /></span>}
      {k === 'system' && <span className="actor-mark"><IconAuto /></span>}
      <span className="actor-name">{actorText(actor)}</span>
    </span>
  )
}

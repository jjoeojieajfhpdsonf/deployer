import { publicStateOf, type ProjectDto } from '@airlock/shared'
import { usePublicActions } from '../lib/public.js'
import { isPublic } from '../lib/projects.js'
import { IconWarn } from './Icons.js'

/**
 * Einträge, die das «…»-Menü der Projektkarte und das «⋯»-Menü im
 * Projektkopf teilen (beide über RowMenu, also gleiche Animation und
 * Bedienung). Rückfragen stehen direkt im Menü (menu-confirm); welche gerade
 * offen ist, hält der Aufrufer, damit nie zwei gleichzeitig offen sind.
 */

export type MenuConfirm = null | 'stop' | 'offline' | 'restart'

/** «Offline nehmen …» bzw. «Ganz offline nehmen …», mit Wahl Pausieren / ganz offline. */
export function OfflineMenuItems({ p, close, confirm, setConfirm }: {
  p: ProjectDto; close: () => void; confirm: MenuConfirm; setConfirm: (c: MenuConfirm) => void
}) {
  const pub = usePublicActions(p)
  const state = publicStateOf(p.routes)
  if (state === 'private') return null
  const host = p.routes.find((r) => r.target === 'public')?.hostname
  const internal = p.routes.find((r) => r.target !== 'public')?.urls[0]?.replace(/^https?:\/\//, '')
  if (confirm !== 'offline') {
    return <button role="menuitem" disabled={pub.pending} onClick={() => setConfirm('offline')}>{state === 'live' ? 'Offline nehmen …' : 'Ganz offline nehmen …'}</button>
  }
  return (
    <>
      <div className="menu-confirm">
        <IconWarn />
        <span>
          {state === 'live' ? <>Pausieren: Wartungsseite unter {host}. Ganz offline: der Name wird frei.</> : <>Der Name {host} wird frei.</>}
          {internal ? <> Intern weiter: {internal}</> : null}
        </span>
      </div>
      {state === 'live' && (
        <button role="menuitem" className="menu-danger-solid" disabled={pub.pending} onClick={() => { close(); setConfirm(null); pub.run({ op: 'pause' }) }}>Ja, pausieren</button>
      )}
      <button role="menuitem" className={state === 'live' ? 'menu-danger' : 'menu-danger-solid'} disabled={pub.pending} onClick={() => { close(); setConfirm(null); pub.run({ op: 'unpublish' }) }}>Ja, ganz offline nehmen</button>
      <button role="menuitem" onClick={() => setConfirm(null)}>Abbrechen</button>
    </>
  )
}

/** «Stoppen …» mit Rückfrage bzw. «Starten», wenn das Projekt gestoppt ist. */
export function StopStartMenuItems({ p, close, busy, confirm, setConfirm, onStop, onStart }: {
  p: ProjectDto; close: () => void; busy: boolean; confirm: MenuConfirm; setConfirm: (c: MenuConfirm) => void
  onStop: () => void; onStart: () => void
}) {
  if (p.desiredState !== 'running') {
    return <button role="menuitem" disabled={busy} onClick={() => { close(); onStart() }}>Starten</button>
  }
  if (confirm !== 'stop') {
    return <button role="menuitem" disabled={busy} onClick={() => setConfirm('stop')}>Stoppen …</button>
  }
  return (
    <>
      <div className="menu-confirm"><IconWarn /> {isPublic(p) ? 'Öffentlich erreichbar – ' : ''}die Seite ist danach offline.</div>
      <button role="menuitem" className="menu-danger-solid" disabled={busy} onClick={() => { close(); setConfirm(null); onStop() }}>Ja, stoppen</button>
      <button role="menuitem" onClick={() => setConfirm(null)}>Abbrechen</button>
    </>
  )
}

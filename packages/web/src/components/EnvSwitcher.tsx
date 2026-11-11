import { useId } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useMenu } from './useMenu.js'
import { useEnv, samePageIn } from '../lib/env.js'
import type { EnvironmentDto } from '../api.js'

/**
 * M9: Umschalter der Umgebung, oben links neben «Airlock». In der schmalen
 * Seitenleiste nur das Kürzel; Name und Domain stehen in der Liste und im
 * Pfad oben (erste Brotkrume). Kritische Befunde als Zahl mit Wort.
 */
export function EnvSwitcher() {
  const { env, envs } = useEnv()
  const { open, toggle, close, rootRef, triggerRef, listProps } = useMenu()
  const id = useId()
  const navigate = useNavigate()
  const location = useLocation()
  if (!env) return null

  const pick = (e: EnvironmentDto) => {
    close()
    if (e.id !== env.id) navigate(samePageIn(location.pathname, e.slug))
  }

  return (
    <div className="menu env-switch" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="env-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        // Sichtbares Kürzel vorne im Namen (WCAG 2.5.3 Label in Name, wie bei «Vorgänge»)
        aria-label={`${env.short}: Umgebung ${env.name}${env.zone && env.zone !== env.name ? ` (${env.zone})` : ''} – wechseln`}
        title={`Umgebung: ${env.name}`}
        onClick={toggle}
      >
        <span className="env-mark" aria-hidden="true">{env.short}</span>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" /></svg>
      </button>
      <div {...listProps} role="menu" id={id} aria-label="Umgebungen">
        <div className="menu-group-label" aria-hidden="true">Umgebungen</div>
        {envs.map((e) => (
          <button key={e.id} type="button" role="menuitemradio" aria-checked={e.id === env.id} className="env-item" onClick={() => pick(e)}>
            <span className="env-mark" aria-hidden="true">{e.short}</span>
            <span className="env-item-text">
              <strong>{e.name}{e.isDefault ? <span className="visually-hidden"> (Standard)</span> : null}</strong>
              <span>
                {e.zone && e.zone !== e.name ? `${e.zone} · ` : e.zone ? '' : 'noch ohne Domain · '}
                {e.projects === 1 ? '1 Projekt' : `${e.projects} Projekte`}
                {e.critical > 0 && <> · <span className="count-critical">{e.critical} kritisch</span></>}
              </span>
            </span>
            {e.id === env.id && (
              <svg className="menu-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
            )}
          </button>
        ))}
        <div className="menu-sep" />
        <Link role="menuitem" to="/umgebungen/neu" onClick={close}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
          Umgebung anlegen …
        </Link>
        <Link role="menuitem" to="/umgebungen" onClick={close}>Umgebungen verwalten</Link>
      </div>
    </div>
  )
}

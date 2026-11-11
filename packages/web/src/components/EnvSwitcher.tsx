import { useId } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useMenu } from './useMenu.js'
import { useEnv, samePageIn } from '../lib/env.js'
import type { EnvironmentDto } from '../api.js'

/**
 * M9: Umschalter der Umgebung, links in der Kopfzeile vor den Brotkrumen
 * (gleiche Höhe wie der Profil-Knopf). Zeigt Kürzel, Name und – wenn sie sich
 * vom Namen unterscheidet – die Domain; zu lange Namen enden mit «…», der
 * volle Name steht im Tooltip und im Namen des Knopfs. Unter 860 px nur
 * Kürzel und Pfeil. Kritische Befunde in der Liste als Zahl mit Wort.
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
  // Domain nur, wenn sie etwas hinzufügt (Name «jherren.com» = Zone «jherren.com»: einmal)
  const domain = env.zone && env.zone !== env.name ? env.zone : null
  // WCAG 2.5.3 (Label in Name): der sichtbare Text in seiner Reihenfolge – Kürzel, Name, Domain – steht
  // im Namen, ohne Klammern (axe lässt Geklammertes weg und zählt das sichtbare Kürzel trotz aria-hidden)
  const label = `Umgebung: ${env.short} ${env.name}${domain ? `, ${domain}` : ''} – wechseln`

  return (
    <div className="menu env-switch" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="env-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        title={label}
        onClick={toggle}
      >
        <span className="env-mark" aria-hidden="true">{env.short}</span>
        {/* Leerzeichen trennt Kürzel und Name im sichtbaren Text (axe fügt die Teile sonst zusammen) */}
        {' '}
        <span className="env-trigger-text">
          <span className="env-trigger-name">{env.name}</span>
          {domain && <>{' '}<span className="env-trigger-zone">{domain}</span></>}
        </span>
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

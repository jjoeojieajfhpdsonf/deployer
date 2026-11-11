import { useId, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { themePrefs, type ThemePref } from '@airlock/shared'
import { api, type MeDto } from '../api.js'
import { applyTheme, readLocalTheme, THEME_LABEL } from '../lib/theme.js'
import { useMenu } from './useMenu.js'
import { confirmLeave } from '../lib/unsaved.js'
import { markLoggedOut } from '../lib/session.js'

/**
 * Profil-Menü oben rechts: Initiale als Avatar, Pfeil nach unten. Einträge
 * Konto, Passwort ändern, Abmelden. Schliesst bei Klick ausserhalb, Escape
 * und nach einer Auswahl; Pfeiltasten wandern durch die Einträge.
 */
export function ProfileMenu({ me }: { me: MeDto }) {
  const { open, toggle, close, rootRef, triggerRef, listProps } = useMenu()
  const id = useId()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const name = me.name ?? 'Admin'
  const initial = (name.trim()[0] ?? 'A').toLocaleUpperCase('de-CH')

  // Darstellung: sofort anwenden, dann auf dem Server speichern (gilt auf jedem Gerät)
  const [theme, setTheme] = useState<ThemePref>(() => me.theme ?? readLocalTheme())
  async function pickTheme(t: ThemePref) {
    setTheme(t)
    applyTheme(t)
    try {
      await api.setPreferences({ theme: t })
      qc.setQueryData<MeDto>(['me'], (old) => (old ? { ...old, theme: t } : old))
    } catch {
      /* lokal gilt die Wahl trotzdem; beim nächsten Laden gewinnt der Server */
    }
  }

  async function logout() {
    close()
    // Ungespeichertes geht beim Abmelden verloren: vorher fragen (UI-Qualität 8)
    if (!(await confirmLeave())) return
    // Bewusst abgemeldet: danach die Anmeldeseite, nicht der Dialog «Sitzung abgelaufen»
    markLoggedOut()
    try {
      await api.logout()
    } finally {
      navigate('/projekte')
      await qc.invalidateQueries({ queryKey: ['me'] })
    }
  }

  return (
    <div className="menu profile" ref={rootRef}>
      <button
        ref={triggerRef}
        className="profile-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`Profil-Menü (${name})`}
        onClick={toggle}
      >
        <span className="avatar" aria-hidden="true">{initial}</span>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {/* Bleibt gemountet, damit auch das Schliessen animiert (useMenu) */}
      <div {...listProps} role="menu" id={id} aria-label="Profil">
        <div className="menu-head">
          <strong>{name}</strong>
          <span>Administrator</span>
        </div>
        <div className="menu-sep" />
        <Link role="menuitem" to="/konto" onClick={close}>Konto</Link>
        <Link role="menuitem" to="/konto#passwort" onClick={close}>Passwort ändern</Link>
        <div className="menu-sep" />
        <div role="group" aria-label="Darstellung">
          <div className="menu-group-label" aria-hidden="true">Darstellung</div>
          {themePrefs.map((t) => (
            <button key={t} role="menuitemradio" aria-checked={theme === t} onClick={() => void pickTheme(t)}>
              {THEME_LABEL[t]}
              {theme === t && (
                <svg className="menu-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
              )}
            </button>
          ))}
        </div>
        <div className="menu-sep" />
        <button role="menuitem" onClick={() => void logout()}>Abmelden</button>
      </div>
    </div>
  )
}

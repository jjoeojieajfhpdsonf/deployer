import { useId } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { themePrefs, themeUnlocked } from '@airlock/shared'
import { api, type MeDto } from '../api.js'
import { readLocalTheme, THEME_LABEL } from '../lib/theme.js'
import { useMenu } from './useMenu.js'
import { confirmLeave } from '../lib/unsaved.js'
import { markLoggedOut } from '../lib/session.js'
import { funPrefsOf, useChooseTheme, useFunPrefs } from '../lib/fun.js'

const Check = () => (
  <svg className="menu-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
)

/**
 * Profil-Menü oben rechts: Initiale als Avatar, Pfeil nach unten. Einträge
 * Konto, Passwort ändern, Abmelden. Schliesst bei Klick ausserhalb, Escape
 * und nach einer Auswahl; Pfeiltasten wandern durch die Einträge.
 *
 * Etappe 7: unter «Darstellung» auch die Spass-Funktionen (an/aus), der
 * Matrix-Regen ausserhalb des Terminal-Themes und Disketti (nur sichtbar, wenn
 * Windows 95 freigeschaltet ist) – als Häkchen-Einträge.
 */
export function ProfileMenu({ me }: { me: MeDto }) {
  const { open, toggle, close, rootRef, triggerRef, listProps } = useMenu()
  const id = useId()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const name = me.name ?? 'Admin'
  const initial = (name.trim()[0] ?? 'A').toLocaleUpperCase('de-CH')

  // Darstellung: aus dem Profil (Befehlspalette kann sie auch ändern), sonst die lokale Kopie
  const theme = me.theme ?? readLocalTheme()
  const chooseTheme = useChooseTheme()
  const fun = funPrefsOf(me)
  const { set: setFun } = useFunPrefs()

  async function logout() {
    close()
    // Ungespeichertes geht beim Abmelden verloren: vorher fragen (UI-Qualität 8)
    if (!(await confirmLeave())) return
    // Bewusst abgemeldet: danach die Anmeldeseite, nicht der Dialog «Sitzung abgelaufen»
    markLoggedOut()
    try {
      await api.logout()
    } finally {
      navigate('/')
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
          {/* «Windows 95» und «Terminal» erst nach der Freischaltung (Easter Eggs) */}
          {themePrefs.filter((t) => themeUnlocked(t, me.unlocks) || theme === t).map((t) => (
            <button key={t} role="menuitemradio" aria-checked={theme === t} onClick={() => void chooseTheme(t)}>
              {THEME_LABEL[t]}
              {theme === t && <Check />}
            </button>
          ))}
        </div>
        <div className="menu-sep" />
        {/* Etappe 7: Spass-Funktionen – Matrix-Regen, Disketti, Konfetti, Achievements, Snake auf der 404-Seite */}
        <div role="group" aria-label="Spass">
          <button role="menuitemcheckbox" aria-checked={fun.fun} onClick={() => void setFun({ fun: !fun.fun })}>
            Spass-Funktionen
            {fun.fun && <Check />}
          </button>
          {/* Im Terminal-Theme läuft er ohnehin; der Schalter gilt für die übrigen Themes */}
          {fun.fun && (
            <button role="menuitemcheckbox" aria-checked={fun.matrix} onClick={() => void setFun({ matrix: !fun.matrix })}>
              Matrix-Regen bei Deploys
              {fun.matrix && <Check />}
            </button>
          )}
          {fun.fun && themeUnlocked('win95', me.unlocks) && (
            <button role="menuitemcheckbox" aria-checked={fun.disketti} onClick={() => void setFun({ disketti: !fun.disketti })}>
              Disketti (Windows 95)
              {fun.disketti && <Check />}
            </button>
          )}
        </div>
        <div className="menu-sep" />
        <button role="menuitem" onClick={() => void logout()}>Abmelden</button>
      </div>
    </div>
  )
}

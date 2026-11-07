import { useEffect, useId, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { api, type MeDto } from '../api.js'

/**
 * Profil-Menü oben rechts: Initiale als Avatar, Pfeil nach unten. Einträge
 * Konto, Passwort ändern, Abmelden. Schliesst bei Klick ausserhalb, Escape
 * und nach einer Auswahl; Pfeiltasten wandern durch die Einträge.
 */
export function ProfileMenu({ me }: { me: MeDto }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const name = me.name ?? 'Admin'
  const initial = (name.trim()[0] ?? 'A').toLocaleUpperCase('de-CH')

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        ref.current?.querySelector<HTMLButtonElement>('.profile-trigger')?.focus()
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
        const i = items.indexOf(document.activeElement as HTMLElement)
        const next = e.key === 'ArrowDown' ? items[(i + 1) % items.length] : items[(i - 1 + items.length) % items.length]
        next?.focus()
        e.preventDefault()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function logout() {
    setOpen(false)
    await api.logout()
    navigate('/projekte')
    await qc.invalidateQueries({ queryKey: ['me'] })
  }

  return (
    <div className="menu profile" ref={ref}>
      <button
        className="profile-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`Profil-Menü (${name})`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="avatar" aria-hidden="true">{initial}</span>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="menu-list" role="menu" id={id}>
          <div className="menu-head">
            <strong>{name}</strong>
            <span>Administrator</span>
          </div>
          <div className="menu-sep" />
          <Link role="menuitem" to="/konto" onClick={() => setOpen(false)}>Konto</Link>
          <Link role="menuitem" to="/konto#passwort" onClick={() => setOpen(false)}>Passwort ändern</Link>
          <div className="menu-sep" />
          <button role="menuitem" onClick={() => void logout()}>Abmelden</button>
        </div>
      )}
    </div>
  )
}

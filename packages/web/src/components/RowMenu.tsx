import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { IconMore } from './Icons.js'

/**
 * Menü hinter «…» in einer Tabellenzeile. Schliesst bei Klick ausserhalb,
 * Escape und nach einer Auswahl. Tastatur: Enter/Leertaste öffnet, Pfeile
 * wandern durch die Einträge.
 */
export function RowMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<CSSProperties>({})
  const ref = useRef<HTMLDivElement>(null)
  const listId = useId()

  // Fest positioniert statt absolut: die Tabelle scrollt (overflow:auto) und
  // schnitt das Menü der letzten Zeilen sonst ab (Critique). Unten wenig
  // Platz -> nach oben öffnen.
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = ref.current?.querySelector('button[aria-haspopup]')?.getBoundingClientRect()
      if (!r) return
      const below = window.innerHeight - r.bottom
      setPos(below < 260
        ? { position: 'fixed', bottom: window.innerHeight - r.top + 6, right: window.innerWidth - r.right, top: 'auto' }
        : { position: 'fixed', top: r.bottom + 6, right: window.innerWidth - r.right })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        ref.current?.querySelector<HTMLButtonElement>('button[aria-haspopup]')?.focus()
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])]
        const i = items.indexOf(document.activeElement as HTMLElement)
        const next = e.key === 'ArrowDown' ? items[(i + 1) % items.length] : items[(i - 1 + items.length) % items.length]
        next?.focus()
        e.preventDefault()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    // Erster Eintrag bekommt den Fokus
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="menu" ref={ref}>
      <button
        className="button-icon"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <IconMore />
      </button>
      {open && (
        <div className="menu-list" role="menu" id={listId} style={pos}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

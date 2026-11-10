import { useCallback, useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react'
import { IconMore } from './Icons.js'
import { useMenu } from './useMenu.js'

/**
 * Menü hinter «…» in einer Tabellenzeile. Schliesst bei Klick ausserhalb,
 * Escape und nach einer Auswahl (alle über `close`, siehe useMenu).
 * Tastatur: Enter/Leertaste öffnet, Pfeile wandern durch die Einträge.
 */
export function RowMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [pos, setPos] = useState<{ style: CSSProperties; side: 'top' | 'bottom' }>({ style: {}, side: 'bottom' })
  const listId = useId()

  // Fest positioniert statt absolut: die Tabelle scrollt (overflow:auto) und
  // schnitt das Menü der letzten Zeilen sonst ab (Critique). Unten wenig
  // Platz -> nach oben öffnen; die Seite bestimmt Ursprung und Versatz der
  // Animation. Gemessen wird schon beim Öffnen, damit das erste Bild stimmt.
  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    const below = window.innerHeight - r.bottom
    setPos(below < 260
      ? { side: 'top', style: { position: 'fixed', bottom: window.innerHeight - r.top + 6, right: window.innerWidth - r.right, top: 'auto' } }
      : { side: 'bottom', style: { position: 'fixed', top: r.bottom + 6, right: window.innerWidth - r.right } })
    // triggerRef kommt aus useMenu (stabil); aufgerufen wird erst beim Klick
  }, [])
  const { open, shown, toggle, triggerRef, rootRef, listProps, close } = useMenu({ onOpen: place })

  // Solange sichtbar (auch beim Ausblenden) mit der Seite mitwandern
  useEffect(() => {
    if (!shown) return
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [shown, place])

  return (
    <div className="menu" ref={rootRef}>
      <button
        ref={triggerRef}
        className="button-icon"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={toggle}
      >
        <IconMore />
      </button>
      {/* Bleibt gemountet, damit auch das Schliessen animiert (useMenu) */}
      <div {...listProps} role="menu" id={listId} aria-label={label} data-side={pos.side} style={pos.style}>
        {children(close)}
      </div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'

/** Einträge, durch die die Pfeiltasten wandern (gesperrte überspringen). */
const ITEMS = '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])'

/**
 * Gemeinsames Verhalten der Menüs (Profil, «…» der Projektkarten).
 *
 * Die Liste bleibt gemountet; CSS blendet sie ein und aus (styles.css,
 * «Menüs»): `data-open` öffnet, beim Schliessen läuft die Transition und
 * `display` springt dank `transition-behavior: allow-discrete` erst danach
 * auf `none`. Zusätzlich hält die Klasse `closing` die Liste sichtbar, bis
 * `transitionend` kommt – Rückfall für Browser ohne allow-discrete und
 * Haken für die Projektkarte (bleibt über den Nachbarn, solange das Menü
 * ausblendet).
 *
 * Esc, Klick daneben und Auswahl eines Eintrags laufen alle über `close()`:
 * gleiche Animation, Fokus zurück auf den Auslöser. Öffnen während des
 * Schliessens kehrt die laufende Transition einfach um (kein Neustart,
 * kein Flackern).
 */
export function useMenu({ onOpen }: { onOpen?: () => void } = {}) {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const openRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen

  const close = useCallback(() => {
    if (!openRef.current) return
    openRef.current = false
    // Fokus zurück, wenn er im Menü lag (oder nirgends). Hat der Klick daneben
    // ein anderes Feld getroffen, übernimmt danach der Browser den Fokus.
    const active = document.activeElement
    if (!active || active === document.body || rootRef.current?.contains(active)) {
      triggerRef.current?.focus({ preventScroll: true })
    }
    setOpen(false)
    setClosing(true)
  }, [])

  const show = useCallback(() => {
    if (openRef.current) return
    openRef.current = true
    onOpenRef.current?.()
    setClosing(false)
    setOpen(true)
  }, [])

  const toggle = useCallback(() => (openRef.current ? close() : show()), [close, show])

  // Offen: Klick daneben, Esc, Pfeiltasten; erster Eintrag bekommt den Fokus
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = [...(listRef.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])]
        if (!items.length) return
        const i = items.indexOf(document.activeElement as HTMLElement)
        const next = e.key === 'ArrowDown' ? items[(i + 1) % items.length] : items[(i - 1 + items.length) % items.length]
        next?.focus()
        e.preventDefault()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    listRef.current?.querySelector<HTMLElement>(ITEMS)?.focus({ preventScroll: true })
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  // Schliessend: `closing` fällt weg, sobald die Deckkraft-Transition der
  // Liste fertig ist; die Zeitsperre greift, falls gar keine Transition läuft.
  useEffect(() => {
    if (!closing) return
    const list = listRef.current
    const done = () => setClosing(false)
    const onEnd = (e: TransitionEvent) => {
      if (e.target === list && e.propertyName === 'opacity') done()
    }
    list?.addEventListener('transitionend', onEnd)
    list?.addEventListener('transitioncancel', onEnd)
    const timer = window.setTimeout(done, 250)
    return () => {
      list?.removeEventListener('transitionend', onEnd)
      list?.removeEventListener('transitioncancel', onEnd)
      window.clearTimeout(timer)
    }
  }, [closing])

  return {
    open,
    /** Offen oder gerade am Ausblenden (für Positionierung, z-index) */
    shown: open || closing,
    toggle,
    close,
    rootRef,
    triggerRef,
    listRef,
    /** Auf die `.menu-list` legen */
    listProps: {
      ref: listRef,
      'data-open': open ? '' : undefined,
      className: closing ? 'menu-list closing' : 'menu-list',
    },
  }
}

import { useEffect, useRef, type ReactNode } from 'react'

/**
 * Modaler Dialog nach dem Muster von LeaveGuard/Shortcuts: natives
 * <dialog> mit showModal (Fokus bleibt drin, Esc schliesst), beim Schliessen
 * geht der Fokus dorthin zurück, wo er vorher war. `initialFocus` ist ein
 * CSS-Selektor im Dialog (sonst das erste Feld bzw. der erste Knopf).
 * `busy` verhindert das Schliessen, solange etwas läuft.
 */
export function Modal({ open, onClose, labelledBy, describedBy, initialFocus, busy, wide, full, children }: {
  open: boolean
  onClose: () => void
  labelledBy: string
  describedBy?: string
  initialFocus?: string
  busy?: boolean
  wide?: boolean
  /** Fast das ganze Fenster (Aufbau vergrössert) */
  full?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const back = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      back.current = document.activeElement as HTMLElement | null
      d.showModal()
      requestAnimationFrame(() => {
        const el = (initialFocus ? d.querySelector<HTMLElement>(initialFocus) : null) ?? d.querySelector<HTMLElement>('input, select, textarea, button')
        el?.focus()
      })
    }
    if (!open && d.open) {
      d.close()
      back.current?.focus?.()
      back.current = null
    }
  }, [open, initialFocus])
  return (
    <dialog
      ref={ref}
      className={full ? 'dialog dialog-full' : wide ? 'dialog dialog-wide' : 'dialog'}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onClose()
      }}
      onClose={() => { if (open) onClose() }}
    >
      {open ? <div className="dialog-body">{children}</div> : null}
    </dialog>
  )
}

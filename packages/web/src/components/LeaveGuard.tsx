import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { confirmLeave, hasUnsaved, usePendingLeave } from '../lib/unsaved.js'

/**
 * UI-Qualität 8: Rückfrage beim Verlassen mit ungespeicherten Änderungen
 * (lib/unsaved.ts). In der Shell eingebunden: fängt Klicks auf Links der
 * Oberfläche ab und zeigt die Rückfrage; Neu laden und Schliessen fragt der
 * Browser selbst (beforeunload).
 */
export function LeaveGuard() {
  const navigate = useNavigate()
  const ask = usePendingLeave()
  const ref = useRef<HTMLDialogElement>(null)
  const stay = useRef<HTMLButtonElement>(null)
  const back = useRef<HTMLElement | null>(null)

  // Neu laden, Tab schliessen, fremde Adresse
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!hasUnsaved()) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  // Links in der Oberfläche (react-router <Link> sind <a href>): vor dem Wechsel fragen
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!hasUnsaved() || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return
      const url = new URL(a.href, location.href)
      if (url.origin !== location.origin) return
      // Sprung auf derselben Seite (#abschnitt) verlässt nichts
      if (url.pathname === location.pathname && url.search === location.search) return
      e.preventDefault()
      e.stopPropagation()
      back.current = a
      void confirmLeave().then((ok) => { if (ok) navigate(`${url.pathname}${url.search}${url.hash}`) })
    }
    // Capture: vor dem Klick-Handler von <Link>
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [navigate])

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (ask && !d.open) {
      if (!back.current) back.current = document.activeElement as HTMLElement | null
      d.showModal()
      // Sichere Wahl zuerst: Bleiben
      requestAnimationFrame(() => stay.current?.focus())
    }
    if (!ask && d.open) {
      d.close()
      back.current?.focus?.()
      back.current = null
    }
  }, [ask])

  const what = ask?.what.join(', ') ?? ''
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="leave-h" aria-describedby="leave-d" onCancel={(e) => { e.preventDefault(); ask?.resolve(false) }}>
      <div className="dialog-body">
        <h2 id="leave-h">Änderungen verwerfen?</h2>
        <p id="leave-d" className="dialog-lede">Ungespeichert: {what}. Wer jetzt weitergeht, verliert diese Eingaben.</p>
        <div className="dialog-actions">
          <button type="button" ref={stay} className="button-primary" onClick={() => ask?.resolve(false)}>Bleiben und speichern</button>
          <button type="button" className="button-danger" onClick={() => ask?.resolve(true)}>Verwerfen und weiter</button>
        </div>
      </div>
    </dialog>
  )
}

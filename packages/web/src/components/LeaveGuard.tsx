import { useEffect, useRef } from 'react'
import { useBlocker } from 'react-router-dom'
import { confirmLeave, hasUnsaved, shouldAskBeforeLeaving, usePendingLeave } from '../lib/unsaved.js'

/**
 * UI-Qualität 8: Rückfrage beim Verlassen mit ungespeicherten Änderungen
 * (lib/unsaved.ts). In der Shell eingebunden: hält jeden Wechsel im Router
 * an (Links, Zurück/Vor im Browser, Umgebungswechsel) und zeigt die
 * Rückfrage; Neu laden und Schliessen fragt der Browser selbst (beforeunload).
 */
export function LeaveGuard() {
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

  // Jeder Wechsel im Router (Link, Zurück/Vor, navigate()): der Blocker hält ihn an, die
  // Rückfrage entscheidet. Dieselbe Rückfrage wie confirmLeave(): «Verwerfen und weiter» leert die
  // Liste und lässt den Wechsel weiterlaufen; Zurück/Vor stellt der Router bis dahin zurück.
  const blocker = useBlocker(shouldAskBeforeLeaving)
  // Ein angehaltener Wechsel → genau eine Rückfrage (auch wenn der Effekt erneut läuft)
  const asking = useRef(false)
  useEffect(() => {
    if (blocker.state !== 'blocked' || asking.current) return
    const held = blocker
    asking.current = true
    void confirmLeave().then((ok) => {
      asking.current = false
      if (ok) held.proceed()
      else held.reset()
    })
  }, [blocker])

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

  const edits = ask?.edits ?? []
  const once = ask?.once ?? []
  const onlyOnce = edits.length === 0 && once.length > 0
  const list = (xs: string[]) => xs.join(', ')
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="leave-h"
      aria-describedby="leave-d"
      onCancel={(e) => { e.preventDefault(); ask?.resolve(false) }}
      // Schliesst der Browser den Dialog trotzdem (zweites Esc ohne Nutzeraktion), heisst das «Bleiben».
      // Das close-Ereignis kommt verzögert: ist der Dialog schon wieder offen (nächste Rückfrage, z.B.
      // zweimal schnell Zurück), gehört es zur vorigen Runde und beantwortet die neue nicht.
      onClose={(e) => { if (!e.currentTarget.open) ask?.resolve(false) }}
    >
      <div className="dialog-body">
        <h2 id="leave-h">{onlyOnce ? 'Weiter ohne zu kopieren?' : 'Änderungen verwerfen?'}</h2>
        <p id="leave-d" className="dialog-lede">
          {edits.length > 0 && <>Ungespeichert: {list(edits)}. Wer jetzt weitergeht, verliert diese Eingaben.</>}
          {edits.length > 0 && once.length > 0 && ' '}
          {once.length > 0 && <>{list(once)} ist noch nicht kopiert und wird nicht noch einmal angezeigt.</>}
        </p>
        <div className="dialog-actions">
          <button type="button" ref={stay} className="button-primary" onClick={() => ask?.resolve(false)}>
            {edits.length > 0 ? 'Weiter bearbeiten' : 'Bleiben'}
          </button>
          <button type="button" className="button-danger" onClick={() => ask?.resolve(true)}>
            {onlyOnce ? 'Trotzdem weiter' : 'Verwerfen und weiter'}
          </button>
        </div>
      </div>
    </dialog>
  )
}

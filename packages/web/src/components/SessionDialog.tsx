import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { LoginForm } from '../pages/Login.js'
import { isSessionExpired, markSessionOk, useFailedActions, useSessionExpired } from '../lib/session.js'

/**
 * UI-Qualität 8: Sitzung abgelaufen (401 oder Abmeldung in einem anderen Tab)
 * → Anmeldedialog über der Seite. Die Seite bleibt gemountet, Eingaben in
 * Formularen bleiben. Danach lädt alles Sichtbare neu, der Fokus geht dorthin
 * zurück, wo er war. Der Dialog lässt sich nicht wegklicken – ohne Anmeldung
 * geht nichts. Was am Ablauf gescheitert ist, steht im Dialog.
 */
export function SessionDialog() {
  const expired = useSessionExpired()
  const failed = useFailedActions()
  const qc = useQueryClient()
  const ref = useRef<HTMLDialogElement>(null)
  const back = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (expired && !d.open) {
      back.current = document.activeElement as HTMLElement | null
      d.showModal()
    }
    if (!expired && d.open) d.close()
  }, [expired])

  const done = () => {
    markSessionOk()
    void qc.invalidateQueries()
    requestAnimationFrame(() => back.current?.focus?.())
  }

  return (
    <dialog
      ref={ref}
      className="dialog session-dialog"
      aria-labelledby="session-dialog-h"
      // Esc schliesst nicht: ohne Anmeldung funktioniert die Seite nicht
      onCancel={(e) => e.preventDefault()}
      onKeyDown={(e) => { if (e.key === 'Escape') e.preventDefault() }}
      // Schliesst der Browser ihn trotzdem (zweites Esc ohne Nutzeraktion), sofort wieder öffnen
      onClose={() => { if (isSessionExpired()) ref.current?.showModal() }}
    >
      <div className="dialog-body">
        {expired && <LoginForm inDialog headingId="session-dialog-h" failed={failed} onDone={done} />}
      </div>
    </dialog>
  )
}

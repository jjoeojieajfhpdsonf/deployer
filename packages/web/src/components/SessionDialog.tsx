import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { LoginForm } from '../pages/Login.js'
import { markSessionOk, useSessionExpired } from '../lib/session.js'

/**
 * UI-Qualität 8: Sitzung abgelaufen (401 oder Abmeldung in einem anderen Tab)
 * → Anmeldedialog über der Seite. Die Seite bleibt gemountet, Eingaben in
 * Formularen bleiben. Danach lädt alles Sichtbare neu, der Fokus geht dorthin
 * zurück, wo er war. Der Dialog lässt sich nicht wegklicken – ohne Anmeldung
 * geht nichts.
 */
export function SessionDialog() {
  const expired = useSessionExpired()
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
    >
      <div className="dialog-body">
        {expired && <LoginForm inDialog headingId="session-dialog-h" onDone={done} />}
      </div>
    </dialog>
  )
}

import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useConnection } from '../lib/connection.js'
import { IconWarn } from './Icons.js'

/** «vor 3 Min.» aus Millisekunden */
function ago(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'vor weniger als einer Minute'
  if (min < 60) return `vor ${min} Min.`
  const h = Math.floor(min / 60)
  return h === 1 ? 'vor 1 Std.' : `vor ${h} Std.`
}

/**
 * Zustand «Veraltet»: Der Server antwortet nicht mehr, die Seite zeigt die
 * letzten Daten. Leiste oben im Inhalt mit dem Alter der Daten und «Erneut
 * versuchen»; verschwindet von selbst, sobald eine Abfrage wieder gelingt.
 * Der Behälter mit role="status" bleibt immer im DOM, damit Screenreader den
 * Wechsel ansagen (eine Live-Region, die schon mit Inhalt erscheint, sagen
 * viele nicht an).
 */
export function StaleBar() {
  const c = useConnection()
  const qc = useQueryClient()
  const [, tick] = useState(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!c.offline) return
    const t = window.setInterval(() => tick((n) => n + 1), 30_000)
    return () => window.clearInterval(t)
  }, [c.offline])
  const age = c.lastOkAt ? ago(Date.now() - c.lastOkAt) : null
  const retry = async () => {
    if (busy) return
    setBusy(true)
    try { await qc.refetchQueries({ type: 'active' }) } finally { setBusy(false) }
  }
  return (
    <div role="status" className="stale-bar-region">
      {c.offline && (
        <div className="stale-bar">
          <span className="stale-bar-icon" aria-hidden="true"><IconWarn size={16} /></span>
          <p>
            <strong>Keine Verbindung zum Server.</strong>{' '}
            {age ? <>Angezeigt ist der Stand {age}. </> : null}Änderungen scheitern, bis der Server wieder antwortet.
          </p>
          <button type="button" className="button-small" onClick={() => void retry()} aria-disabled={busy || undefined}>
            Erneut versuchen
          </button>
        </div>
      )}
    </div>
  )
}

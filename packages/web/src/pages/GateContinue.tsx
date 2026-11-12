import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PageHead } from '../components/PageHead.js'

/**
 * Zugang «Airlock-Login»: Wer eine geschützte Projekt-Adresse ohne Anmeldung
 * öffnet, landet über /api/v1/gate/start hier. Ohne Anmeldung zeigt die App
 * zuerst die Anmeldung (Passwort, Passkey, zweiter Faktor); danach geht es
 * weiter zum Projekt. Nur der eigene Pfad /api/v1/gate/start ist erlaubt –
 * keine offene Weiterleitung.
 */
export const isGateContinue = (to: string | null): to is string => Boolean(to && /^\/api\/v1\/gate\/start\?[^\s]*$/.test(to))

export function GateContinue() {
  const [params] = useSearchParams()
  const to = params.get('weiter')
  const ok = isGateContinue(to)
  useEffect(() => {
    if (ok) window.location.replace(to)
  }, [ok, to])
  return (
    <section className="page page-narrow">
      <PageHead crumbs={[{ label: 'Anmeldung' }]} title="Weiter zum Projekt" />
      <p className="lede" role="status">
        {ok ? 'Angemeldet – du wirst zur Adresse des Projekts weitergeleitet …' : 'Hier gibt es nichts weiterzuleiten. Öffne die Adresse des Projekts noch einmal.'}
      </p>
    </section>
  )
}

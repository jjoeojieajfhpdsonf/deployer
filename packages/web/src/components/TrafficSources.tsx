import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api.js'
import { notifyOk } from '../lib/feedback.js'
import { fmtDate } from '../lib/dates.js'
import { ErrorState, Loading, SkCard } from './States.js'
import { DbipButton } from './VisitorsTab.js'

/**
 * «Besucher neu»: Server › Besucher. Optionale Quellen der Besucher-Auswertung
 * für alle Projekte: die freien Dateien von DB-IP (Städte, Provider/ASN; CC BY
 * 4.0, auf Knopfdruck geladen, danach monatlich aktualisiert) und Cloudflares
 * Kopfzeilen «Visitor Location» (Stadt ohne Datei). Koordinaten und PLZ
 * speichert Airlock in keinem Fall.
 */
export function TrafficSources() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['traffic-sources'], queryFn: api.trafficSources })
  const remove = useMutation({
    meta: { errorTitle: 'Datei nicht entfernt' },
    mutationFn: (kind: 'city' | 'asn') => (kind === 'city' ? api.removeCityDb() : api.removeAsnDb()),
    onSuccess: (_r, kind) => {
      notifyOk(kind === 'city' ? 'Städte-Datenbank entfernt' : 'Provider-Datenbank entfernt', { description: 'Gilt für neue Aufrufe; gezählte bleiben.' })
      void qc.invalidateQueries({ queryKey: ['traffic-sources'] })
      void qc.invalidateQueries({ queryKey: ['traffic'] })
    },
  })
  if (!q.data) {
    return q.isError
      ? <ErrorState what="Die Quellen der Besucher-Auswertung" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
      : <Loading label="Quellen werden geladen"><SkCard lines={3} /><SkCard lines={3} className="sk-gap-lg" /></Loading>
  }
  const s = q.data
  const file = (kind: 'city' | 'asn', info: { month: string | null; downloadedAt: string | null }) => (
    info.month ? (
      <>
        <p><span className="ts-state ts-state-ok">geladen</span> Stand {info.month}{info.downloadedAt && info.downloadedAt > '1971' ? ` · geholt am ${fmtDate(info.downloadedAt)}` : ''}. Wird monatlich aktualisiert.</p>
        <div className="form-actions">
          <button type="button" className="button" onClick={() => remove.mutate(kind)} disabled={remove.isPending}>Datei entfernen</button>
        </div>
      </>
    ) : (
      <>
        <p><span className="ts-state">nicht geladen</span> Airlock fragt erst nach diesem Klick bei DB-IP an.</p>
        <div className="form-actions"><DbipButton kind={kind} label={kind === 'city' ? 'Städte-Datenbank laden (rund 130 MB)' : 'Provider-Datenbank laden (rund 10 MB)'} /></div>
      </>
    )
  )
  return (
    <div className="ts-sources">
      <p className="lede lede-tight">
        Optionale Quellen für den Reiter «Besucher» aller Projekte. Ohne sie gibt es Länder (von Cloudflare), aber keine Städte und kein «Netz».
        Gespeichert werden in jedem Fall nur Zähler – keine IP, keine Koordinaten, keine Postleitzahl.
      </p>

      <section className="panel panel-pad ov-section" aria-labelledby="ts-cf">
        <h2 className="ov-title" id="ts-cf">Städte von Cloudflare</h2>
        <p>
          {s.cfLocation
            ? <><span className="ts-state ts-state-ok">aktiv</span> Cloudflare schickt Städte mit; Airlock nimmt sie statt der Datei von DB-IP.</>
            : <><span className="ts-state">nicht gesehen</span> Seit dem Start von Airlock kam keine Anfrage mit Stadt von Cloudflare.</>}
        </p>
        <p>So schaltest du es ein (gilt für die ganze Zone):</p>
        <ol className="ts-steps">
          <li>Im Cloudflare-Dashboard die Domain öffnen.</li>
          <li><strong>Rules › Settings</strong> (früher «Transform Rules») › Abschnitt <strong>Managed Transforms</strong>.</li>
          <li>Unter «HTTP request headers» <strong>Add visitor location headers</strong> einschalten.</li>
        </ol>
        <p className="hint">
          Cloudflare hängt dann <code>cf-ipcity</code>, <code>cf-region</code>, <code>cf-timezone</code> und weitere Kopfzeilen an. Airlock liest daraus nur die Stadt;{' '}
          <code>cf-iplatitude</code>, <code>cf-iplongitude</code> und <code>cf-postal-code</code> werden nie gespeichert. Die Kopfzeilen erreichen auch deine Projekte –
          wer sie dort nicht will, schaltet die Option wieder aus.
        </p>
      </section>

      <section className="panel panel-pad ov-section" aria-labelledby="ts-city">
        <h2 className="ov-title" id="ts-city">Städte-Datenbank</h2>
        <p className="muted">DB-IP «IP to City Lite», <a href="https://db-ip.com" target="_blank" rel="noreferrer">IP Geolocation by DB-IP</a>, Lizenz CC BY 4.0.</p>
        {file('city', s.city)}
      </section>

      <section className="panel panel-pad ov-section" aria-labelledby="ts-asn">
        <h2 className="ov-title" id="ts-asn">Provider-Datenbank</h2>
        <p className="muted">DB-IP «IP to ASN Lite», <a href="https://db-ip.com" target="_blank" rel="noreferrer">IP Geolocation by DB-IP</a>, Lizenz CC BY 4.0.</p>
        <p>Zeigt im Reiter «Besucher» die Netze (Swisscom, Init7 …) und erkennt Rechenzentren (AWS, Hetzner …): Aufrufe von dort zählen als «vermutlich Bot».</p>
        {file('asn', s.asn)}
      </section>
    </div>
  )
}

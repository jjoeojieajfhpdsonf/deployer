import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, checkReachable, type SystemStatusDto } from '../api.js'
import { copyText } from '../lib/clipboard.js'
import { NotificationSettings } from '../components/Notifications.js'
import { PageHead } from '../components/PageHead.js'

function formatBytes(n: number | null): string {
  if (n === null) return 'unbekannt'
  const gb = n / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB frei` : `${Math.round(n / 1024 ** 2)} MB frei`
}

export function System() {
  const status = useQuery({ queryKey: ['system'], queryFn: api.system, refetchInterval: 15_000 })
  const [reach, setReach] = useState<Record<string, boolean | null>>({})
  const [copied, setCopied] = useState(false)

  const ways = status.data?.reachability

  // Geprüft wird im Browser: die Frage ist, ob DIESES Gerät den Namen
  // auflöst. Eine Auflösung auf dem Server beantwortet sie nicht.
  useEffect(() => {
    if (!ways) return
    let cancelled = false
    void (async () => {
      for (const w of ways) {
        if (!w.url) {
          if (!cancelled) setReach((r) => ({ ...r, [w.way]: null }))
          continue
        }
        const ok = await checkReachable(w.url)
        if (!cancelled) setReach((r) => ({ ...r, [w.way]: ok }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [ways])

  if (status.isLoading) return <p className="state state-loading">Status wird geladen…</p>
  if (status.isError || !status.data) {
    return <p className="state state-error" role="alert">Status nicht abrufbar.</p>
  }
  const s = status.data

  return (
    <section className="page page-medium">
      <PageHead crumbs={[{ label: 'system' }]} title="System" />

      {!s.ipFilterEnabled && (
        <p role="alert" className="banner banner-warn">
          <strong>IP-Filter ist ausgeschaltet.</strong> Interne Hostnamen sind ohne
          Herkunftsprüfung erreichbar. Das ist nur für Docker Desktop auf dem Mac
          gedacht – auf dem Server gehört <code>CADDY_IP_FILTER=on</code>.
        </p>
      )}

      <h2>Dienste</h2>
      <ul className="check-list">
        {s.checks.map((c) => (
          <li key={c.name} className={c.ok ? 'check-ok' : 'check-fail'}>
            <span className="check-name">{c.name}</span>
            <span className="check-detail">{c.detail}</span>
          </li>
        ))}
        <li><span className="check-name">Platte</span><span className="check-detail">{formatBytes(s.diskFreeBytes)}</span></li>
        <li><span className="check-name">Version</span><span className="check-detail">{s.version}</span></li>
      </ul>

      <h2>Erreichbarkeit</h2>
      <p className="hint">
        Diese Prüfung läuft in deinem Browser, nicht auf dem Server – sie beantwortet,
        ob <em>dieses Gerät</em> die Namen auflöst.
      </p>
      <ul className="check-list">
        {s.reachability.map((w) => {
          const state = reach[w.way]
          const cls =
            state === true ? 'check-ok'
            : state === false ? 'check-fail'
            : state === undefined ? 'check-pending'
            : 'check-none'
          return (
            <li key={w.way} className={cls}>
              <span className="check-name">{w.label}</span>
              <span className="check-detail">
                {state === undefined ? 'wird geprüft…' : state === null ? 'nicht eingerichtet' : state ? 'erreichbar' : 'nicht erreichbar'}
              </span>
            </li>
          )
        })}
      </ul>

      {s.hostsBlock === null ? (
        <p className="hint">
          Noch keine Basisdomain gesetzt: Projekte sind über ihre nip.io-Adresse erreichbar.
          Für eigene interne Namen <code>INTERNAL_BASE_DOMAIN</code> in <code>.env</code> setzen
          und den deployer neu starten – bestehende Projekte ziehen dann mit.
        </p>
      ) : (
        <>
          <h3>Notlösung: /etc/hosts</h3>
          <p className="hint">
            Löst kein Name auf, trage diesen Block auf dem jeweiligen Gerät ein.
            Er ändert sich bei jedem neuen oder gelöschten Projekt.
          </p>
          <pre className="code-block">{s.hostsBlock}</pre>
          <button
            onClick={async () => {
              // navigator.clipboard fehlt über HTTP; copyText hat einen Rückfall.
              const ok = await copyText(s.hostsBlock ?? '')
              setCopied(ok)
              setTimeout(() => setCopied(false), 2000)
            }}
          >
            {copied ? 'Kopiert' : 'Block kopieren'}
          </button>
        </>
      )}

      <h2>HTTPS und Tailnet</h2>
      <TlsSection s={s} />

      <h2>Benachrichtigungen</h2>
      <NotificationSettings />
    </section>
  )
}

/** M4: Zertifikat, Tailnet-Eintrag, Anleitung für den lokalen DNS. */
function TlsSection({ s }: { s: SystemStatusDto }) {
  const [note, setNote] = useState<string | null>(null)
  const tailnet = useMutation({
    mutationFn: api.tailnetDns,
    onSuccess: (r) => setNote(`✓ ${r.record.name} → ${r.record.content} (${r.record.action === 'unchanged' ? 'schon richtig' : r.record.action === 'created' ? 'angelegt' : 'aktualisiert'})`),
  })
  const t = s.tls
  if (t.mode === 'off') {
    return (
      <p className="hint">
        Aus: alles läuft über HTTP. Einschalten auf dem Server mit <code>compose.tls.yaml</code>
        {' '}(Basisdomain, Cloudflare-Token als Datei) – siehe docs/MILESTONE-4.md.
      </p>
    )
  }
  const c = t.cert
  return (
    <>
      <ul className="check-list">
        <li className={c && c.ok && !c.problem ? 'check-ok' : 'check-fail'}>
          <span className="check-name">Zertifikat *.{s.baseDomain}</span>
          <span className="check-detail">
            {!c ? 'nicht abrufbar'
              : c.problem ? c.problem
              : `gültig bis ${new Date(c.validTo!).toLocaleDateString('de-CH')} (${c.daysLeft} Tage) · ${c.issuer ?? ''}`}
            {t.acmeCa === 'staging' ? ' · Staging-CA (Browser warnen)' : ''}
          </span>
        </li>
        <li className={t.tailscaleIp ? 'check-ok' : 'check-none'}>
          <span className="check-name">Tailnet</span>
          <span className="check-detail">{t.tailscaleIp ? `*.${s.baseDomain} → ${t.tailscaleIp} (Cloudflare, nicht proxied)` : 'TAILSCALE_IP nicht gesetzt'}</span>
        </li>
      </ul>
      {t.tailscaleIp && (
        <div className="form-actions">
          <button onClick={() => { setNote(null); tailnet.mutate() }} disabled={tailnet.isPending}>Tailnet-Eintrag prüfen</button>
        </div>
      )}
      {note && <p className="hint" role="status">{note}</p>}
      {tailnet.isError && <p role="alert" className="error">{(tailnet.error as Error).message}</p>}
      <h3>Im Heimnetz</h3>
      <p className="hint">
        Der lokale DNS (Router, AdGuard oder Pi-hole) soll <code>*.{s.baseDomain}</code> auf{' '}
        <code>{s.serverLanIp ?? '<LAN-IP des Servers>'}</code> zeigen lassen. Unterwegs löst Cloudflare
        denselben Namen auf die Tailscale-IP auf.
      </p>
    </>
  )
}

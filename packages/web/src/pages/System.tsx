import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, checkReachable, type SystemStatusDto } from '../api.js'
import { copyText } from '../lib/clipboard.js'
import { NotificationSettings } from '../components/Notifications.js'
import { Link, NavLink } from 'react-router-dom'
import { PageHead } from '../components/PageHead.js'
import { CloudflareSetup } from '../components/CloudflareSetup.js'
import { GithubSetup } from '../components/GithubSetup.js'
import { PausePageSettings } from '../components/PausePageSettings.js'

function formatBytes(n: number | null): string {
  if (n === null) return 'unbekannt'
  const gb = n / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB frei` : `${Math.round(n / 1024 ** 2)} MB frei`
}

export type SystemSection = 'uebersicht' | 'cloudflare' | 'veroeffentlichung' | 'benachrichtigungen' | 'github'

const SECTIONS: { key: SystemSection; to: string; label: string }[] = [
  { key: 'uebersicht', to: '/system', label: 'Übersicht' },
  { key: 'cloudflare', to: '/system/cloudflare', label: 'Cloudflare & HTTPS' },
  { key: 'veroeffentlichung', to: '/system/veroeffentlichung', label: 'Veröffentlichung' },
  { key: 'benachrichtigungen', to: '/system/benachrichtigungen', label: 'Benachrichtigungen' },
  // M8, Etappe 3
  { key: 'github', to: '/system/github', label: 'GitHub' },
]

/**
 * System in drei Unterseiten statt einer langen Seite: Übersicht (Dienste,
 * Netz, Erreichbarkeit), Cloudflare & HTTPS (Assistent, Zertifikat, Tailnet),
 * Benachrichtigungen. Die Unternavigation ist die Reiter-Steuerung der App.
 */
export function System({ section = 'uebersicht' }: { section?: SystemSection }) {
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

  const current = SECTIONS.find((x) => x.key === section)!
  return (
    <section className="page page-medium">
      <PageHead
        crumbs={section === 'uebersicht' ? [{ label: 'system' }] : [{ label: 'system', to: '/system' }, { label: current.label.toLowerCase() }]}
        title="System"
      />

      <nav className="tabs" aria-label="Bereiche von System">
        {SECTIONS.map((x) => (
          <NavLink key={x.key} to={x.to} end className={({ isActive }) => (isActive ? 'tab tab-active' : 'tab')} aria-current={x.key === section ? 'page' : undefined}>
            {x.label}
          </NavLink>
        ))}
      </nav>

      {section === 'cloudflare' && (
        <>
          <p className="lede lede-tight">Interne Adressen mit eigenem Namen und HTTPS, öffentlich schalten über einen Tunnel. Alles hier, ohne <code>.env</code> oder Compose-Dateien.</p>
          <CloudflareSetup />
          {s.baseDomain && <TlsSection s={s} />}
        </>
      )}

      {section === 'veroeffentlichung' && <PausePageSettings />}
      {section === 'benachrichtigungen' && <NotificationSettings />}

      {section === 'github' && <GithubSetup />}

      {section === 'uebersicht' && <Overview s={s} reach={reach} copied={copied} setCopied={setCopied} />}
    </section>
  )
}

type ClientIps = NonNullable<SystemStatusDto['clientIps']>

const SOURCE_TEXT: Record<'tailnet' | 'server', { title: string; hint: string }> = {
  tailnet: {
    title: 'Vermutlich aus dem Tailnet maskiert',
    hint: 'Browser-Anfragen, deren Absender Tailscale als Subnet-Router auf das Docker-Gateway umschreibt. Abhilfe: docs/INSTALL.md, Abschnitt «Tailscale als Subnet-Router».',
  },
  server: {
    title: 'Vom Server selbst',
    hint: 'Werkzeuge ohne Browser-Kennung, z. B. curl auf dem Host oder ein Container, der den Namen über die Host-Ports anfragt. Eigene Prüfungen von Airlock sind schon herausgefiltert.',
  },
}

/** Warnung mit Details: woher, welche Hosts, Beispiel-Pfade, letzte Zeit. */
function GatewayWarning({ ci }: { ci: ClientIps }) {
  return (
    <div role="alert" className="banner banner-warn gateway-warning">
      <p>
        <strong>Caddy sieht {ci.gatewayOnly ? 'nur' : 'auch'} Docker-Gateway-Adressen statt der Geräte.</strong>{' '}
        In den letzten 30 Minuten kamen {ci.fromGateway} von {ci.total} fremden Anfragen auf Airlock von{' '}
        {ci.gatewayIps.map((ip, i) => <span key={ip}>{i > 0 ? ', ' : ''}<code>{ip}</code></span>)}
        {ci.blocked > 0 ? <>, {ci.blocked} davon hat der IP-Filter gesperrt</> : null}.
        {ci.ownProbes > 0 ? <> Nicht mitgezählt: {ci.ownProbes} eigene Prüfungen von Airlock.</> : null}
      </p>
      {ci.groups.map((g) => (
        <div key={g.source} className="gateway-group">
          <p className="gateway-group-head">
            <strong>{SOURCE_TEXT[g.source].title}</strong> · {g.count} {g.count === 1 ? 'Anfrage' : 'Anfragen'}
            {g.blocked > 0 ? `, ${g.blocked} gesperrt` : ''} · zuletzt {new Date(g.last).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}
          </p>
          <dl className="gateway-facts">
            <dt>Hosts</dt><dd>{g.hosts.map((h, i) => <span key={h}>{i > 0 ? ', ' : ''}<code>{h}</code></span>)}</dd>
            <dt>Pfade</dt><dd>{g.paths.map((p, i) => <span key={p}>{i > 0 ? ', ' : ''}<code>{p}</code></span>)}</dd>
            <dt>Absender</dt><dd>{g.userAgents.join(', ')}</dd>
          </dl>
          <p className="gateway-hint">{SOURCE_TEXT[g.source].hint}</p>
        </div>
      ))}
    </div>
  )
}

function Overview({ s, reach, copied, setCopied }: { s: SystemStatusDto; reach: Record<string, boolean | null>; copied: boolean; setCopied: (v: boolean) => void }) {
  const ci = s.clientIps
  return (
    <>
      {/* Nur fremde Anfragen: eigene Prüfungen von Airlock («airlock-probe») zählen nie */}
      {ci && ci.fromGateway > 0 && <GatewayWarning ci={ci} />}
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

      <h2>Netz des Servers</h2>
      <NetworkSection s={s} />

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
          Eigene interne Namen mit Zertifikat gibt es unter <Link to="/system/cloudflare">Cloudflare &amp; HTTPS</Link> –
          bestehende Projekte ziehen dann mit.
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
    </>
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
  const c = t.cert
  return (
    <>
      <h3>Namen auflösen</h3>
      <ul className="check-list">
        {t.mode === 'cloudflare' && c?.problem && (
          <li className="check-fail">
            <span className="check-name">Zertifikat *.{s.baseDomain}</span>
            <span className="check-detail">{c.problem}</span>
          </li>
        )}
        <li className={t.tailscaleIp ? 'check-ok' : 'check-none'}>
          <span className="check-name">Tailnet</span>
          <span className="check-detail">{t.tailscaleIp ? `*.${s.baseDomain} → ${t.tailscaleIp} (Cloudflare, nicht proxied)` : 'keine Tailscale-IP angegeben (Schritt 3, optional)'}</span>
        </li>
      </ul>
      {t.tailscaleIp && (
        <div className="form-actions">
          <button onClick={() => { setNote(null); tailnet.mutate() }} disabled={tailnet.isPending}>Tailnet-Eintrag prüfen</button>
        </div>
      )}
      {note && <p className="hint" role="status">{note}</p>}
      {tailnet.isError && <p role="alert" className="error">{(tailnet.error as Error).message}</p>}
      <p className="hint">
        <strong>Im Heimnetz:</strong> Der lokale DNS (Router, AdGuard oder Pi-hole) soll <code>*.{s.baseDomain}</code> auf{' '}
        <code>{s.serverLanIp ?? '<LAN-IP des Servers>'}</code> zeigen lassen. Unterwegs löst Cloudflare
        denselben Namen auf die Tailscale-IP auf.
      </p>
    </>
  )
}

/** Tailscale als Hauptadresse; LAN-IP und -Netz werden vom Host gelesen (stündlich). */
function NetworkSection({ s }: { s: SystemStatusDto }) {
  const qc = useQueryClient()
  const n = s.network
  const check = useMutation({ mutationFn: api.checkNetwork, onSuccess: () => void qc.invalidateQueries({ queryKey: ['system'] }) })
  return (
    <>
      <ul className="check-list">
        <li className={n.tailscaleIp ? 'check-ok' : 'check-fail'}>
          <span className="check-name">Tailscale (Hauptadresse)</span>
          <span className="check-detail">
            {n.tailscaleIp
              ? <><code>{n.tailscaleIp}</code> <span className="muted">· {n.tailscaleSource}</span>{n.detectedTailscaleIp && n.detectedTailscaleIp !== n.tailscaleIp ? <span className="warn"> · erkannt wird {n.detectedTailscaleIp}</span> : null}</>
              : 'keine Tailscale-IP – neue Projekte (Standard: nur Tailnet) sind so nicht erreichbar. Tailscale auf dem Server einrichten (docs/INSTALL.md) oder beim Projekt «LAN» wählen.'}
          </span>
        </li>
        <li className={n.lanIp ? 'check-ok' : 'check-none'}>
          <span className="check-name">LAN</span>
          <span className="check-detail">
            {n.lanIp ? <><code>{n.lanIp}</code> im Netz <code>{n.lanCidr}</code>{n.lanDev ? <span className="muted"> ({n.lanDev})</span> : null}</> : <>unbekannt · Filter für «LAN» <code>{n.lanCidr}</code></>}
          </span>
        </li>
        <li className="check-none">
          <span className="check-name">Prüfung</span>
          <span className="check-detail">
            {n.mode === 'detected'
              ? <>vom Server gelesen {n.checkedAt ? new Date(n.checkedAt).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) : ''}, stündlich erneut – Adressen und Caddy-Filter ziehen bei einer Änderung selbst nach</>
              : <>Docker Desktop: keine Erkennung, Werte aus <code>.env</code> (SERVER_LAN_IP, LAN_CIDR)</>}
          </span>
        </li>
      </ul>
      {n.mode === 'detected' && (
        <div className="form-actions">
          <button type="button" onClick={() => check.mutate()} disabled={check.isPending}>{check.isPending ? 'Prüft…' : 'Jetzt prüfen'}</button>
          {check.data && <span className="hint" role="status">{check.data.changed ? 'Geändert – Adressen und Filter nachgezogen.' : 'Unverändert.'}</span>}
        </div>
      )}
      {check.isError && <p role="alert" className="error">{(check.error as Error).message}</p>}
    </>
  )
}

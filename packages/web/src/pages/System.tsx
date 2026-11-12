import { useIsFetching, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api, checkReachable, type SystemStatusDto } from '../api.js'
import { FALLBACK_MS } from '../lib/live.js'
import { Domains } from './Domains.js'
import { copyText } from '../lib/clipboard.js'
import { fmtTime } from '../lib/dates.js'
import { ErrorState, Loading, SkCard } from '../components/States.js'
import { SetupSummary } from './Setup.js'
import { NotificationSettings } from '../components/Notifications.js'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { PageHead } from '../components/PageHead.js'
import { GithubSetup } from '../components/GithubSetup.js'
import { ExpirySettings } from '../components/ExpirySettings.js'
import { BackupSection } from '../components/Backup.js'
import { TrafficSources } from '../components/TrafficSources.js'
import { useEnvPath } from '../lib/env.js'
import { GATEWAY_GUIDE_URL } from '@airlock/shared'

function formatBytes(n: number | null): string {
  if (n === null) return 'unbekannt'
  const gb = n / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB frei` : `${Math.round(n / 1024 ** 2)} MB frei`
}

export type SystemSection = 'uebersicht' | 'benachrichtigungen' | 'github' | 'backup' | 'besucher'

/**
 * M9: «Server» – was für alle Umgebungen gilt. Cloudflare & HTTPS und die
 * Vorlage der Pause-Seite gehören zur Umgebung (Einstellungen der Umgebung).
 */
const SECTIONS: { key: SystemSection; to: string; label: string }[] = [
  { key: 'uebersicht', to: '/server', label: 'Übersicht' },
  { key: 'benachrichtigungen', to: '/server/benachrichtigungen', label: 'Benachrichtigungen' },
  // M8, Etappe 3
  { key: 'github', to: '/server/github', label: 'GitHub' },
  // Meilenstein Backup, Etappe 3
  { key: 'backup', to: '/server/backup', label: 'Backup' },
  // Besucher neu: Städte, Provider, Cloudflare-Kopfzeilen
  { key: 'besucher', to: '/server/besucher', label: 'Besucher' },
]

/**
 * Server in Unterseiten statt einer langen Seite: Übersicht (Dienste, Netz,
 * Erreichbarkeit), Benachrichtigungen, GitHub. Die Unternavigation ist die
 * Reiter-Steuerung der App.
 */
export function System({ section = 'uebersicht' }: { section?: SystemSection }) {
  // Messwerte einmal pro Minute (wie die Seitenleiste); Änderungen kommen über den Ereignisstrom
  const status = useQuery({ queryKey: ['system'], queryFn: api.system, refetchInterval: FALLBACK_MS })
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

  if (!status.data) {
    return (
      <section className="page page-medium">
        <PageHead crumbs={[{ label: 'System' }]} title="System" />
        {status.isError
          ? <ErrorState what="Der Systemstatus" error={status.error} retrying={status.isFetching} onRetry={() => void status.refetch()} />
          : <Loading label="Systemstatus wird geladen"><SkCard lines={4} /><SkCard lines={5} className="sk-gap-lg" /></Loading>}
      </section>
    )
  }
  const s = status.data

  const current = SECTIONS.find((x) => x.key === section)!
  return (
    <section className="page page-medium">
      <PageHead
        crumbs={section === 'uebersicht' ? [{ label: 'Server' }] : [{ label: 'Server', to: '/server' }, { label: current.label }]}
        title="Server"
        name={section === 'uebersicht' ? 'Server' : current.label}
      />
      <ScrollToHash ready={Boolean(s)} />

      <nav className="tabs" aria-label="Bereiche des Servers">
        {SECTIONS.map((x) => (
          <NavLink key={x.key} to={x.to} end className={({ isActive }) => (isActive ? 'tab tab-active' : 'tab')} aria-current={x.key === section ? 'page' : undefined}>
            {x.label}
          </NavLink>
        ))}
      </nav>
      <p className="lede lede-tight">Gilt für alle Umgebungen. Domains, Zertifikate, Standards und Tokens stehen in den Einstellungen der jeweiligen Umgebung.</p>

      {section === 'benachrichtigungen' && <NotificationSettings />}

      {section === 'github' && <GithubSetup />}

      {section === 'backup' && <BackupSection />}

      {section === 'besucher' && <TrafficSources />}

      {section === 'uebersicht' && <SetupSummary />}
      {section === 'uebersicht' && <Overview s={s} reach={reach} copied={copied} setCopied={setCopied} />}
    </section>
  )
}

/** Sprung zu #abschnitt (z.B. /domains → Einstellungen › Cloudflare & HTTPS #domains), sobald die Seite steht */
export function ScrollToHash({ ready }: { ready: boolean }) {
  const { hash } = useLocation()
  // Erst springen, wenn alles darüber geladen ist (Cloudflare, Domains) – sonst schöbe es den Abschnitt weg
  const loading = useIsFetching()
  const done = useRef<string | null>(null)
  useEffect(() => {
    if (!ready || !hash || loading > 0 || done.current === hash) return
    const t = setTimeout(() => {
      const el = document.getElementById(hash.slice(1))
      if (!el) return
      done.current = hash
      el.scrollIntoView({ block: 'start' })
      const h = el.querySelector<HTMLElement>('h2')
      h?.setAttribute('tabindex', '-1')
      h?.focus({ preventScroll: true })
    }, 50)
    return () => clearTimeout(t)
  }, [ready, hash, loading])
  return null
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

/**
 * Warnung mit Details: woher, welche Hosts, Beispiel-Pfade, letzte Zeit.
 * Zugriffe neu: dieselbe Ursache auf Projekt-Routen (mehr als 3 Abweisungen
 * aus dem Docker-Netz in einer Stunde) steht in derselben Warnung, nicht in
 * einer zweiten.
 */
function GatewayWarning({ ci, blocks }: { ci: ClientIps | null; blocks: SystemStatusDto['dockerBlocks'] }) {
  const onAirlock = ci && ci.fromGateway > 0 ? ci : null
  return (
    <div role="alert" className="banner banner-warn gateway-warning">
      <p>
        <strong>Caddy sieht {onAirlock?.gatewayOnly ? 'nur' : 'auch'} Docker-Gateway-Adressen statt der Geräte.</strong>{' '}
        {onAirlock && (
          <>
            In den letzten 30 Minuten kamen {onAirlock.fromGateway} von {onAirlock.total} fremden Anfragen auf Airlock von{' '}
            {onAirlock.gatewayIps.map((ip, i) => <span key={ip}>{i > 0 ? ', ' : ''}<code>{ip}</code></span>)}
            {onAirlock.blocked > 0 ? <>, {onAirlock.blocked} davon hat der IP-Filter gesperrt</> : null}.
            {onAirlock.ownProbes > 0 ? <> Nicht mitgezählt: {onAirlock.ownProbes} eigene Prüfungen von Airlock.</> : null}
          </>
        )}
        {blocks && (
          <>
            {onAirlock ? ' Auch auf Projekten: ' : ''}In der letzten Stunde hat der IP-Filter {blocks.count} Anfragen aus dem Docker-Netz abgewiesen
            {' '}(<span>{blocks.hosts.map((h, i) => <span key={h}>{i > 0 ? ', ' : ''}<code>{h}</code></span>)}</span>, zuletzt {fmtTime(blocks.last)}).
            {' '}Tailnet-Verkehr wird vermutlich maskiert – Regel <code>ts-docker-nosnat</code> prüfen.
          </>
        )}
      </p>
      {blocks && !onAirlock && (
        <p className="gateway-hint">
          Abhilfe: docs/INSTALL.md, Abschnitt «Tailscale als Subnet-Router» ·{' '}
          <a href={GATEWAY_GUIDE_URL} target="_blank" rel="noreferrer">Anleitung öffnen<span className="sr-only"> (neues Fenster)</span></a>
        </p>
      )}
      {(onAirlock?.groups ?? []).map((g) => (
        <div key={g.source} className="gateway-group">
          <p className="gateway-group-head">
            <strong>{SOURCE_TEXT[g.source].title}</strong> · {g.count} {g.count === 1 ? 'Anfrage' : 'Anfragen'}
            {g.blocked > 0 ? `, ${g.blocked} gesperrt` : ''} · zuletzt {fmtTime(g.last)}
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
  const ep = useEnvPath()
  const ci = s.clientIps
  return (
    <>
      {/* Nur fremde Anfragen: eigene Prüfungen von Airlock («airlock-probe») zählen nie */}
      {((ci && ci.fromGateway > 0) || s.dockerBlocks) && <GatewayWarning ci={ci} blocks={s.dockerBlocks} />}
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
          Eigene interne Namen mit Zertifikat gibt es unter <Link to={ep('/einstellungen/cloudflare')}>Einstellungen → Cloudflare &amp; HTTPS</Link> –
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

      <ExpirySettings />
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
          <span className="check-name">Tailnet (Hauptadresse)</span>
          <span className="check-detail">
            {n.tailscaleIp
              ? <><code>{n.tailscaleIp}</code> <span className="muted">· {n.tailscaleSource}</span>{n.detectedTailscaleIp && n.detectedTailscaleIp !== n.tailscaleIp ? <span className="warn"> · erkannt wird {n.detectedTailscaleIp}</span> : null}</>
              : 'keine Tailnet-IP – neue Projekte (Standard: nur Tailnet) sind so nicht erreichbar. Tailscale auf dem Server einrichten (docs/INSTALL.md) oder beim Projekt «LAN» wählen.'}
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
              ? <>vom Server gelesen {fmtTime(n.checkedAt, false, '')}, stündlich erneut – Adressen und Caddy-Filter ziehen bei einer Änderung selbst nach</>
              : <>Docker Desktop: keine Erkennung, Werte aus <code>.env</code> (SERVER_LAN_IP, LAN_CIDR)</>}
          </span>
        </li>
      </ul>
      {n.mode === 'detected' && (
        <div className="form-actions">
          <button type="button" onClick={() => check.mutate()} disabled={check.isPending} aria-busy={check.isPending || undefined}>Jetzt prüfen</button>
          {check.data && <span className="hint" role="status">{check.data.changed ? 'Geändert – Adressen und Filter nachgezogen.' : 'Unverändert.'}</span>}
        </div>
      )}
    </>
  )
}

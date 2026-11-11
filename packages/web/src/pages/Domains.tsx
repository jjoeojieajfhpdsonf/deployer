import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useEnvPath } from '../lib/env.js'
import { api, ApiError } from '../api.js'
import { PageHead } from '../components/PageHead.js'
import { useSystem } from '../components/ServerName.js'
import { useProjects, isPublic } from '../lib/projects.js'

/**
 * Domains: woher die Adressen kommen. Intern (Basisdomain oder nip.io,
 * Zertifikat) und öffentlich (Zonen bei Cloudflare, Tunnel, öffentliche
 * Projekte).
 */
export function Domains() {
  const ep = useEnvPath()
  const system = useSystem()
  const projects = useProjects()
  const s = system.data
  const configured = Boolean(s?.publicTunnel.configured)
  const d = useQuery({ queryKey: ['domains'], queryFn: api.domains, enabled: configured })
  const sync = useMutation({ mutationFn: api.syncDomains, onSuccess: () => void d.refetch() })
  const setDefault = useMutation({ mutationFn: (n: string) => api.setDefaultDomain(n), onSuccess: () => void d.refetch() })
  const publicProjects = (projects.data?.projects ?? []).filter(isPublic)
  const t = s?.publicTunnel
  const healthy = t?.status === 'healthy'

  return (
    <section className="page page-medium">
      <PageHead crumbs={[{ label: 'domains' }]} title="Domains" />

      <h2>Intern</h2>
      <ul className="check-list">
        <li className={s?.baseDomain ? 'check-ok' : 'check-none'}>
          <span className="check-name">Basisdomain</span>
          <span className="check-detail">
            {s?.baseDomain ? <code>*.{s.baseDomain}</code> : <>keine – Adressen laufen über nip.io (<code>INTERNAL_BASE_DOMAIN</code> in .env)</>}
          </span>
        </li>
        <li className={s?.tls.mode === 'cloudflare' ? (s.tls.cert?.problem ? 'check-fail' : 'check-ok') : 'check-none'}>
          <span className="check-name">HTTPS</span>
          <span className="check-detail">
            {s?.tls.mode === 'cloudflare'
              ? s.tls.cert?.problem ?? (s.tls.cert?.daysLeft != null ? `Wildcard-Zertifikat, noch ${s.tls.cert.daysLeft} Tage gültig` : 'Wildcard-Zertifikat eingerichtet, Laufzeit noch nicht geprüft')
              : <>aus – nur HTTP; einrichten unter <Link to={ep('/einstellungen/cloudflare')}>Cloudflare &amp; HTTPS</Link></>}
          </span>
        </li>
        <li className={s?.tls.tailscaleIp ? 'check-ok' : 'check-none'}>
          <span className="check-name">Tailnet</span>
          <span className="check-detail">{s?.tls.tailscaleIp ? <>dieselben Namen unterwegs über <code>{s.tls.tailscaleIp}</code></> : 'nicht eingerichtet (TAILSCALE_IP)'}</span>
        </li>
      </ul>
      <p className="hint">Einzelheiten und die Prüfung «löst dieses Gerät die Namen auf?» unter <Link to="/server">Server</Link>.</p>

      <h2>Öffentlich</h2>
      {!configured ? (
        <div className="state state-empty">
          <h2>Cloudflare Tunnel nicht eingerichtet</h2>
          <p>
            Projekte sind nur im LAN und im Tailnet erreichbar. Öffentlich schalten geht, sobald der
            Tunnel steht – eingerichtet wird er unter System.
          </p>
          <Link className="button" to={ep('/einstellungen/cloudflare')}>Cloudflare &amp; HTTPS öffnen</Link>
        </div>
      ) : (
        <>
          <ul className="check-list">
            <li className={healthy ? 'check-ok' : 'check-fail'}>
              <span className="check-name">Tunnel</span>
              <span className="check-detail">{healthy ? `verbunden, ${t?.connections} Verbindungen` : `nicht verbunden: ${t?.status ?? 'unbekannt'}`}</span>
            </li>
          </ul>

          <div className="section-head" style={{ marginTop: 24 }}>
            <div>
              <h3>Zonen</h3>
              <p>Öffentliche Namen entstehen unter der Standard-Zone, wenn nur eine Subdomain angegeben ist.</p>
            </div>
            <button onClick={() => sync.mutate()} disabled={sync.isPending}>{sync.isPending ? 'Gleicht ab…' : 'Mit Cloudflare abgleichen'}</button>
          </div>
          {d.isLoading ? (
            <p className="state state-loading">Wird geladen…</p>
          ) : (d.data?.domains ?? []).length === 0 ? (
            <p className="state state-empty">Keine Zonen. Abgleichen holt sie aus dem Cloudflare-Konto.</p>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead><tr><th>Zone</th><th>Standard</th><th><span className="visually-hidden">Aktion</span></th></tr></thead>
                <tbody>
                  {(d.data?.domains ?? []).map((dom) => (
                    <tr key={dom.id}>
                      <td>{dom.name}</td>
                      <td>{dom.isDefault ? <span className="status status-running"><span className="status-dot" aria-hidden="true" />Standard</span> : <span className="muted">–</span>}</td>
                      <td className="row-actions">
                        {!dom.isDefault && <button className="button-small" onClick={() => setDefault.mutate(dom.name)} disabled={setDefault.isPending}>Als Standard</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {[sync, setDefault].map((m, i) => (m.isError ? <p key={i} role="alert" className="error">{m.error instanceof ApiError ? m.error.message : 'Fehler'}</p> : null))}
        </>
      )}

      <h3>Öffentliche Projekte</h3>
      {publicProjects.length === 0 ? (
        <p className="muted">Keine. Öffentlich wird ein Projekt unter Einstellungen → Erreichbarkeit, nach dem ersten Scan.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Projekt</th><th>Adresse</th><th>Zugang</th></tr></thead>
            <tbody>
              {publicProjects.map((p) => {
                const r = p.routes.find((x) => x.target === 'public')!
                return (
                  <tr key={p.id}>
                    <td className="cell-main"><Link to={ep(`/projekte/${p.id}?tab=einstellungen`)}>{p.name}</Link></td>
                    <td><a className="cell-url" href={r.urls[0]} target="_blank" rel="noreferrer">{r.hostname}</a></td>
                    <td>{r.accessProtected ? <span className="chip chip-strong">Cloudflare Access</span> : <span className="chip">offen</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

import { Link } from 'react-router-dom'
import type { CfTlsPhase } from '@airlock/shared'
import { PageHead } from '../components/PageHead.js'
import { IconPlus } from '../components/Icons.js'
import { useEnvironments } from '../lib/env.js'

/** Zustand des Zertifikats als Pille mit Wort (nie nur Farbe). */
export function TlsPill({ phase }: { phase: CfTlsPhase }) {
  const [cls, word] = phase === 'done' ? ['status-running', 'HTTPS aktiv']
    : phase === 'staging' || phase === 'production' ? ['status-deploying', 'wird eingerichtet']
    : phase === 'failed' ? ['status-failed', 'fehlgeschlagen']
    : ['status-stopped', 'nur HTTP']
  return <span className={`status ${cls}`}><span className="status-dot" aria-hidden="true" />{word}</span>
}

/**
 * M9: Umgebungen verwalten – alle Umgebungen mit Domain, Projekten,
 * Zertifikat und Cloudflare-Konto. Anlegen über den Assistenten, ändern und
 * löschen in den Einstellungen der jeweiligen Umgebung.
 */
export function Environments() {
  const q = useEnvironments()
  const envs = q.data?.environments ?? []
  return (
    <section className="page page-medium">
      <PageHead
        crumbs={[{ label: 'umgebungen' }]}
        title="Umgebungen"
        actions={<Link className="button button-primary" to="/umgebungen/neu"><IconPlus /> Umgebung anlegen</Link>}
      />
      <p className="lede lede-tight">Jede Umgebung hat ihre eigene Domain, interne Adressen mit eigenem Zertifikat, eigene Tokens und Standards. Server, Tunnel und Anmeldung teilen sich alle.</p>
      {q.isLoading ? <p className="state state-loading">Wird geladen…</p> : q.isError ? <p className="state state-error" role="alert">Umgebungen nicht abrufbar.</p> : (
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Umgebung</th><th>Interne Basis</th><th>Projekte</th><th>Zertifikat</th><th>Cloudflare</th><th><span className="visually-hidden">Aktion</span></th></tr></thead>
            <tbody>
              {envs.map((e) => (
                <tr key={e.id}>
                  <td className="cell-main">
                    <span className="env-row">
                      <span className="env-mark" aria-hidden="true">{e.short}</span>
                      <span className="env-item-text">
                        <Link to={`/u/${e.slug}/projekte`}>{e.name}</Link>
                        <span>{e.zone && e.zone !== e.name ? e.zone : e.zone ? `/u/${e.slug}` : 'noch ohne Domain'}</span>
                      </span>
                      {e.isDefault && <span className="badge badge-neutral">Standard</span>}
                    </span>
                  </td>
                  <td>{e.baseDomain ?? <span className="muted">–</span>}</td>
                  <td className="num">
                    {e.projects}
                    {e.critical > 0 && <span className="count count-critical"> · {e.critical} kritisch</span>}
                  </td>
                  <td><TlsPill phase={e.tlsPhase} /></td>
                  <td className="muted">{!e.account ? 'nicht verbunden' : e.account.sharedWith.length ? `geteilt mit ${e.account.sharedWith.join(', ')}` : `eigenes Token${e.account.name ? ` · ${e.account.name}` : ''}`}</td>
                  <td className="row-actions"><Link className="button button-small" to={`/u/${e.slug}/einstellungen`}>Einstellungen</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

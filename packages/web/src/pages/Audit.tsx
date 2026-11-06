import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api.js'

export function Audit() {
  const [filter, setFilter] = useState('')
  const events = useQuery({ queryKey: ['audit'], queryFn: () => api.audit(200) })

  if (events.isLoading) return <p className="state state-loading">Audit-Log wird geladen…</p>
  if (events.isError) return <p className="state state-error" role="alert">Audit-Log nicht lesbar.</p>

  const list = (events.data?.events ?? []).filter(
    (e) => !filter || e.action.includes(filter) || (e.targetId ?? '').includes(filter),
  )

  return (
    <section className="page page-audit">
      <header className="page-header">
        <h1>Audit</h1>
        <input
          aria-label="Filter"
          placeholder="Aktion oder Projekt filtern"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </header>

      {list.length === 0 ? (
        <p className="state state-empty">Keine Einträge.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Zeit</th><th>Wer</th><th>Aktion</th><th>Ergebnis</th><th>Details</th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id} className={e.result === 'error' ? 'row-error' : undefined}>
                  <td>{new Date(e.at).toLocaleString('de-CH')}</td>
                  <td>{e.actor}</td>
                  <td><code>{e.action}</code></td>
                  <td>{e.result === 'ok' ? 'ok' : 'Fehler'}</td>
                  <td className="cell-detail">
                    {e.error ?? JSON.stringify(e.paramsMasked)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

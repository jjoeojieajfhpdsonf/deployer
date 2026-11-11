import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SiteAccessEntryDto } from '@airlock/shared'
import { api } from '../api.js'

/**
 * Reiter «Zugriffe» einer statischen Seite: Aufrufe aus Caddys Zugriffs-Log
 * der letzten 24 Stunden (Zeit, Methode, Pfad, Status, Dauer, IP gekürzt),
 * mit Filter nach Statusklasse. Statische Seiten haben kein Container-Log.
 */

type Klass = 'alle' | '2' | '3' | '4' | '5'
const KLASS: [Klass, string][] = [['alle', 'Alle'], ['2', '2xx'], ['3', '3xx'], ['4', '4xx'], ['5', '5xx']]
const klassOf = (s: number): Klass => (s >= 500 ? '5' : s >= 400 ? '4' : s >= 300 ? '3' : '2')
/** Wort zur Statusklasse, damit die Farbe nie allein steht */
const KLASS_WORD: Record<Exclude<Klass, 'alle'>, string> = { '2': 'ok', '3': 'umgeleitet', '4': 'Clientfehler', '5': 'Serverfehler' }

function ms(v: number | null): string {
  if (v === null) return '–'
  return v < 1 ? '< 1 ms' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toLocaleString('de-CH', { maximumFractionDigits: 1 })} s`
}

export function SiteAccess({ projectId }: { projectId: string }) {
  const [klass, setKlass] = useState<Klass>('alle')
  const q = useQuery({ queryKey: ['site-access', projectId], queryFn: () => api.siteAccess(projectId), refetchInterval: 15_000 })
  const all: SiteAccessEntryDto[] = q.data?.entries ?? []
  const count = (k: Klass) => (k === 'alle' ? all.length : all.filter((e) => klassOf(e.status) === k).length)
  const list = klass === 'alle' ? all : all.filter((e) => klassOf(e.status) === klass)

  return (
    <div className="tab-panel">
      <section className="panel panel-pad ov-section" aria-labelledby="access-h">
        <div className="ov-head">
          <h2 className="ov-title" id="access-h">Zugriffe</h2>
          <span className="muted access-since">letzte 24 Stunden · IP gekürzt</span>
        </div>
        <div className="segmented access-filter" role="group" aria-label="Nach Status filtern">
          {KLASS.map(([k, label]) => (
            <button key={k} type="button" aria-pressed={klass === k} onClick={() => setKlass(k)}>
              {label} <span className="num">{count(k).toLocaleString('de-CH')}</span>
            </button>
          ))}
        </div>
        {q.isLoading ? <p className="muted ov-empty">Wird geladen…</p>
          : q.data?.error ? <p className="state state-error" role="alert">{q.data.error}</p>
          : list.length === 0 ? <p className="muted ov-empty">{all.length === 0 ? 'Noch keine Aufrufe in den letzten 24 Stunden.' : 'Keine Aufrufe mit diesem Status.'}</p>
          : (
            <div className="table-scroll">
              <table className="table access-table">
                <thead><tr><th>Zeit</th><th>Methode</th><th>Pfad</th><th>Status</th><th className="num">Dauer</th><th>IP</th></tr></thead>
                <tbody>
                  {list.map((e, i) => {
                    const k = klassOf(e.status) as Exclude<Klass, 'alle'>
                    return (
                      <tr key={`${e.at}-${i}`}>
                        <td className="num nowrap" title={new Date(e.at).toLocaleString('de-CH')}>{new Date(e.at).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                        <td><code className="access-method">{e.method}</code></td>
                        <td className="access-path"><code title={e.host}>{e.path}</code></td>
                        <td><span className={`access-status access-status-${k}`}><span className="num">{e.status}</span> {KLASS_WORD[k]}</span></td>
                        <td className="num nowrap">{ms(e.durationMs)}</td>
                        <td className="num nowrap muted">{e.ip}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </div>
  )
}

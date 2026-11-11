import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { api, type ProjectDto } from '../api.js'
import { useEnv } from '../lib/env.js'
import { leaveWithoutAsking } from '../lib/unsaved.js'
import { IconWarn } from './Icons.js'
import { InlineConfirm } from './Confirm.js'

/**
 * M9: Projekt in eine andere Umgebung verschieben (SPEC, Tabelle «Projekt
 * verschieben»). Erst Ziel wählen, dann die Folgen sehen, dann bestätigen –
 * wie überall: Warnung mit Zeichen, «Abbrechen», bestätigende Aktion als
 * einziger gefüllter Knopf in Rot.
 */
export function MoveProject({ p }: { p: ProjectDto }) {
  const { env, envs } = useEnv()
  const others = envs.filter((e) => e.id !== env?.id)
  const [to, setTo] = useState<string>('')
  const [confirming, setConfirming] = useState(false)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const id = useId()
  const preview = useQuery({ queryKey: ['move-preview', p.id, to], queryFn: () => api.movePreview(p.id, to), enabled: Boolean(to) })
  const move = useMutation({
    mutationFn: () => api.moveProject(p.id, to),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['environments'] })
      // Bestätigtes Verschieben: das Projekt folgen lassen, ohne Rückfrage (wie bisher)
      leaveWithoutAsking()
      navigate(`/u/${r.moved.to.slug}/projekte/${p.id}?tab=einstellungen`)
    },
  })
  const pv = preview.data?.preview
  const target = others.find((e) => e.slug === to)

  return (
    <fieldset className="field-group move-card" aria-describedby={`${id}-hint`}>
      <legend>In andere Umgebung verschieben</legend>
      <p className="hint" id={`${id}-hint`}>Container, Versionen, Scans und Secrets bleiben, wie sie sind. Es ändern sich die Adressen und die geerbten Standards.</p>
      {others.length === 0 ? (
        <p className="hint">Es gibt nur diese Umgebung. Eine weitere unter <Link to="/umgebungen/neu">Umgebung anlegen</Link>.</p>
      ) : (
        <>
          <label htmlFor={`${id}-to`}>Zielumgebung</label>
          <select id={`${id}-to`} className="move-select" value={to} onChange={(e) => { setTo(e.target.value); setConfirming(false) }} disabled={move.isPending}>
            <option value="">Umgebung wählen …</option>
            {others.map((e) => <option key={e.id} value={e.slug}>{e.name}{e.zone && e.zone !== e.name ? ` · ${e.zone}` : ''}</option>)}
          </select>
          {to && preview.isLoading && <p className="hint" aria-live="polite">Folgen werden ermittelt …</p>}
          {preview.isError && <p role="alert" className="error">{(preview.error as Error).message}</p>}
          {pv && (
            <>
              <h3 className="move-title">Was sich ändert</h3>
              <ul className="check-list move-list">
                <li className="check-none">
                  <span className="check-name">Interne Adresse</span>
                  <span className="check-detail">
                    {pv.internal?.from && pv.internal.to
                      ? <>{pv.internal.from} → <strong>{pv.internal.to}</strong>. Die alte Adresse leitet {pv.internal.redirectDays} Tage weiter.</>
                      : 'keine interne Adresse'}
                  </span>
                </li>
                <li className={pv.public?.hostname ? 'check-fail' : 'check-none'}>
                  <span className="check-name">Öffentliche Adresse</span>
                  <span className="check-detail">
                    {pv.public?.hostname
                      ? <>{pv.public.hostname} wird entfernt (Zone gehört zu {pv.from.name}){pv.public.paused ? ', die Pause endet' : ''}. Danach ist das Projekt privat.</>
                      : pv.public?.pendingRequest ? 'Die vorgemerkte Öffentlich-Anfrage wird verworfen.' : 'nicht öffentlich – nichts zu tun'}
                  </span>
                </li>
                <li className="check-none">
                  <span className="check-name">Header</span>
                  <span className="check-detail">
                    {pv.headers.length
                      ? pv.headers.map((h) => <span key={h.header} className="move-header"><code>{h.header}</code>: {h.from ?? 'keine Vorlage'} → {h.to ?? 'keine Vorlage'}</span>)
                      : 'gleiche Standards; eigene Regeln bleiben'}
                  </span>
                </li>
                <li className="check-none">
                  <span className="check-name">Tokens</span>
                  <span className="check-detail">
                    {pv.tokensLosingAccess.length
                      ? <>{pv.tokensLosingAccess.length === 1 ? 'Ein Token' : `${pv.tokensLosingAccess.length} Tokens`} von {pv.from.name} sehen das Projekt nicht mehr: {pv.tokensLosingAccess.map((t) => `«${t}»`).join(', ')}.</>
                      : `kein Token in ${pv.from.name}`}
                  </span>
                </li>
                <li className="check-ok">
                  <span className="check-name">Version und Daten</span>
                  <span className="check-detail">bleiben · kein Neu-Deploy, nur Caddy-Abgleich</span>
                </li>
              </ul>
              {pv.blocked && <p className="cf-warn" role="alert"><IconWarn /> {pv.blocked}</p>}
              <div className="form-actions move-actions">
                {!confirming ? (
                  <button type="button" onClick={() => setConfirming(true)} disabled={Boolean(pv.blocked)}>Verschieben …</button>
                ) : (
                  <InlineConfirm label="Verschieben bestätigen"
                    note={<> {pv.public?.hostname ? <>«{p.name}» ist danach nicht mehr öffentlich erreichbar.</> : <>«{p.name}» bekommt eine neue interne Adresse.</>}</>}
                    confirmLabel={move.isPending ? 'Wird verschoben …' : `Ja, nach «${target?.name ?? to}» verschieben`}
                    busy={move.isPending} onCancel={() => setConfirming(false)} onConfirm={() => move.mutate()} />
                )}
              </div>
              {move.isError && <p role="alert" className="error">{(move.error as Error).message}</p>}
            </>
          )}
        </>
      )}
    </fieldset>
  )
}

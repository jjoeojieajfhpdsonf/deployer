import { useId } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ACCESS_GUARD_LABEL, type AccessGuard, type ProjectDto } from '@airlock/shared'
import { api, ApiError } from '../api.js'
import { notifyOk } from '../lib/feedback.js'
import { IconLock, IconWarn } from './Icons.js'

const HINT: Record<AccessGuard, string> = {
  offen: 'Jeder, der die Adresse erreicht, sieht die Seite (intern: nur aus Tailnet und LAN).',
  login: 'Vor jeder Anfrage fragt Airlock nach deiner Anmeldung (Passwort, Passkey, zweiter Faktor). Klappt von Geräten, die Airlock erreichen – im Tailnet oder LAN.',
  cloudflare: 'Cloudflare fragt vor der öffentlichen Adresse nach einem Code per E-Mail. Airlock legt die Access-Anwendung selbst an, wenn das Cloudflare-Token die Rechte hat.',
}

/**
 * Einstellungen › Zugang: Schutz vor den Adressen eines Projekts. Für alle
 * Projekte; bei bestehenden Diensten steht die Karte zuoberst. Schwächer
 * machen fragt der Server mit der erneuten Bestätigung nach (sudo).
 */
export function AccessGuardSection({ p, prominent }: { p: ProjectDto; prominent?: boolean }) {
  const qc = useQueryClient()
  const titleId = useId()
  const current = p.accessGuard ?? 'offen'
  const pub = p.routes.find((r) => r.target === 'public')
  const save = useMutation({
    meta: { errorTitle: 'Zugang nicht geändert', quiet: true },
    mutationFn: (g: AccessGuard) => api.setAccess(p.id, g),
    onSuccess: (r, g) => {
      qc.setQueryData(['project', p.id], (old: { project: ProjectDto } | undefined) => (old ? { ...old, project: r.project } : old))
      void qc.invalidateQueries({ queryKey: ['project', p.id] })
      notifyOk(`Zugang: ${ACCESS_GUARD_LABEL[g]}`, { id: `access-${p.id}` })
    },
  })
  const err = save.error instanceof ApiError ? save.error : null

  return (
    <section className={`set-card${prominent ? ' set-card-prominent' : ''}`} id="set-zugang" aria-labelledby={titleId}>
      <div className="set-head">
        <h2 id={titleId} tabIndex={-1}><IconLock /> Zugang</h2>
        <span className="set-saved" role="status" aria-live="polite">{save.isPending ? 'speichert…' : ''}</span>
      </div>
      {p.adminUi && (
        <p className="set-row-note access-admin"><IconWarn /> <strong>{p.adminUi.name}</strong> ist eine Verwaltungsoberfläche – öffentlich nur mit Schutz.</p>
      )}
      <div className="access-options" role="radiogroup" aria-labelledby={titleId}>
        {(['offen', 'login', 'cloudflare'] as const).map((g) => {
          const disabled = g === 'cloudflare' && !pub
          return (
            <label key={g} className={`choice${disabled ? ' choice-disabled' : ''}`}>
              <input type="radio" name={`access-${p.id}`} checked={current === g} disabled={disabled || save.isPending} onChange={() => save.mutate(g)} />
              <span>
                {ACCESS_GUARD_LABEL[g]}
                <small>{disabled ? 'Geht erst, wenn das Projekt unter «Veröffentlichung» im Internet erreichbar ist.' : HINT[g]}</small>
              </span>
            </label>
          )
        })}
      </div>
      {err && <p className="error" role="alert">{err.message}</p>}
    </section>
  )
}

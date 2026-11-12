import { useEffect, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { SUDO_MINUTES, sudoSchema } from '@airlock/shared'
import { api, ApiError } from '../api.js'
import { finishSudo, useSudoRequested } from '../lib/sudo.js'
import { getPasskey, passkeysSupported, PasskeyError } from '../lib/webauthn.js'
import { useFormErrors } from '../lib/form.js'
import { Modal } from './Modal.js'
import { Field } from './Field.js'
import { IconKey } from './Icons.js'

/**
 * Nacht 3, Etappe 1: erneute Bestätigung (sudo). Öffnet sich, wenn der
 * Server eine heikle Aktion mit «sudo_required» ablehnt (api.ts). Passkey,
 * wenn hier möglich; sonst Passwort und – wenn der zweite Faktor
 * erforderlich ist – der Code aus der App oder ein Wiederherstellungscode.
 * Danach führt api.ts die Aktion noch einmal aus; «Abbrechen» lässt sie fallen.
 */
export function SudoDialog() {
  const open = useSudoRequested()
  return <SudoDialogView open={open} onDone={(ok) => finishSudo(ok)} />
}

export function SudoDialogView({ open, onDone }: { open: boolean; onDone: (ok: boolean) => void }) {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['sudo-status'], queryFn: api.sudoStatus, enabled: open, staleTime: 0, retry: false })
  const needs = status.data?.sudo.needs
  const wantsCode = Boolean(needs && (needs.totp || needs.recovery))
  const passkey = Boolean(needs?.passkey && passkeysSupported())

  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const form = useFormErrors({
    schema: sudoSchema,
    values: () => ({ password, ...(wantsCode && code ? (recovery ? { recoveryCode: code } : { code }) : {}) }),
  })

  useEffect(() => {
    if (open) return
    setPassword('')
    setCode('')
    setRecovery(false)
    setError(null)
    form.reset()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (needs && !needs.totp && needs.recovery) setRecovery(true) }, [needs])
  // Fokus erst, wenn klar ist, was geht: Passkey (erste Wahl) oder Passwort – unabhängig davon,
  // ob die Antwort vor oder nach dem Öffnen kommt
  useEffect(() => {
    if (!open || !status.isFetched) return
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-sudo-focus]')?.focus())
  }, [open, status.isFetched, passkey])

  const done = () => {
    void qc.invalidateQueries({ queryKey: ['security'] })
    onDone(true)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.validateAll()) return
    if (wantsCode && !code.trim()) {
      form.setErrors({ code: recovery ? 'Gib einen Wiederherstellungscode ein' : 'Gib den Code aus der Authenticator-App ein' })
      return
    }
    setBusy(true)
    try {
      await api.sudo({ password, ...(wantsCode ? (recovery ? { recoveryCode: code } : { code: code.replace(/\s/g, '') }) : {}) })
      done()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_credentials') form.setErrors({ password: 'Das Passwort stimmt nicht' })
      else if (err instanceof ApiError && (err.code === 'invalid_code' || err.code === 'second_factor_required')) form.setErrors({ code: err.message })
      else setError(err instanceof ApiError ? err.message : 'Nicht bestätigt')
    } finally {
      setBusy(false)
    }
  }

  async function viaPasskey() {
    setError(null)
    setBusy(true)
    try {
      const { options } = await api.sudoPasskeyOptions()
      await api.sudoPasskey(await getPasskey(options))
      done()
    } catch (err) {
      if (!(err instanceof PasskeyError && err.cancelled)) setError(err instanceof Error ? err.message : 'Nicht bestätigt')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={() => onDone(false)} labelledBy="sudo-h" describedBy="sudo-text" busy={busy} initialFocus="[data-sudo-focus]">
      <form onSubmit={submit} noValidate ref={form.formRef} className="sudo-form">
        <h2 id="sudo-h">Bestätigen, dass du es bist</h2>
        <div className="confirm-dialog-text">
          <p id="sudo-text">
            {`Heikle Aktionen – öffentlich schalten, Projekt löschen, API-Token anlegen, Backup zurückholen, zweiter Faktor – brauchen eine frische Bestätigung. Sie gilt ${SUDO_MINUTES} Minuten.`}
          </p>
        </div>
        {passkey && (
          <>
            <button type="button" className="button-primary sudo-passkey" onClick={() => void viaPasskey()} disabled={busy} data-sudo-focus>

              <IconKey size={16} /> Mit Passkey bestätigen
            </button>
            <p className="login-or" aria-hidden="true"><span>oder mit Passwort</span></p>
          </>
        )}
        <Field id={form.idFor('password')} label="Passwort" error={form.errors.password}>
          <input {...form.field('password')} data-sudo-focus={passkey ? undefined : true} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {wantsCode && (
          <Field
            id={form.idFor('code')}
            label={recovery ? 'Wiederherstellungscode' : 'Code aus der Authenticator-App'}
            error={form.errors.code ?? form.errors.recoveryCode}
          >
            <input
              {...form.field('code')}
              className="otp-input"
              inputMode={recovery ? undefined : 'numeric'}
              autoComplete={recovery ? 'off' : 'one-time-code'}
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
        )}
        {wantsCode && needs?.totp && needs.recovery && (
          <p className="hint sudo-switch">
            <button type="button" className="link-button" onClick={() => { setRecovery(!recovery); setCode(''); form.reset() }}>
              {recovery ? 'Code aus der App verwenden' : 'Wiederherstellungscode verwenden'}
            </button>
          </p>
        )}
        {status.isError && <p role="alert" className="error">Was zur Bestätigung nötig ist, liess sich nicht laden. Passwort genügt, falls kein zweiter Faktor eingerichtet ist.</p>}
        {error && <p role="alert" className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={() => onDone(false)} disabled={busy}>Abbrechen</button>
          <button type="submit" className={passkey ? undefined : 'button-primary'} disabled={busy} aria-busy={busy || undefined}>Bestätigen</button>
        </div>
      </form>
    </Modal>
  )
}

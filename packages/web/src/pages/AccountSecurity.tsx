import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  RECOVERY_CODE_COUNT, SUDO_MINUTES, passkeyNameSchema, totpCodeFormSchema, sessionAccessLabel, sessionMethodLabel,
  type PasskeyDto, type RecoveryCodesDto, type SecurityDto, type SessionDto, type TotpSetupDto,
} from '@airlock/shared'
import { api, ApiError } from '../api.js'
import { PageHead } from '../components/PageHead.js'
import { Modal } from '../components/Modal.js'
import { ConfirmDialog } from '../components/Confirm.js'
import { Field, FieldError } from '../components/Field.js'
import { Switch } from '../components/Switch.js'
import { ErrorState, Loading, SkRows } from '../components/States.js'
import { IconDownload, IconKey } from '../components/Icons.js'
import { QrSvg } from '../components/BackupKey.js'
import { relativeTime } from '../lib/format.js'
import { fmtDate } from '../lib/dates.js'
import { copyText } from '../lib/clipboard.js'
import { useFormErrors } from '../lib/form.js'
import { notifyOk } from '../lib/feedback.js'
import { markLoggedOut } from '../lib/session.js'
import { createPasskey, passkeysSupported, PasskeyError } from '../lib/webauthn.js'

/**
 * Konto › Sicherheit (Nacht 3, Etappe 1): Passkeys, Authenticator-App,
 * Wiederherstellungscodes, «Zweiter Faktor erforderlich» und die Sitzungen.
 * Jede Änderung am zweiten Faktor verlangt eine erneute Bestätigung (der
 * Server fragt, api.ts öffnet den Dialog) und meldet die anderen Sitzungen ab.
 */
export function AccountSecurity() {
  const security = useQuery({ queryKey: ['security'], queryFn: api.security })
  const [codes, setCodes] = useState<RecoveryCodesDto | null>(null)
  const s = security.data?.security

  return (
    <section className="page page-narrow security-page">
      <PageHead crumbs={[{ label: 'Konto', to: '/konto' }, { label: 'Sicherheit' }]} title="Sicherheit" />
      <p className="hint">
        Zweiter Faktor, Passkeys und angemeldete Geräte. Änderungen hier verlangen eine erneute Bestätigung
        (gilt {SUDO_MINUTES} Minuten) und melden alle anderen Geräte ab.
      </p>

      {!s && security.isError ? (
        <ErrorState what="Die Sicherheits-Einstellungen" error={security.error} retrying={security.isFetching} onRetry={() => void security.refetch()} plural />
      ) : !s ? (
        <Loading label="Sicherheit wird geladen"><SkRows n={4} /></Loading>
      ) : (
        <>
          <PasskeysPanel s={s} onCodes={setCodes} />
          <TotpPanel s={s} onCodes={setCodes} />
          <RecoveryPanel s={s} onCodes={setCodes} />
          <RequiredPanel s={s} />
        </>
      )}
      <SessionsPanel />
      <RecoveryCodesDialog codes={codes} onClose={() => setCodes(null)} />
    </section>
  )
}

/** Nach einer Änderung: neu laden und sagen, dass andere Geräte abgemeldet sind */
function useRefresh() {
  const qc = useQueryClient()
  return (title: string, revoked?: number) => {
    void qc.invalidateQueries({ queryKey: ['security'] })
    void qc.invalidateQueries({ queryKey: ['sessions'] })
    void qc.invalidateQueries({ queryKey: ['me'] })
    notifyOk(title, revoked ? { description: revoked === 1 ? 'Ein anderes Gerät wurde abgemeldet.' : `${revoked} andere Geräte wurden abgemeldet.` } : {})
  }
}

function StatusPill({ on, onLabel, offLabel }: { on: boolean; onLabel: string; offLabel: string }) {
  return (
    <span className={on ? 'status status-running' : 'status status-stopped'}>
      <span className="status-dot" aria-hidden="true" />{on ? onLabel : offLabel}
    </span>
  )
}

/* --- Passkeys ---------------------------------------------------------------- */

function PasskeysPanel({ s, onCodes }: { s: SecurityDto; onCodes: (c: RecoveryCodesDto) => void }) {
  const refresh = useRefresh()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<PasskeyDto | null>(null)
  const form = useFormErrors({ schema: passkeyNameSchema, values: () => ({ name }) })
  const host = s.passkeyHost
  const canAdd = host.available && passkeysSupported()

  const add = useMutation({
    meta: { quiet: true },
    mutationFn: async () => {
      const { options } = await api.passkeyRegisterOptions()
      const response = await createPasskey(options)
      return api.addPasskey(name.trim(), response)
    },
    onSuccess: (r) => {
      setName('')
      form.reset()
      refresh(`Passkey «${r.passkey.name}» eingerichtet`, r.revoked)
      if (r.recovery) onCodes(r.recovery)
    },
    onError: (err) => {
      if (err instanceof PasskeyError && err.cancelled) return
      if (err instanceof ApiError && err.code === 'sudo_cancelled') return
      setError(err instanceof Error ? err.message : 'Passkey nicht eingerichtet')
    },
  })
  const del = useMutation({
    meta: { quiet: true },
    mutationFn: (id: string) => api.deletePasskey(id),
    onSuccess: (r) => { const n = deleting?.name; setDeleting(null); refresh(`Passkey «${n}» gelöscht`, r.revoked) },
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (form.validateAll()) add.mutate()
  }

  return (
    <div className="panel panel-pad section security-panel">
      <div className="panel-head">
        <h2 id="sec-passkeys">Passkeys</h2>
        <StatusPill on={s.passkeys.length > 0} onLabel={`${s.passkeys.length} eingerichtet`} offLabel="keiner" />
      </div>
      <p className="hint">
        Anmelden ohne Passwort, mit Fingerabdruck, Gesicht oder dem Gerätecode. Ein Passkey ersetzt Passwort und Code.
        {host.rpId && <> Gilt nur unter <strong>{host.rpId}</strong>.</>}
      </p>

      {s.passkeys.length > 0 && (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Eingerichtet</th><th>Zuletzt benutzt</th><th><span className="visually-hidden">Aktion</span></th></tr>
            </thead>
            <tbody>
              {s.passkeys.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="passkey-name"><IconKey size={14} /> {p.name}</span>
                    {p.synced !== null && <span className="muted passkey-kind"> · {p.synced ? 'synchronisiert' : 'an ein Gerät gebunden'}</span>}
                  </td>
                  <td>{fmtDate(p.createdAt)}</td>
                  <td>{p.lastUsedAt ? relativeTime(p.lastUsedAt) : 'noch nie'}</td>
                  <td className="row-actions"><button type="button" className="button-danger" onClick={() => { del.reset(); setDeleting(p) }}>Löschen …</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canAdd ? (
        <form onSubmit={submit} className="inline-form" noValidate ref={form.formRef}>
          <div className="inline-form-field">
            <label htmlFor={form.idFor('name')} className="visually-hidden">Name des Passkeys</label>
            <input {...form.field('name')} placeholder="Name, z. B. MacBook oder iPhone" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" />
            {form.errors.name && <FieldError id={form.idFor('name')} message={form.errors.name} />}
          </div>
          <button type="submit" className={s.passkeys.length ? undefined : 'button-primary'} disabled={add.isPending} aria-busy={add.isPending || undefined}>Passkey hinzufügen</button>
        </form>
      ) : (
        <p className="banner banner-info security-note">
          {host.reason === 'other_host' && host.mainUrl
            ? <>Passkeys lassen sich nur unter der Hauptadresse einrichten: <a href={`${host.mainUrl}/konto/sicherheit`}>{host.rpId}</a>.</>
            : host.reason === 'no_base_domain'
              ? <>Passkeys brauchen einen festen Namen der Oberfläche (interne Basisdomain) mit HTTPS. Bis dahin: Authenticator-App.</>
              : host.available
                ? <>Dieser Browser kann keine Passkeys. Ein aktueller Browser oder das Telefon geht.</>
                : <>Passkeys brauchen HTTPS (Zertifikat für die interne Basisdomain). Bis dahin: Authenticator-App.</>}
        </p>
      )}
      {error && <p role="alert" className="error">{error}</p>}

      <ConfirmDialog
        open={deleting !== null}
        title={<>Passkey «{deleting?.name}» löschen?</>}
        confirmLabel="Ja, löschen"
        busy={del.isPending}
        error={del.isError && !(del.error instanceof ApiError && del.error.code === 'sudo_cancelled') ? (del.error as Error).message : null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => { if (deleting) del.mutate(deleting.id) }}
      >
        <p>Mit diesem Passkey geht danach keine Anmeldung mehr. Andere Geräte werden abgemeldet.</p>
        {s.passkeys.length === 1 && !s.totp.enabled && <p>Es ist der letzte Faktor: danach genügt wieder das Passwort, und die Wiederherstellungscodes verfallen.</p>}
      </ConfirmDialog>
    </div>
  )
}

/* --- Authenticator-App --------------------------------------------------------- */

function TotpPanel({ s, onCodes }: { s: SecurityDto; onCodes: (c: RecoveryCodesDto) => void }) {
  const refresh = useRefresh()
  const [setup, setSetup] = useState<TotpSetupDto | null>(null)
  const [removing, setRemoving] = useState(false)
  const start = useMutation({
    meta: { errorTitle: 'Einrichtung nicht gestartet' },
    mutationFn: () => api.totpSetup(),
    onSuccess: (r) => setSetup(r.setup),
  })
  const remove = useMutation({
    meta: { quiet: true },
    mutationFn: () => api.totpDisable(),
    onSuccess: (r) => { setRemoving(false); refresh('Authenticator-App entfernt', r.revoked) },
  })

  return (
    <div className="panel panel-pad section security-panel">
      <div className="panel-head">
        <h2 id="sec-totp">Authenticator-App</h2>
        <StatusPill on={s.totp.enabled} onLabel="eingerichtet" offLabel="nicht eingerichtet" />
      </div>
      <p className="hint">
        Ein sechsstelliger Code aus einer App wie 1Password, Bitwarden, Google Authenticator oder Aegis – zusätzlich
        zum Passwort. Geht auf jeder Adresse, auch über nip.io.
        {s.totp.enabledAt && <> Eingerichtet {relativeTime(s.totp.enabledAt)}.</>}
      </p>
      <div className="form-actions">
        <button type="button" className={s.totp.enabled ? undefined : 'button-primary'} onClick={() => start.mutate()} disabled={start.isPending} aria-busy={start.isPending || undefined}>
          {s.totp.enabled ? 'Neu einrichten (anderes Telefon)' : 'Authenticator-App einrichten'}
        </button>
        {s.totp.enabled && <button type="button" className="button-danger" onClick={() => { remove.reset(); setRemoving(true) }}>Entfernen …</button>}
      </div>
      <TotpSetupDialog setup={setup} onClose={() => setSetup(null)} onEnabled={(r) => { setSetup(null); refresh('Authenticator-App eingerichtet', r.revoked); if (r.recovery) onCodes(r.recovery) }} />
      <ConfirmDialog
        open={removing}
        title="Authenticator-App entfernen?"
        confirmLabel="Ja, entfernen"
        busy={remove.isPending}
        error={remove.isError && !(remove.error instanceof ApiError && remove.error.code === 'sudo_cancelled') ? (remove.error as Error).message : null}
        onCancel={() => setRemoving(false)}
        onConfirm={() => remove.mutate()}
      >
        <p>Codes aus der App gelten danach nicht mehr. Andere Geräte werden abgemeldet.</p>
        {s.passkeys.length === 0 && <p>Es ist der letzte Faktor: danach genügt wieder das Passwort, und die Wiederherstellungscodes verfallen.</p>}
      </ConfirmDialog>
    </div>
  )
}

function TotpSetupDialog({ setup, onClose, onEnabled }: {
  setup: TotpSetupDto | null
  onClose: () => void
  onEnabled: (r: { recovery: RecoveryCodesDto | null; revoked: number }) => void
}) {
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  const form = useFormErrors({ schema: totpCodeFormSchema, values: () => ({ code }) })
  const enable = useMutation({
    meta: { quiet: true },
    mutationFn: () => api.totpEnable(code.replace(/\s/g, '')),
    onSuccess: (r) => { setCode(''); form.reset(); onEnabled(r) },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'sudo_cancelled') return
      form.setErrors({ code: err instanceof Error ? err.message : 'Nicht eingerichtet' })
    },
  })
  const close = () => { setCode(''); form.reset(); onClose() }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (form.validateAll()) enable.mutate()
  }

  return (
    <Modal open={setup !== null} onClose={close} labelledBy="totp-h" busy={enable.isPending} wide initialFocus={`#${form.idFor('code')}`}>
      {setup && (
        <form onSubmit={submit} noValidate ref={form.formRef}>
          <h2 id="totp-h">Authenticator-App einrichten</h2>
          <div className="totp-setup">
            <QrSvg rows={setup.qr} label="QR-Code für die Authenticator-App" />
            <ol className="totp-steps">
              <li>In der App «Konto hinzufügen» wählen und den QR-Code scannen.</li>
              <li>
                Kein Scanner? Diesen Schlüssel von Hand eingeben:
                <code className="totp-secret">{setup.secret}</code>
                <button type="button" className="button-small" onClick={() => void copyText(setup.secret.replace(/ /g, '')).then((ok) => { setCopied(ok); setTimeout(() => setCopied(false), 2000) })}>
                  {copied ? 'Kopiert' : 'Schlüssel kopieren'}
                </button>
              </li>
              <li>
                Den Code, den die App jetzt zeigt, hier eingeben. Erst dann ist die App eingerichtet.
                <Field id={form.idFor('code')} label="Code aus der App" error={form.errors.code}>
                  <input {...form.field('code')} className="otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />
                </Field>
              </li>
            </ol>
          </div>
          <div className="dialog-actions">
            <button type="button" onClick={close} disabled={enable.isPending}>Abbrechen</button>
            <button type="submit" className="button-primary" disabled={enable.isPending} aria-busy={enable.isPending || undefined}>Code prüfen und einrichten</button>
          </div>
        </form>
      )}
    </Modal>
  )
}

/* --- Wiederherstellungscodes -------------------------------------------------- */

function RecoveryPanel({ s, onCodes }: { s: SecurityDto; onCodes: (c: RecoveryCodesDto) => void }) {
  const refresh = useRefresh()
  const [confirming, setConfirming] = useState(false)
  const regen = useMutation({
    meta: { quiet: true },
    mutationFn: () => api.regenerateRecovery(),
    onSuccess: (r) => { setConfirming(false); refresh('Neue Wiederherstellungscodes erzeugt', r.revoked); onCodes(r.recovery) },
  })
  const low = s.recovery.total > 0 && s.recovery.remaining <= 3

  return (
    <div className="panel panel-pad section security-panel">
      <div className="panel-head">
        <h2 id="sec-recovery">Wiederherstellungscodes</h2>
        {s.recovery.total > 0 && (
          <span className={low ? 'status status-warn' : 'status status-running'}>
            <span className="status-dot" aria-hidden="true" />{s.recovery.remaining} von {s.recovery.total} übrig
          </span>
        )}
      </div>
      <p className="hint">
        {RECOVERY_CODE_COUNT} Einmalcodes für den Fall, dass Telefon oder Passkey weg sind – anstelle des Codes aus der App.
        Airlock speichert nur eine Prüfsumme und zeigt die Codes genau einmal.
        {s.recovery.createdAt && <> Erzeugt am {fmtDate(s.recovery.createdAt)}.</>}
      </p>
      {s.hasFactor ? (
        <div className="form-actions">
          <button type="button" className={low ? 'button-primary' : undefined} onClick={() => { regen.reset(); setConfirming(true) }}>Neue Codes erzeugen …</button>
        </div>
      ) : (
        <p className="hint">Die Codes entstehen mit dem ersten Passkey bzw. der Authenticator-App.</p>
      )}
      <ConfirmDialog
        open={confirming}
        title="Neue Wiederherstellungscodes erzeugen?"
        confirmLabel="Ja, neue erzeugen"
        busy={regen.isPending}
        error={regen.isError && !(regen.error instanceof ApiError && regen.error.code === 'sudo_cancelled') ? (regen.error as Error).message : null}
        onCancel={() => setConfirming(false)}
        onConfirm={() => regen.mutate()}
      >
        <p>Die bisherigen Codes gelten danach nicht mehr – auch nicht die ausgedruckten. Andere Geräte werden abgemeldet.</p>
      </ConfirmDialog>
    </div>
  )
}

/** Codes einmal zeigen: kopieren, als .txt herunterladen */
export function RecoveryCodesDialog({ codes, onClose }: { codes: RecoveryCodesDto | null; onClose: () => void }) {
  const [copied, setCopied] = useState<'ok' | 'fehler' | null>(null)
  const download = () => {
    if (!codes) return
    const url = URL.createObjectURL(new Blob([codes.text], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `airlock-wiederherstellungscodes-${codes.createdAt.slice(0, 10)}.txt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <Modal open={codes !== null} onClose={() => { setCopied(null); onClose() }} labelledBy="codes-h" describedBy="codes-text" initialFocus=".codes-download">
      {codes && (
        <>
          <h2 id="codes-h">Wiederherstellungscodes</h2>
          <div className="confirm-dialog-text">
            <p id="codes-text">Jetzt sichern – Airlock zeigt sie nicht noch einmal. Jeder Code gilt genau einmal anstelle des Codes aus der App.</p>
          </div>
          <ol className="recovery-codes" aria-label="Wiederherstellungscodes">
            {codes.codes.map((c) => <li key={c}><code>{c}</code></li>)}
          </ol>
          <div className="form-actions">
            <button type="button" className="button-primary codes-download" onClick={download}><IconDownload size={14} /> Als .txt herunterladen</button>
            <button type="button" onClick={() => void copyText(codes.codes.join('\n')).then((ok) => setCopied(ok ? 'ok' : 'fehler'))}>Kopieren</button>
            <span role="status" className="fix-note">{copied === 'ok' ? 'Codes kopiert.' : ''}</span>
          </div>
          {copied === 'fehler' && <p role="alert" className="error">Kopieren ging nicht – bitte herunterladen oder von Hand abschreiben.</p>}
          <div className="dialog-actions">
            <button type="button" onClick={() => { setCopied(null); onClose() }}>Ich habe sie gesichert</button>
          </div>
        </>
      )}
    </Modal>
  )
}

/* --- Pflicht ------------------------------------------------------------------- */

function RequiredPanel({ s }: { s: SecurityDto }) {
  const refresh = useRefresh()
  const set = useMutation({
    meta: { errorTitle: 'Nicht geändert' },
    mutationFn: (v: boolean) => api.setTwoFactorRequired(v),
    onSuccess: (r, v) => refresh(v ? 'Zweiter Faktor ist erforderlich' : 'Zweiter Faktor nicht mehr erforderlich', r.revoked),
  })
  return (
    <div className="panel panel-pad section security-panel">
      <div className="switch-row">
        <div>
          <h2 id="sec-required">Zweiter Faktor erforderlich</h2>
          <p className="hint" id="sec-required-hint">
            {s.hasFactor
              ? 'An: jede Anmeldung braucht einen Passkey oder Passwort und Code (bzw. einen Wiederherstellungscode). Aus: das Passwort genügt.'
              : 'Geht, sobald ein Passkey oder die Authenticator-App eingerichtet ist – sonst könnte man sich aussperren.'}
          </p>
        </div>
        <div className="switch-with-label">
          <Switch checked={s.required} onChange={(v) => set.mutate(v)} disabled={!s.hasFactor} busy={set.isPending} labelledBy="sec-required" describedBy="sec-required-hint" />
          <span aria-hidden="true">{s.required ? 'An' : 'Aus'}</span>
        </div>
      </div>
    </div>
  )
}

/* --- Sitzungen ------------------------------------------------------------------ */

function SessionsPanel() {
  const qc = useQueryClient()
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions })
  const [confirmAll, setConfirmAll] = useState(false)
  const revoke = useMutation({
    meta: { errorTitle: 'Nicht abgemeldet' },
    mutationFn: (id: string) => api.revokeSession(id),
    onSuccess: (r) => {
      if (r.self) { markLoggedOut(); return }
      void qc.invalidateQueries({ queryKey: ['sessions'] })
      notifyOk('Gerät abgemeldet')
    },
  })
  const others = useMutation({
    meta: { errorTitle: 'Nicht abgemeldet' },
    mutationFn: () => api.revokeOtherSessions(),
    onSuccess: (r) => {
      setConfirmAll(false)
      void qc.invalidateQueries({ queryKey: ['sessions'] })
      notifyOk(r.revoked === 1 ? 'Ein Gerät abgemeldet' : `${r.revoked} Geräte abgemeldet`)
    },
  })
  const list = sessions.data?.sessions ?? []
  const otherCount = list.filter((x) => !x.current).length

  return (
    <div className="panel panel-pad section security-panel">
      <div className="panel-head">
        <h2 id="sec-sessions">Angemeldete Geräte</h2>
        {otherCount > 0 && <button type="button" onClick={() => setConfirmAll(true)}>Alle anderen abmelden …</button>}
      </div>
      <p className="hint">Jede Anmeldung gilt 7 Tage. Zugang nach der Absenderadresse, wie Caddy sie sieht.</p>
      {!sessions.data && sessions.isError ? (
        <ErrorState what="Die Sitzungen" error={sessions.error} retrying={sessions.isFetching} onRetry={() => void sessions.refetch()} compact plural />
      ) : !sessions.data ? (
        <Loading label="Sitzungen werden geladen"><SkRows n={2} card={false} /></Loading>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr><th>Gerät</th><th>Zugang</th><th>Anmeldung</th><th>Zuletzt aktiv</th><th><span className="visually-hidden">Aktion</span></th></tr>
            </thead>
            <tbody>
              {list.map((x) => <SessionRow key={x.id} x={x} busy={revoke.isPending && revoke.variables === x.id} onRevoke={() => revoke.mutate(x.id)} />)}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={confirmAll}
        title="Alle anderen Geräte abmelden?"
        confirmLabel={otherCount === 1 ? 'Ja, 1 Gerät abmelden' : `Ja, ${otherCount} Geräte abmelden`}
        busy={others.isPending}
        onCancel={() => setConfirmAll(false)}
        onConfirm={() => others.mutate()}
      >
        <p>Dieses Gerät bleibt angemeldet. Die anderen müssen sich neu anmelden; API-Tokens bleiben gültig.</p>
      </ConfirmDialog>
    </div>
  )
}

function SessionRow({ x, busy, onRevoke }: { x: SessionDto; busy: boolean; onRevoke: () => void }) {
  return (
    <tr>
      <td>
        <span className="session-device">{x.device ?? <span className="muted">Browser unbekannt</span>}</span>
        {x.current && <span className="status status-running session-current"><span className="status-dot" aria-hidden="true" />dieses Gerät</span>}
      </td>
      <td>
        <span className="session-device">{sessionAccessLabel(x.access)}</span>
        {x.ip && <span className="session-ip muted">{x.ip}</span>}
      </td>
      <td>{sessionMethodLabel(x.method)}</td>
      <td className="nowrap">{x.current ? 'jetzt' : relativeTime(x.lastSeenAt)}</td>
      <td className="row-actions">
        <button type="button" className={x.current ? undefined : 'button-danger'} onClick={onRevoke} disabled={busy} aria-busy={busy || undefined}>
          Abmelden<span className="visually-hidden"> ({x.current ? 'dieses Gerät' : x.device ?? 'Gerät'})</span>
        </button>
      </td>
    </tr>
  )
}

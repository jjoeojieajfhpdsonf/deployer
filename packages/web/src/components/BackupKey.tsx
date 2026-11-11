import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  BACKUP_PASSPHRASE_MIN, backupKeyFileInputSchema, backupKeyPaperInputSchema, backupKeyVerifySchema,
  type BackupKeyMethod, type BackupKeyPaperDto, type BackupKeyStatusDto, type BackupStatusDto,
} from '@airlock/shared'
import { api } from '../api.js'
import { Field } from './Field.js'
import { Modal } from './Modal.js'
import { useFormErrors } from '../lib/form.js'
import { notifyOk } from '../lib/feedback.js'
import { fmtDateTimeShort } from '../lib/dates.js'

/**
 * Meilenstein Backup, Etappe 4: secrets.key getrennt sichern. Der Schlüssel
 * steht nie im Backup; ohne ihn sind die gesicherten Secrets nach einer
 * Wiederherstellung wertlos. Zwei Wege, beide nach frischer Anmeldung:
 * verschlüsselte Datei (age, Passphrase) oder Papier-Anleitung mit QR.
 * Erst «getrennt abgelegt» setzt den Merker «gesichert am …».
 *
 * Schlüssel und Datei leben nur im Dialog: beim Schliessen ist beides weg.
 */

const METHOD: Record<BackupKeyMethod, string> = { file: 'als verschlüsselte Datei', paper: 'auf Papier' }

export function KeyWarning({ k }: { k: BackupKeyStatusDto }) {
  if (k.savedAt) return null
  return (
    <div role="alert" className="banner banner-warn">
      <p>
        <strong>Der Schlüssel der Secrets ist nicht getrennt gesichert.</strong>{' '}
        Er liegt absichtlich nie im Backup. Geht der Server verloren, sind ohne ihn alle gesicherten Secrets
        (Variablen der Projekte, Cloudflare-Token, SMTP, Repository-Passwort) wertlos. Sichere ihn unten unter «Schlüssel der Secrets».
      </p>
    </div>
  )
}

type Open = null | 'file' | 'paper' | 'verify'

export function KeySection({ k }: { k: BackupKeyStatusDto }) {
  const [open, setOpen] = useState<Open>(null)
  const close = () => setOpen(null)
  return (
    <section aria-labelledby="backup-schluessel-h" id="schluessel">
      <h2 id="backup-schluessel-h">Schlüssel der Secrets</h2>
      <p className="hint">
        <code>secrets.key</code> verschlüsselt alle Secrets in der Datenbank. Er ist in keinem Stand des Backups –
        bewahre ihn einmal getrennt auf, nicht beim Backup.
      </p>
      <dl className="facts backup-facts">
        <dt>Getrennt gesichert</dt>
        <dd>
          {k.savedAt
            ? <>✓ am {fmtDateTimeShort(k.savedAt)} {k.method ? METHOD[k.method] : ''}</>
            : <span className="warn">noch nie für diesen Schlüssel</span>}
        </dd>
        <dt>Prüfsumme</dt>
        <dd><code>{k.fingerprint}</code> <span className="muted">· SHA-256, Anfang</span></dd>
      </dl>
      <div className="form-actions">
        <button type="button" className={k.savedAt ? undefined : 'button-primary'} onClick={() => setOpen('file')}>Als Datei exportieren</button>
        <button type="button" onClick={() => setOpen('paper')}>Papier-Anleitung</button>
        <button type="button" onClick={() => setOpen('verify')}>Datei prüfen</button>
      </div>
      <Modal open={open === 'file'} onClose={close} labelledBy="key-file-h" describedBy="key-file-d"><KeyFileDialog onClose={close} /></Modal>
      <Modal open={open === 'paper'} onClose={close} labelledBy="key-paper-h" describedBy="key-paper-d" wide><KeyPaperDialog onClose={close} /></Modal>
      <Modal open={open === 'verify'} onClose={close} labelledBy="key-verify-h" describedBy="key-verify-d"><KeyVerifyDialog onClose={close} /></Modal>
    </section>
  )
}

/** Nach «getrennt abgelegt»: Merker setzen und den Status neu laden */
function useConfirm(onDone: () => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (method: BackupKeyMethod) => api.confirmBackupKey(method),
    onSuccess: ({ key }) => {
      qc.setQueryData<BackupStatusDto>(['backup'], (old) => (old ? { ...old, key } : old))
      notifyOk('Schlüssel als gesichert vermerkt')
      onDone()
    },
    meta: { errorTitle: 'Nicht vermerkt' },
  })
}

function downloadBase64(name: string, b64: string) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function KeyFileDialog({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [repeat, setRepeat] = useState('')
  const [done, setDone] = useState<{ filename: string; fingerprint: string } | null>(null)
  const v = useFormErrors({
    schema: backupKeyFileInputSchema,
    values: () => ({ password, passphrase }),
    extra: (): Record<string, string> => (repeat !== passphrase ? { repeat: 'Die beiden Passphrasen sind verschieden' } : {}),
  })
  const exp = useMutation({
    mutationFn: () => api.exportBackupKeyFile({ password, passphrase }),
    onSuccess: (r) => {
      downloadBase64(r.filename, r.file)
      setPassword('')
      setPassphrase('')
      setRepeat('')
      setDone({ filename: r.filename, fingerprint: r.fingerprint })
    },
    onError: (err) => void v.setServerErrors(err),
    meta: { errorTitle: 'Nicht exportiert' },
  })
  const confirm = useConfirm(onClose)
  const e = v.errors
  if (done) {
    return (
      <>
        <h2 id="key-file-h">Datei getrennt ablegen</h2>
        <p id="key-file-d" className="dialog-lede">
          <code>{done.filename}</code> ist heruntergeladen (Prüfsumme <code>{done.fingerprint}</code>). Lege sie nicht beim Backup ab,
          sondern z. B. auf einem USB-Stick oder im Passwort-Manager – zusammen mit der Passphrase an einem anderen Ort.
        </p>
        <p className="hint">Entschlüsseln auf einem frischen Server: <code>age -d -o secrets.key {done.filename}</code> (docs/RESTORE.md).</p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Später</button>
          <button type="button" className="button-primary" onClick={() => confirm.mutate('file')} disabled={confirm.isPending} aria-busy={confirm.isPending || undefined}>Getrennt abgelegt</button>
        </div>
      </>
    )
  }
  return (
    <form noValidate ref={v.formRef} onSubmit={(ev) => { ev.preventDefault(); if (v.validateAll()) exp.mutate() }}>
      <h2 id="key-file-h">Schlüssel als Datei exportieren</h2>
      <p id="key-file-d" className="dialog-lede">
        Airlock verschlüsselt den Schlüssel mit deiner Passphrase (age, scrypt). Ohne die Passphrase ist die Datei wertlos – auch für dich.
      </p>
      <Field id={v.idFor('password')} label="Anmelde-Passwort" error={e.password} hint="Zur Sicherheit noch einmal, bei jedem Export.">
        <input {...v.field('password', `${v.idFor('password')}-hint`)} type="password" autoComplete="current-password" value={password} onChange={(x) => setPassword(x.target.value)} />
      </Field>
      <Field id={v.idFor('passphrase')} label="Passphrase für die Datei" error={e.passphrase} hint={`Mindestens ${BACKUP_PASSPHRASE_MIN} Zeichen, nicht das Anmelde-Passwort.`}>
        <input {...v.field('passphrase', `${v.idFor('passphrase')}-hint`)} type="password" autoComplete="new-password" value={passphrase} onChange={(x) => setPassphrase(x.target.value)} />
      </Field>
      <Field id={v.idFor('repeat')} label="Passphrase wiederholen" error={e.repeat}>
        <input {...v.field('repeat')} type="password" autoComplete="new-password" value={repeat} onChange={(x) => setRepeat(x.target.value)} />
      </Field>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>Abbrechen</button>
        <button type="submit" className="button-primary" disabled={exp.isPending} aria-busy={exp.isPending || undefined}>Exportieren</button>
      </div>
    </form>
  )
}

/** QR-Code aus Zeilen «0101…» als SVG (mit Ruhezone) */
export function QrSvg({ rows, label }: { rows: string[]; label: string }) {
  const n = rows.length
  const q = 4
  const path = rows.flatMap((r, y) => [...r].map((c, x) => (c === '1' ? `M${x + q} ${y + q}h1v1h-1z` : ''))).join('')
  return (
    <svg className="key-qr" viewBox={`0 0 ${n + 2 * q} ${n + 2 * q}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={n + 2 * q} height={n + 2 * q} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}

function KeyPaperDialog({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('')
  const [paper, setPaper] = useState<BackupKeyPaperDto | null>(null)
  const v = useFormErrors({ schema: backupKeyPaperInputSchema, values: () => ({ password }) })
  const show = useMutation({
    mutationFn: () => api.exportBackupKeyPaper({ password }),
    onSuccess: (r) => { setPassword(''); setPaper(r) },
    onError: (err) => void v.setServerErrors(err),
    meta: { errorTitle: 'Nicht angezeigt' },
  })
  const confirm = useConfirm(onClose)
  if (!paper) {
    return (
      <form noValidate ref={v.formRef} onSubmit={(ev) => { ev.preventDefault(); if (v.validateAll()) show.mutate() }}>
        <h2 id="key-paper-h">Papier-Anleitung</h2>
        <p id="key-paper-d" className="dialog-lede">
          Zeigt den Schlüssel im Klartext zum Ausdrucken – mit QR-Code, Prüfsumme und den Schritten zum Wiederherstellen.
          Das Blatt ist so geheim wie der Server selbst: in den Tresor, nicht zum Backup.
        </p>
        <Field id={v.idFor('password')} label="Anmelde-Passwort" error={v.errors.password} hint="Zur Sicherheit noch einmal.">
          <input {...v.field('password', `${v.idFor('password')}-hint`)} type="password" autoComplete="current-password" value={password} onChange={(x) => setPassword(x.target.value)} />
        </Field>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Abbrechen</button>
          <button type="submit" className="button-primary" disabled={show.isPending} aria-busy={show.isPending || undefined}>Anzeigen</button>
        </div>
      </form>
    )
  }
  return (
    <>
      <div className="key-paper">
        <h2 id="key-paper-h">Schlüssel der Secrets · {paper.server}</h2>
        <p id="key-paper-d" className="dialog-lede">Erstellt am {fmtDateTimeShort(paper.createdAt)}. Ohne diesen Schlüssel sind die Secrets im Backup wertlos.</p>
        <div className="key-paper-grid">
          <QrSvg rows={paper.qr} label="QR-Code des Schlüssels (Base64)" />
          <dl className="facts key-paper-facts">
            <dt>Base64</dt><dd><code className="key-paper-code">{paper.key}</code></dd>
            <dt>Hex</dt><dd><code className="key-paper-code">{paper.hex.join(' ')}</code></dd>
            <dt>Prüfsumme</dt><dd><code>{paper.fingerprint}</code></dd>
          </dl>
        </div>
        <ol className="dialog-steps">
          <li>Frischen Server nach docs/INSTALL.md aufsetzen, Airlock noch nicht starten.</li>
          <li>Schlüssel schreiben: <code>echo '{paper.key}' | base64 -d &gt; secrets.key</code></li>
          <li>Prüfen: <code>sha256sum secrets.key</code> beginnt mit <code>{paper.sha256.slice(0, 16)}</code></li>
          <li>Nach <code>keys/secrets.key</code> im Daten-Volume legen (Rechte 600), dann weiter nach docs/RESTORE.md.</li>
        </ol>
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>Schliessen</button>
        <button type="button" onClick={() => window.print()}>Drucken</button>
        <button type="button" className="button-primary" onClick={() => confirm.mutate('paper')} disabled={confirm.isPending} aria-busy={confirm.isPending || undefined}>Ausgedruckt und abgelegt</button>
      </div>
    </>
  )
}

function KeyVerifyDialog({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState('')
  const [fileName, setFileName] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const v = useFormErrors({ schema: backupKeyVerifySchema, values: () => ({ file, passphrase }) })
  const check = useMutation({
    mutationFn: () => api.verifyBackupKey({ file, passphrase }),
    onError: (err) => void v.setServerErrors(err),
    meta: { errorTitle: 'Nicht geprüft' },
  })
  return (
    <form noValidate ref={v.formRef} onSubmit={(ev) => { ev.preventDefault(); if (v.validateAll()) check.mutate() }}>
      <h2 id="key-verify-h">Exportierte Datei prüfen</h2>
      <p id="key-verify-d" className="dialog-lede">Entschlüsselt die Datei auf dem Server und vergleicht sie mit dem Schlüssel dieses Servers. Der Schlüssel selbst kommt nicht zurück.</p>
      <Field id={v.idFor('file')} label="Datei (.age)" error={v.errors.file} hint={fileName ? `Gewählt: ${fileName}` : undefined}>
        <input
          {...v.field('file', fileName ? `${v.idFor('file')}-hint` : undefined)}
          type="file"
          accept=".age"
          onChange={(x) => {
            const f = x.target.files?.[0]
            if (!f) return
            setFileName(f.name)
            void f.arrayBuffer().then((b) => {
              let s = ''
              for (const c of new Uint8Array(b)) s += String.fromCharCode(c)
              setFile(btoa(s))
            })
          }}
        />
      </Field>
      <Field id={v.idFor('passphrase')} label="Passphrase der Datei" error={v.errors.passphrase}>
        <input {...v.field('passphrase')} type="password" autoComplete="off" value={passphrase} onChange={(x) => setPassphrase(x.target.value)} />
      </Field>
      {check.data && (
        <p role="status" className={check.data.matches ? 'hint ok' : 'field-error'}>
          {check.data.matches
            ? `✓ Die Datei enthält den Schlüssel dieses Servers (Prüfsumme ${check.data.fingerprint}).`
            : `✗ Die Datei enthält einen anderen Schlüssel (Prüfsumme ${check.data.fingerprint}) – nicht den dieses Servers.`}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>Schliessen</button>
        <button type="submit" className="button-primary" disabled={check.isPending} aria-busy={check.isPending || undefined}>Prüfen</button>
      </div>
    </form>
  )
}

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type NotifyEvent, type NotifySettingsDto } from '../api.js'
import { notifySettingsFormSchema } from '@airlock/shared'
import { useFormErrors } from '../lib/form.js'
import { Field } from './Field.js'

const EVENTS: { key: NotifyEvent; label: string }[] = [
  { key: 'deploy_failed', label: 'Deploy fehlgeschlagen' },
  { key: 'finding_critical', label: 'Neuer kritischer Befund' },
  { key: 'finding_high', label: 'Neuer hoher Befund' },
  { key: 'project_public', label: 'Projekt öffentlich geschaltet' },
  { key: 'external_verification_lost', label: 'Externes Ziel nicht mehr verifiziert' },
  { key: 'infra_problem', label: 'Infrastruktur-Problem' },
  { key: 'expiry', label: 'Chat-Projekt läuft ab' },
  { key: 'weekly_summary', label: 'Wochenübersicht' },
]

/**
 * Einstellungen für ntfy (Push) und E-Mail. Token und Passwort kommen nie
 * zurück; leer lassen heisst unverändert.
 */
export function NotificationSettings() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['notifications'], queryFn: api.notifications })
  const [form, setForm] = useState<NotifySettingsDto | null>(null)
  const [ntfyToken, setNtfyToken] = useState('')
  const [mailPassword, setMailPassword] = useState('')
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (q.data && !form) setForm(q.data)
  }, [q.data, form])

  const [portText, setPortText] = useState<string | null>(null)

  /**
   * Was gespeichert würde – in der Form, die die API erwartet, geprüft mit
   * denselben Schemas. Ein Abschnitt zählt als eingerichtet, sobald darin
   * etwas steht; ganz leer heisst «aus».
   */
  function payload() {
    const n = form!.ntfy
    const m = form!.email
    const port = portText ?? String(m?.port ?? 587)
    const ntfyOn = Boolean(n && (n.url.trim() || n.topic.trim() || ntfyToken))
    const emailOn = Boolean(m && (m.host.trim() || m.from.trim() || m.to.trim() || (m.user ?? '').trim() || mailPassword))
    return {
      ntfy: ntfyOn ? { url: n!.url, topic: n!.topic, ...(ntfyToken ? { token: ntfyToken } : {}) } : null,
      email: emailOn
        ? { host: m!.host, port: port.trim() === '' ? undefined : Number(port), secure: m!.secure, user: m!.user || null, from: m!.from, to: m!.to, ...(mailPassword ? { password: mailPassword } : {}) }
        : null,
      matrix: form!.matrix,
    }
  }

  const v = useFormErrors({ schema: notifySettingsFormSchema, values: payload })

  const save = useMutation({
    mutationFn: () => api.putNotifications(payload()),
    onSuccess: (d) => {
      setForm(d)
      setNtfyToken('')
      setMailPassword('')
      setPortText(null)
      setNote('✓ Gespeichert')
      v.reset()
      qc.setQueryData(['notifications'], d)
    },
    onError: (err) => void v.setServerErrors(err),
  })
  const test = useMutation({
    mutationFn: (c: 'push' | 'email') => api.testNotification(c),
    onSuccess: (_d, c) => setNote(`✓ Test über ${c === 'push' ? 'ntfy' : 'E-Mail'} verschickt`),
  })

  // Fehler zuerst: ohne Daten bleibt form null, die Ladeanzeige stünde sonst ewig.
  if (q.isError) return <p className="state state-error" role="alert">Einstellungen nicht abrufbar.</p>
  if (q.isLoading || !form) return <p className="state state-loading">Wird geladen…</p>

  const ntfy = form.ntfy ?? { url: '', topic: '', hasToken: false }
  const email = form.email ?? { host: '', port: 587, secure: false, user: null, hasPassword: false, from: '', to: '' }
  const setNtfy = (patch: Partial<typeof ntfy>) => setForm({ ...form, ntfy: { ...ntfy, ...patch } })
  const setEmail = (patch: Partial<typeof email>) => setForm({ ...form, email: { ...email, ...patch } })
  const e = v.errors

  return (
    <form
      className="notify-form"
      noValidate
      ref={v.formRef}
      onSubmit={(ev) => {
        ev.preventDefault()
        setNote(null)
        if (v.validateAll()) save.mutate()
      }}
    >
      <fieldset>
        <legend>Push über ntfy</legend>
        <p className="hint">Leer lassen, wenn du keine Push-Nachrichten willst.</p>
        <Field id={v.idFor('ntfy.url')} label="Server" error={e['ntfy.url']}>
          <input {...v.field('ntfy.url')} value={ntfy.url} placeholder="https://ntfy.sh" inputMode="url" spellCheck={false} onChange={(x) => setNtfy({ url: x.target.value })} />
        </Field>
        <Field id={v.idFor('ntfy.topic')} label="Topic" error={e['ntfy.topic']} hint="Darauf hört die ntfy-App auf deinem Telefon.">
          <input {...v.field('ntfy.topic', `${v.idFor('ntfy.topic')}-hint`)} value={ntfy.topic} placeholder="airlock-joel" spellCheck={false} onChange={(x) => setNtfy({ topic: x.target.value })} />
        </Field>
        <Field id={v.idFor('ntfy.token')} label="Token" optional error={e['ntfy.token']}>
          <input {...v.field('ntfy.token')} type="password" autoComplete="off" value={ntfyToken} placeholder={ntfy.hasToken ? 'gesetzt – leer lassen für unverändert' : ''} onChange={(x) => setNtfyToken(x.target.value)} />
        </Field>
      </fieldset>

      <fieldset>
        <legend>E-Mail über SMTP</legend>
        <p className="hint">Leer lassen, wenn du keine E-Mails willst.</p>
        <div className="field-row">
          <Field id={v.idFor('email.host')} label="Server" error={e['email.host']}>
            <input {...v.field('email.host')} value={email.host} placeholder="smtp.mail.ch" spellCheck={false} onChange={(x) => setEmail({ host: x.target.value })} />
          </Field>
          <Field id={v.idFor('email.port')} label="Port" error={e['email.port']}>
            <input {...v.field('email.port')} inputMode="numeric" value={portText ?? String(email.port)} onChange={(x) => setPortText(x.target.value)} />
          </Field>
        </div>
        <label className="checkbox"><input type="checkbox" checked={email.secure} onChange={(x) => setEmail({ secure: x.target.checked })} /> TLS ab Verbindungsbeginn (Port 465)</label>
        <div className="field-row">
          <Field id={v.idFor('email.user')} label="Benutzer" optional error={e['email.user']}>
            <input {...v.field('email.user')} value={email.user ?? ''} autoComplete="off" onChange={(x) => setEmail({ user: x.target.value })} />
          </Field>
          <Field id={v.idFor('email.password')} label="Passwort" optional error={e['email.password']}>
            <input {...v.field('email.password')} type="password" autoComplete="off" value={mailPassword} placeholder={email.hasPassword ? 'gesetzt – leer lassen für unverändert' : ''} onChange={(x) => setMailPassword(x.target.value)} />
          </Field>
        </div>
        <Field id={v.idFor('email.from')} label="Absender" error={e['email.from']}>
          <input {...v.field('email.from')} type="email" value={email.from} placeholder="airlock@meine-domain.ch" spellCheck={false} onChange={(x) => setEmail({ from: x.target.value })} />
        </Field>
        <Field id={v.idFor('email.to')} label="Empfänger" error={e['email.to']} hint="Mehrere Adressen mit Komma trennen.">
          <input {...v.field('email.to', `${v.idFor('email.to')}-hint`)} value={email.to} placeholder="joel@meine-domain.ch" spellCheck={false} onChange={(x) => setEmail({ to: x.target.value })} />
        </Field>
      </fieldset>

      <fieldset>
        <legend>Welches Ereignis über welchen Kanal</legend>
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Ereignis</th><th>Push</th><th>E-Mail</th></tr></thead>
            <tbody>
              {EVENTS.map((ev) => (
                <tr key={ev.key}>
                  <td>{ev.label}</td>
                  {(['push', 'email'] as const).map((ch) => (
                    <td key={ch}>
                      <input
                        type="checkbox"
                        aria-label={`${ev.label} über ${ch === 'push' ? 'Push' : 'E-Mail'}`}
                        checked={form.matrix[ev.key]?.[ch] ?? false}
                        onChange={(e) => setForm({ ...form, matrix: { ...form.matrix, [ev.key]: { ...form.matrix[ev.key], [ch]: e.target.checked } } })}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </fieldset>

      <div className="form-actions">
        <button className="button-primary" type="submit" disabled={save.isPending}>Speichern</button>
        <button type="button" onClick={() => test.mutate('push')} disabled={!q.data?.ntfy || test.isPending} title={q.data?.ntfy ? undefined : 'Erst ntfy einrichten und speichern'}>Test-Push</button>
        <button type="button" onClick={() => test.mutate('email')} disabled={!q.data?.email || test.isPending} title={q.data?.email ? undefined : 'Erst E-Mail einrichten und speichern'}>Test-E-Mail</button>
      </div>
      {(!q.data?.ntfy || !q.data?.email) && <p className="hint">Testen geht, sobald der jeweilige Kanal gespeichert ist.</p>}
      {note && <p className="hint" role="status">{note}</p>}
      {save.isError && <p role="alert" className="error">{(save.error as Error).message}</p>}
      {test.isError && <p role="alert" className="error">{(test.error as Error).message}</p>}
    </form>
  )
}

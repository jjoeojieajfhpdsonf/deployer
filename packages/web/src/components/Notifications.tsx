import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type NotifyEvent, type NotifySettingsDto } from '../api.js'

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

  const save = useMutation({
    mutationFn: () =>
      api.putNotifications({
        ntfy: form!.ntfy && form!.ntfy.url ? { url: form!.ntfy.url, topic: form!.ntfy.topic, ...(ntfyToken ? { token: ntfyToken } : {}) } : null,
        email: form!.email && form!.email.host
          ? { host: form!.email.host, port: form!.email.port, secure: form!.email.secure, user: form!.email.user || null, from: form!.email.from, to: form!.email.to, ...(mailPassword ? { password: mailPassword } : {}) }
          : null,
        matrix: form!.matrix,
      }),
    onSuccess: (d) => {
      setForm(d)
      setNtfyToken('')
      setMailPassword('')
      setNote('✓ Gespeichert')
      qc.setQueryData(['notifications'], d)
    },
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

  return (
    <form
      className="notify-form"
      onSubmit={(e) => {
        e.preventDefault()
        setNote(null)
        save.mutate()
      }}
    >
      <fieldset>
        <legend>Push über ntfy</legend>
        <label>Server <input value={ntfy.url} placeholder="https://ntfy.sh" onChange={(e) => setNtfy({ url: e.target.value })} /></label>
        <label>Topic <input value={ntfy.topic} onChange={(e) => setNtfy({ topic: e.target.value })} /></label>
        <label>
          Token (optional)
          <input type="password" autoComplete="off" value={ntfyToken} placeholder={ntfy.hasToken ? 'gesetzt – leer lassen für unverändert' : ''} onChange={(e) => setNtfyToken(e.target.value)} />
        </label>
      </fieldset>

      <fieldset>
        <legend>E-Mail über SMTP</legend>
        <label>Server <input value={email.host} onChange={(e) => setEmail({ host: e.target.value })} /></label>
        <label>Port <input type="number" min={1} max={65535} value={email.port} onChange={(e) => setEmail({ port: Number(e.target.value) || 587 })} /></label>
        <label className="checkbox"><input type="checkbox" checked={email.secure} onChange={(e) => setEmail({ secure: e.target.checked })} /> TLS ab Verbindungsbeginn (Port 465)</label>
        <label>Benutzer <input value={email.user ?? ''} autoComplete="off" onChange={(e) => setEmail({ user: e.target.value })} /></label>
        <label>
          Passwort
          <input type="password" autoComplete="off" value={mailPassword} placeholder={email.hasPassword ? 'gesetzt – leer lassen für unverändert' : ''} onChange={(e) => setMailPassword(e.target.value)} />
        </label>
        <label>Absender <input value={email.from} onChange={(e) => setEmail({ from: e.target.value })} /></label>
        <label>Empfänger <input value={email.to} onChange={(e) => setEmail({ to: e.target.value })} /></label>
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
        <button type="button" onClick={() => test.mutate('push')} disabled={!q.data?.ntfy || test.isPending}>Test-Push</button>
        <button type="button" onClick={() => test.mutate('email')} disabled={!q.data?.email || test.isPending}>Test-E-Mail</button>
      </div>
      {note && <p className="hint" role="status">{note}</p>}
      {save.isError && <p role="alert" className="error">{(save.error as Error).message}</p>}
      {test.isError && <p role="alert" className="error">{(test.error as Error).message}</p>}
    </form>
  )
}

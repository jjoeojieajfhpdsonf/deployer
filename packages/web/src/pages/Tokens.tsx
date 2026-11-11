import { useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ApiTokenDto } from '../api.js'
import { relativeTime } from '../lib/format.js'
import { copyText } from '../lib/clipboard.js'
import { fmtDate } from '../lib/dates.js'
import { EmptyState, ErrorState, Loading, SkRows } from '../components/States.js'
import { tokenNameSchema } from '@airlock/shared'
import { useFormErrors } from '../lib/form.js'
import { FieldError } from '../components/Field.js'
import { confirmLeave, useUnsaved } from '../lib/unsaved.js'
import { useEnv } from '../lib/env.js'

/**
 * API-Tokens für MCP-Clients (z.B. Claude) und Skripte. Der Klartext
 * erscheint genau einmal, direkt nach dem Anlegen.
 */
export function Tokens() {
  const qc = useQueryClient()
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: api.listTokens })
  const active = (tokens.data?.tokens ?? []).filter((t) => !t.revokedAt)
  const revoked = (tokens.data?.tokens ?? []).filter((t) => t.revokedAt)
  const { env } = useEnv()
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  // Antwort 14: Befehl je Shell (macOS-Standard zsh)
  const [shell, setShell] = useState<'zsh' | 'bash'>('zsh')

  const mcpUrl = `${window.location.origin}/mcp`

  const form = useFormErrors({ schema: tokenNameSchema, values: () => ({ name }) })
  // Aus der Befehlspalette («Token erstellen»): gleich ins Namensfeld
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    if (params.get('neu') === null) return
    document.getElementById(form.idFor('name'))?.focus()
    setParams({}, { replace: true })
  }, [params, setParams, form])
  const create = useMutation({
    mutationFn: (n: string) => api.createToken(n),
    onSuccess: (r) => {
      setFresh({ name: r.apiToken.name, token: r.token })
      setAnyCopied(false)
      setName('')
      void qc.invalidateQueries({ queryKey: ['tokens'] })
    },
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeToken(id),
    onSuccess: () => {
      setConfirming(null)
      void qc.invalidateQueries({ queryKey: ['tokens'] })
    },
  })

  async function copy(label: string, text: string) {
    const ok = await copyText(text)
    if (ok) setAnyCopied(true)
    setCopied(ok ? label : `${label}-fehler`)
    setTimeout(() => setCopied(null), ok ? 2000 : 6000)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (form.validateAll()) create.mutate(name.trim())
  }

  // UI-Qualität 8: fertige Einrichtung je Client zum Kopieren (vorher fehlte das Leerzeichen vor der URL)
  // Antwort 14: für alle Ordner (--scope user) und ohne Token im Befehl – es wird verdeckt eingelesen,
  // damit es nicht in der Shell-History landet; danach wieder gelöscht
  const read = shell === 'zsh' ? 'read -rs "AIRLOCK_TOKEN?Token: "' : 'read -rsp "Token: " AIRLOCK_TOKEN'
  const cli = fresh
    ? [
        read,
        `claude mcp add --transport http --scope user airlock ${mcpUrl} --header "Authorization: Bearer $AIRLOCK_TOKEN"`,
        'unset AIRLOCK_TOKEN',
      ].join('\n')
    : ''
  // Claude Desktop spricht entfernte MCP-Server über mcp-remote an (Eintrag in claude_desktop_config.json).
  // Kopfzeile über eine Umgebungsvariable und ohne Leerzeichen im Argument: so empfiehlt es mcp-remote,
  // weil Leerzeichen in args unter Windows das Argument zerteilen
  const desktop = fresh
    ? JSON.stringify({
        mcpServers: {
          airlock: {
            command: 'npx',
            args: ['-y', 'mcp-remote', mcpUrl, '--header', 'Authorization:${AUTH_HEADER}'],
            env: { AUTH_HEADER: `Bearer ${fresh.token}` },
          },
        },
      }, null, 2)
    : ''
  const [client, setClient] = useState<'code' | 'desktop'>('code')
  // Das Token steht nur dieses eine Mal da: nicht unbemerkt wegnavigieren, solange nichts kopiert ist
  const [anyCopied, setAnyCopied] = useState(false)
  useUnsaved(Boolean(fresh) && !anyCopied, `Das neue Token «${fresh?.name ?? ''}»`, 'once')

  // Antwort 9: Reiter «Tokens» in den Einstellungen der Umgebung (Titel und Brotkrumen von dort)
  return (
    <div className="tokens-panel">
      <p className="hint tokens-lede">
        Ein Token pro Client, z.B. «Claude Desktop» oder «Backup-Skript». Damit spricht der Client den
        MCP-Server unter <code>{mcpUrl}</code> oder die REST-API an – nur in der Umgebung <strong>{env?.name}</strong>:
        ihre Projekte, Domains und externen Ziele. Tokens verwalten geht nur hier, mit Anmeldung.
      </p>

      <form onSubmit={submit} className="inline-form" noValidate ref={form.formRef}>
        <div className="inline-form-field">
          <label htmlFor={form.idFor('name')} className="visually-hidden">Name des Tokens</label>
          <input {...form.field('name')} placeholder="Name, z.B. Claude Desktop" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" />
          {form.errors.name && <FieldError id={form.idFor('name')} message={form.errors.name} />}
        </div>
        <button type="submit" className="button-primary" disabled={create.isPending} aria-busy={create.isPending || undefined}>
          Token anlegen
        </button>
      </form>

      {fresh && (
        <section className="banner banner-warn token-fresh" aria-labelledby="token-fresh-h">
          <h2 id="token-fresh-h" className="token-fresh-h">Token «{fresh.name}» – jetzt kopieren, es wird nicht noch einmal angezeigt.</h2>
          <pre className="code-block" tabIndex={0} role="group" aria-label="Token">{fresh.token}</pre>
          <div className="form-actions">
            <button type="button" onClick={() => copy('token', fresh.token)}>Token kopieren</button>
          </div>

          <p className="token-fresh-lede">Oder gleich fertig eingerichtet:</p>
          <div className="segmented" role="group" aria-label="Client">
            <button type="button" aria-pressed={client === 'code'} onClick={() => setClient('code')}>Claude Code</button>
            <button type="button" aria-pressed={client === 'desktop'} onClick={() => setClient('desktop')}>Claude Desktop</button>
          </div>
          {client === 'code' ? (
            <>
              <div className="token-shell">
                <p className="hint">Im Terminal ausführen. Der Befehl fragt nach dem Token (oben kopieren, die Eingabe bleibt unsichtbar) – so landet es nicht in der Shell-History. Gilt danach in allen Ordnern.</p>
                <div className="segmented segmented-small" role="group" aria-label="Shell">
                  <button type="button" aria-pressed={shell === 'zsh'} onClick={() => setShell('zsh')}>zsh</button>
                  <button type="button" aria-pressed={shell === 'bash'} onClick={() => setShell('bash')}>bash</button>
                </div>
              </div>
              <pre className="code-block" tabIndex={0} role="group" aria-label={`Befehl für Claude Code (${shell})`}>{cli}</pre>
              <div className="form-actions">
                <button type="button" className="button-primary" onClick={() => copy('cli', cli)}>Befehl kopieren</button>
              </div>
            </>
          ) : (
            <>
              <p className="hint">In Claude Desktop unter Einstellungen › Entwickler › «Konfiguration bearbeiten» in <code>claude_desktop_config.json</code> einfügen (bestehende Einträge unter <code>mcpServers</code> behalten), dann Claude Desktop neu starten. Braucht Node.js.</p>
              <pre className="code-block" tabIndex={0} role="group" aria-label="Konfiguration für Claude Desktop">{desktop}</pre>
              <div className="form-actions">
                <button type="button" className="button-primary" onClick={() => copy('desktop', desktop)}>Konfiguration kopieren</button>
              </div>
            </>
          )}
          <p role="status" className="fix-note">
            {copied === 'token' && 'Token kopiert.'}
            {copied === 'cli' && 'Befehl kopiert.'}
            {copied === 'desktop' && 'Konfiguration kopiert.'}
          </p>
          {copied?.endsWith('-fehler') && (
            <p role="alert" className="error">Kopieren ging nicht – bitte den Text oben von Hand markieren.</p>
          )}
          <div className="form-actions">
            <button type="button" className="link-button" onClick={() => { void confirmLeave().then((ok) => { if (ok) setFresh(null) }) }}>Ausblenden</button>
          </div>
        </section>
      )}

      {!tokens.data && tokens.isError ? (
        <ErrorState what="Die Token-Liste" error={tokens.error} retrying={tokens.isFetching} onRetry={() => void tokens.refetch()} />
      ) : !tokens.data ? (
        <Loading label="Tokens werden geladen"><SkRows n={3} /></Loading>
      ) : (
        <>
          {active.length === 0 ? (
            <EmptyState title={tokens.data.tokens.length === 0 ? 'Noch kein Token' : 'Kein aktives Token'} action={<button type="button" onClick={() => document.getElementById(form.idFor('name'))?.focus()}>Token anlegen</button>}>
              Lege eins an, z.B. «Claude Desktop», und trage es dort als MCP-Server ein.
            </EmptyState>
          ) : (
            <TokenTable rows={active} confirming={confirming} setConfirming={setConfirming} revoke={revoke} />
          )}
          {revoked.length > 0 && (
            <details className="revoked-tokens">
              <summary>{revoked.length} widerrufene Token</summary>
              <TokenTable rows={revoked} confirming={confirming} setConfirming={setConfirming} revoke={revoke} />
            </details>
          )}
        </>
      )}
    </div>
  )
}

function TokenTable({ rows, confirming, setConfirming, revoke }: {
  rows: ApiTokenDto[]
  confirming: string | null
  setConfirming: (id: string | null) => void
  revoke: { isPending: boolean; mutate: (id: string) => void }
}) {
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr><th>Name</th><th>Angelegt</th><th>Zuletzt benutzt</th><th>Status</th><th><span className="visually-hidden">Aktion</span></th></tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className={t.revokedAt ? 'row-muted' : undefined}>
              <td>{t.name}</td>
              <td>{fmtDate(t.createdAt)}</td>
              <td>{t.lastUsedAt ? relativeTime(t.lastUsedAt) : 'nie'}</td>
              <td>
                <span className={t.revokedAt ? 'status status-stopped' : 'status status-running'}>
                  <span className="status-dot" aria-hidden="true" />{t.revokedAt ? 'widerrufen' : 'gültig'}
                </span>
              </td>
              <td className="row-actions">
                {!t.revokedAt && confirming !== t.id && (
                  <button className="button-danger" onClick={() => setConfirming(t.id)}>Widerrufen</button>
                )}
                {confirming === t.id && (
                  <>
                    <button onClick={() => setConfirming(null)}>Abbrechen</button>
                    <button className="button-danger-solid" disabled={revoke.isPending} onClick={() => revoke.mutate(t.id)}>
                      Ja, widerrufen
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

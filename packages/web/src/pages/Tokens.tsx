import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type ApiTokenDto } from '../api.js'
import { relativeTime } from '../components/Status.js'
import { copyText } from '../lib/clipboard.js'
import { PageHead } from '../components/PageHead.js'
import { tokenNameSchema } from '@deployer/shared'
import { useFormErrors } from '../lib/form.js'
import { FieldError } from '../components/Field.js'

/**
 * API-Tokens für MCP-Clients (z.B. Claude) und Skripte. Der Klartext
 * erscheint genau einmal, direkt nach dem Anlegen.
 */
export function Tokens() {
  const qc = useQueryClient()
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: api.listTokens })
  const active = (tokens.data?.tokens ?? []).filter((t) => !t.revokedAt)
  const revoked = (tokens.data?.tokens ?? []).filter((t) => t.revokedAt)
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  const mcpUrl = `${window.location.origin}/mcp`

  const form = useFormErrors({ schema: tokenNameSchema, values: () => ({ name }) })
  const create = useMutation({
    mutationFn: (n: string) => api.createToken(n),
    onSuccess: (r) => {
      setFresh({ name: r.apiToken.name, token: r.token })
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
    setCopied(ok ? label : `${label}-fehler`)
    setTimeout(() => setCopied(null), ok ? 2000 : 6000)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (form.validateAll()) create.mutate(name.trim())
  }

  const cli = fresh
    ? `claude mcp add --transport http deployer ${mcpUrl} --header "Authorization: Bearer ${fresh.token}"`
    : ''

  return (
    <section className="page page-medium">
      <PageHead crumbs={[{ label: 'tokens' }]} title="Tokens">
        <p className="lede">
          Ein Token pro Client, z.B. «Claude Desktop» oder «Backup-Skript». Damit spricht der Client den
          MCP-Server unter <code>{mcpUrl}</code> oder die REST-API an. Tokens verwalten geht nur hier,
          mit Anmeldung – nicht mit einem Token.
        </p>
      </PageHead>

      <form onSubmit={submit} className="inline-form" noValidate ref={form.formRef}>
        <div className="inline-form-field">
          <label htmlFor={form.idFor('name')} className="visually-hidden">Name des Tokens</label>
          <input {...form.field('name')} placeholder="Name, z.B. Claude Desktop" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" />
          {form.errors.name && <FieldError id={form.idFor('name')} message={form.errors.name} />}
        </div>
        <button type="submit" className="button-primary" disabled={create.isPending}>
          {create.isPending ? 'Wird angelegt…' : 'Token anlegen'}
        </button>
      </form>
      {create.isError && <p role="alert" className="error">{(create.error as Error).message}</p>}

      {fresh && (
        <section className="banner banner-warn" role="status">
          <p><strong>Token «{fresh.name}» – jetzt kopieren, es wird nicht noch einmal angezeigt.</strong></p>
          <pre className="code-block">{fresh.token}</pre>
          <div className="form-actions">
            <button onClick={() => copy('token', fresh.token)}>{copied === 'token' ? 'Kopiert' : 'Token kopieren'}</button>
            <button onClick={() => copy('cli', cli)}>{copied === 'cli' ? 'Kopiert' : 'Befehl für Claude Code kopieren'}</button>
            <button className="link-button" onClick={() => setFresh(null)}>Ausblenden</button>
          </div>
          {copied?.endsWith('-fehler') && (
            <p role="alert" className="error">Kopieren ging nicht – bitte den Text oben von Hand markieren.</p>
          )}
          <pre className="code-block">{cli}</pre>
        </section>
      )}

      {tokens.isLoading ? (
        <p className="state state-loading">Wird geladen…</p>
      ) : (tokens.data?.tokens ?? []).length === 0 ? (
        <p className="state state-empty">Noch kein Token.</p>
      ) : (
        <>
          {active.length === 0 ? (
            <p className="state state-empty">Noch kein aktives Token. Lege eins an, z.B. «Claude Desktop», und trage es dort als MCP-Server ein.</p>
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
      {revoke.isError && (
        <p role="alert" className="error">{revoke.error instanceof ApiError ? revoke.error.message : 'Widerrufen fehlgeschlagen'}</p>
      )}
    </section>
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
              <td>{new Date(t.createdAt).toLocaleDateString('de-CH')}</td>
              <td>{t.lastUsedAt ? relativeTime(t.lastUsedAt) : 'nie'}</td>
              <td>
                <span className={t.revokedAt ? 'status status-stopped' : 'status status-running'}>
                  <span className="status-dot" aria-hidden="true" />{t.revokedAt ? 'widerrufen' : 'gültig'}
                </span>
              </td>
              <td className="row-actions">
                {!t.revokedAt && confirming !== t.id && (
                  <button className="button-danger" onClick={() => setConfirming(t.id)}>Widerrufen …</button>
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

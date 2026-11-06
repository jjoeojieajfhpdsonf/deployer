import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { slugify } from '@deployer/shared'
import { api, ApiError } from '../api.js'
import { EnvEditor, type EnvRow } from '../components/EnvEditor.js'

type Kind = 'image' | 'static'

export function NewProject() {
  const navigate = useNavigate()
  const [kind, setKind] = useState<Kind>('image')
  const [name, setName] = useState('')
  const [image, setImage] = useState('')
  const [port, setPort] = useState('80')
  const [healthcheckPath, setHealthcheckPath] = useState('/')
  const [file, setFile] = useState<File | null>(null)
  const [env, setEnv] = useState<EnvRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const slug = slugify(name || '')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      let source: unknown
      if (kind === 'image') {
        source = { type: 'image', image }
      } else {
        if (!file) throw new Error('Bitte ein ZIP auswählen')
        const { upload } = await api.upload(file)
        source = { type: 'static', uploadId: upload.id }
      }

      const { project } = await api.createProject({
        name,
        source,
        ...(kind === 'image' ? { port: Number(port) } : {}),
        healthcheckPath,
        env: env.filter((r) => r.key).map((r) => ({ key: r.key, value: r.value, isSecret: r.isSecret })),
        targets: ['lan'],
        deploy: true,
      })
      navigate(`/projekte/${project.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page page-new">
      <h1>Neues Projekt</h1>

      <form onSubmit={submit} className="form">
        <fieldset className="field-group">
          <legend>Woher kommt das Projekt?</legend>
          <label className="choice">
            <input type="radio" checked={kind === 'image'} onChange={() => setKind('image')} />
            <span>
              <strong>Fertiges Image</strong>
              <small>Aus einer Registry, z.B. <code>traefik/whoami:latest</code></small>
            </span>
          </label>
          <label className="choice">
            <input type="radio" checked={kind === 'static'} onChange={() => setKind('static')} />
            <span>
              <strong>Statische Seite</strong>
              <small>Ein ZIP mit HTML, CSS und Bildern</small>
            </span>
          </label>
        </fieldset>

        <label htmlFor="name">Name</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        {slug && (
          <p className="hint">
            Erreichbar unter <code>{slug}</code> – die vollständige Adresse steht nach dem Anlegen
            auf der Projektseite.
          </p>
        )}

        {kind === 'image' ? (
          <>
            <label htmlFor="image">Image</label>
            <input
              id="image"
              value={image}
              onChange={(e) => setImage(e.target.value)}
              placeholder="ghcr.io/user/app:1.2"
              required
            />
            <label htmlFor="port">Port im Container</label>
            <input id="port" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} required />
            <label htmlFor="hc">Pfad für den Healthcheck</label>
            <input id="hc" value={healthcheckPath} onChange={(e) => setHealthcheckPath(e.target.value)} required />
          </>
        ) : (
          <>
            <label htmlFor="zip">ZIP-Datei</label>
            <input
              id="zip"
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
            />
            <p className="hint">Höchstens 100 MB, entpackt höchstens 500 MB und 10 000 Dateien.</p>
          </>
        )}

        <EnvEditor rows={env} onChange={setEnv} />

        <fieldset className="field-group">
          <legend>Erreichbarkeit</legend>
          <label className="choice">
            <input type="checkbox" checked readOnly />
            <span>Im Heimnetz und im Tailnet (interne Adresse)</span>
          </label>
          <label className="choice choice-disabled">
            <input type="checkbox" disabled />
            <span>
              Öffentlich über Cloudflare Tunnel
              <small>Kommt mit Meilenstein 5</small>
            </span>
          </label>
        </fieldset>

        {error && <p role="alert" className="error">{error}</p>}

        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={busy}>
            {busy ? 'Wird angelegt…' : 'Anlegen und deployen'}
          </button>
        </div>
      </form>
    </section>
  )
}

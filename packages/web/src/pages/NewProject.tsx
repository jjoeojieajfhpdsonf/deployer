import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { slugify } from '@deployer/shared'
import { api, ApiError } from '../api.js'
import { EnvEditor, type EnvRow } from '../components/EnvEditor.js'

type Kind = 'image' | 'dockerfile' | 'compose' | 'static'
type Origin = 'upload' | 'repo'

const KINDS: { kind: Kind; title: string; hint: string }[] = [
  { kind: 'image', title: 'Fertiges Image', hint: 'Aus einer Registry, z.B. traefik/whoami:latest' },
  { kind: 'dockerfile', title: 'Repo mit Dockerfile', hint: 'Wird geklont und gebaut' },
  { kind: 'compose', title: 'Docker Compose', hint: 'Mehrere Dienste, z.B. App und Datenbank' },
  { kind: 'static', title: 'Statische Seite', hint: 'ZIP oder Repo, optional mit Build-Befehl' },
]

export function NewProject() {
  const navigate = useNavigate()
  const [kind, setKind] = useState<Kind>('image')
  const [origin, setOrigin] = useState<Origin>('upload')
  const [name, setName] = useState('')
  const [image, setImage] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [ref, setRef] = useState('')
  const [dockerfile, setDockerfile] = useState('Dockerfile')
  const [context, setContext] = useState('.')
  const [composePath, setComposePath] = useState('compose.yaml')
  const [webService, setWebService] = useState('web')
  const [buildCommand, setBuildCommand] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [port, setPort] = useState('80')
  const [healthcheckPath, setHealthcheckPath] = useState('/')
  const [file, setFile] = useState<File | null>(null)
  const [env, setEnv] = useState<EnvRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const slug = slugify(name || '')
  const needsPort = kind !== 'static'
  const usesUpload = (kind === 'static' || kind === 'compose') && origin === 'upload'
  const usesRepo = kind === 'dockerfile' || ((kind === 'static' || kind === 'compose') && origin === 'repo')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      let uploadId: string | undefined
      if (usesUpload) {
        if (!file) throw new Error(kind === 'compose' ? 'Bitte eine compose.yaml auswählen' : 'Bitte ein ZIP auswählen')
        uploadId = (await api.upload(file)).upload.id
      }
      const r = ref.trim() || undefined
      const source =
        kind === 'image' ? { type: 'image', image }
        : kind === 'dockerfile' ? { type: 'dockerfile', repoUrl, ref: r, dockerfile, context }
        : kind === 'compose'
          ? usesRepo
            ? { type: 'compose', repoUrl, ref: r, composePath, webService }
            : { type: 'compose', uploadId, webService }
          : usesRepo
            ? {
                type: 'static', repoUrl, ref: r,
                buildCommand: buildCommand.trim() || undefined,
                outputDir: outputDir.trim() || undefined,
              }
            : { type: 'static', uploadId }

      const { project } = await api.createProject({
        name,
        source,
        ...(needsPort ? { port: Number(port) } : {}),
        healthcheckPath,
        env: env.filter((x) => x.key).map((x) => ({ key: x.key, value: x.value, isSecret: x.isSecret })),
        targets: ['lan', 'tailnet'],
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
          {KINDS.map((k) => (
            <label key={k.kind} className="choice">
              <input type="radio" checked={kind === k.kind} onChange={() => setKind(k.kind)} />
              <span>
                <strong>{k.title}</strong>
                <small>{k.hint}</small>
              </span>
            </label>
          ))}
        </fieldset>

        {(kind === 'static' || kind === 'compose') && (
          <fieldset className="field-group">
            <legend>{kind === 'compose' ? 'compose.yaml' : 'Dateien'}</legend>
            <label className="choice">
              <input type="radio" checked={origin === 'upload'} onChange={() => setOrigin('upload')} />
              <span>Hochladen</span>
            </label>
            <label className="choice">
              <input type="radio" checked={origin === 'repo'} onChange={() => setOrigin('repo')} />
              <span>Aus einem Git-Repo</span>
            </label>
          </fieldset>
        )}

        <label htmlFor="name">Name</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        {slug && (
          <p className="hint">
            Kurzname <code>{slug}</code> – die vollständige Adresse steht nach dem Anlegen auf der Projektseite.
          </p>
        )}

        {kind === 'image' && (
          <>
            <label htmlFor="image">Image</label>
            <input id="image" value={image} onChange={(e) => setImage(e.target.value)} placeholder="ghcr.io/user/app:1.2" required />
          </>
        )}

        {usesRepo && (
          <>
            <label htmlFor="repo">Repo-URL</label>
            <input id="repo" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/user/app.git" required />
            <p className="hint">Nur öffentliche Repos über https:// (oder http:// im LAN).</p>
            <label htmlFor="ref">Branch, Tag oder Commit</label>
            <input id="ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="leer = Standard-Branch" />
          </>
        )}

        {kind === 'dockerfile' && (
          <>
            <label htmlFor="df">Dockerfile</label>
            <input id="df" value={dockerfile} onChange={(e) => setDockerfile(e.target.value)} required />
            <label htmlFor="ctx">Build-Kontext</label>
            <input id="ctx" value={context} onChange={(e) => setContext(e.target.value)} required />
          </>
        )}

        {kind === 'compose' && usesRepo && (
          <>
            <label htmlFor="cp">Pfad der compose.yaml im Repo</label>
            <input id="cp" value={composePath} onChange={(e) => setComposePath(e.target.value)} required />
          </>
        )}

        {kind === 'compose' && (
          <>
            <label htmlFor="ws">Web-Dienst</label>
            <input id="ws" value={webService} onChange={(e) => setWebService(e.target.value)} required />
            <p className="hint">
              Der Dienst, der die Besucher bekommt. Nicht erlaubt sind u.a. <code>ports</code>,
              <code> privileged</code> und Bind-Mounts – Dateien gehören ins Image.
            </p>
          </>
        )}

        {kind === 'static' && usesRepo && (
          <>
            <label htmlFor="bc">Build-Befehl (optional)</label>
            <input id="bc" value={buildCommand} onChange={(e) => setBuildCommand(e.target.value)} placeholder="npm run build" />
            <label htmlFor="od">Ausgabeordner</label>
            <input id="od" value={outputDir} onChange={(e) => setOutputDir(e.target.value)} placeholder={buildCommand ? 'dist' : '.'} />
          </>
        )}

        {usesUpload && (
          <>
            <label htmlFor="file">{kind === 'compose' ? 'compose.yaml' : 'ZIP-Datei'}</label>
            <input
              id="file"
              type="file"
              accept={kind === 'compose' ? '.yaml,.yml' : '.zip,application/zip'}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
            />
            <p className="hint">
              {kind === 'compose'
                ? 'Höchstens 256 KB. Ohne Repo gibt es kein build: und kein env_file.'
                : 'Höchstens 100 MB, entpackt höchstens 500 MB und 10 000 Dateien.'}
            </p>
          </>
        )}

        {needsPort && (
          <>
            <label htmlFor="port">Port im Container</label>
            <input id="port" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} required />
            <label htmlFor="hc">Pfad für den Healthcheck</label>
            <input id="hc" value={healthcheckPath} onChange={(e) => setHealthcheckPath(e.target.value)} required />
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
              <small>Erst nach dem ersten Scan, unter Einstellungen → Erreichbarkeit</small>
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

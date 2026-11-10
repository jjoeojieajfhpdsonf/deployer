import { useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { slugify, createProjectSchema } from '@deployer/shared'
import { api, ApiError } from '../api.js'
import { EnvEditor, type EnvRow } from '../components/EnvEditor.js'
import { PageHead } from '../components/PageHead.js'
import { Field, FormError } from '../components/Field.js'
import { useFormErrors, type Errors } from '../lib/form.js'

type Kind = 'image' | 'dockerfile' | 'compose' | 'static'
type Origin = 'upload' | 'repo'

const KINDS: { kind: Kind; title: string; hint: string }[] = [
  { kind: 'image', title: 'Fertiges Image', hint: 'Aus einer Registry, z.B. traefik/whoami:latest' },
  { kind: 'dockerfile', title: 'Repo mit Dockerfile', hint: 'Wird geklont und gebaut' },
  { kind: 'compose', title: 'Docker Compose', hint: 'Mehrere Dienste, z.B. App und Datenbank' },
  { kind: 'static', title: 'Statische Seite', hint: 'ZIP oder Repo, optional mit Build-Befehl' },
]

const MAX_ZIP = 100 * 1024 * 1024
const MAX_COMPOSE = 256 * 1024
/** Platzhalter für die Prüfung vor dem Hochladen; die echte id kommt danach. */
const PENDING_UPLOAD = '00000000-0000-4000-8000-000000000000'
const opt = (v: string) => (v.trim() === '' ? undefined : v)

/** Vorwahl aus der Karte «Neues Projekt» der Übersicht (?quelle=git|image|upload). */
const PRESET: Record<string, { kind: Kind; origin: Origin }> = {
  git: { kind: 'dockerfile', origin: 'repo' },
  image: { kind: 'image', origin: 'upload' },
  upload: { kind: 'static', origin: 'upload' },
}

export function NewProject() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const preset = PRESET[params.get('quelle') ?? '']
  const [kind, setKind] = useState<Kind>(preset?.kind ?? 'image')
  const [origin, setOrigin] = useState<Origin>(preset?.origin ?? 'upload')
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
  // Tailscale ist die Hauptadresse des Servers; LAN nur auf Wunsch
  const [tailnet, setTailnet] = useState(true)
  const [lan, setLan] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const slug = slugify(name || '')
  const needsPort = kind !== 'static'
  const usesUpload = (kind === 'static' || kind === 'compose') && origin === 'upload'
  const usesRepo = kind === 'dockerfile' || ((kind === 'static' || kind === 'compose') && origin === 'repo')

  /** Eingaben in der Form, die die API erwartet – geprüft mit demselben Schema. */
  function payload(uploadId?: string) {
    const r = opt(ref)
    const source =
      kind === 'image' ? { type: 'image', image }
      : kind === 'dockerfile' ? { type: 'dockerfile', repoUrl, ref: r, dockerfile, context }
      : kind === 'compose'
        ? usesRepo
          ? { type: 'compose', repoUrl, ref: r, composePath, webService }
          : { type: 'compose', uploadId, webService }
        : usesRepo
          ? { type: 'static', repoUrl, ref: r, buildCommand: opt(buildCommand), outputDir: opt(outputDir) }
          : { type: 'static', uploadId }
    return {
      name,
      source,
      ...(needsPort ? { port: port.trim() === '' ? undefined : Number(port) } : {}),
      healthcheckPath,
      env: env.map((x) => ({ key: x.key, value: x.value, isSecret: x.isSecret })),
      targets: [...(tailnet ? ['tailnet' as const] : []), ...(lan ? ['lan' as const] : [])],
      deploy: true,
    }
  }

  const form = useFormErrors({
    schema: createProjectSchema,
    values: () => payload(file ? PENDING_UPLOAD : undefined),
    extra: (): Errors => {
      if (!usesUpload) return {}
      if (!file) return { file: kind === 'compose' ? 'Wähle deine compose.yaml aus' : 'Wähle das ZIP mit den Dateien der Seite aus, z.B. dist.zip' }
      if (kind === 'compose' && file.size > MAX_COMPOSE) return { file: `Die Datei ist ${Math.ceil(file.size / 1024)} KB gross; eine compose.yaml darf höchstens 256 KB haben` }
      if (kind === 'static' && file.size > MAX_ZIP) return { file: `Das ZIP ist ${Math.ceil(file.size / 1024 / 1024)} MB gross; höchstens 100 MB` }
      if (kind === 'static' && !/\.zip$/i.test(file.name)) return { file: 'Wähle eine ZIP-Datei (.zip) aus' }
      return {}
    },
  })
  const e = form.errors
  // «Upload oder Repo» meldet das Schema auf "source"; beim Hochladen gehört die Meldung zum Dateifeld.
  const sourceError = usesUpload ? undefined : e.source

  async function submit(ev: FormEvent) {
    ev.preventDefault()
    setError(null)
    if (!form.validateAll()) return
    setBusy(true)
    try {
      const uploadId = usesUpload && file ? (await api.upload(file)).upload.id : undefined
      const { project } = await api.createProject(payload(uploadId))
      navigate(`/projekte/${project.id}`)
    } catch (err) {
      // Prüft die API anders als erwartet, landet ihre Meldung trotzdem am Feld.
      if (!form.setServerErrors(err)) setError(err instanceof ApiError ? err.message : (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page page-narrow">
      <PageHead crumbs={[{ label: 'projekte', to: '/projekte' }, { label: 'neu' }]} title="Neues Projekt">
        <p className="lede">Aus dem Chat geht es ohne Formular: Claude legt Projekte über MCP direkt an.</p>
      </PageHead>

      <form onSubmit={submit} className="form" noValidate ref={form.formRef}>
        <fieldset className="field-group">
          <legend>Quelle</legend>
          <div className="kind-grid">
            {KINDS.map((k) => (
              <label key={k.kind} className="choice kind-card">
                <input type="radio" name="kind" checked={kind === k.kind} onChange={() => { setKind(k.kind); form.reset() }} />
                <span>
                  <strong>{k.title}</strong>
                  <small>{k.hint}</small>
                </span>
              </label>
            ))}
          </div>
          {(kind === 'static' || kind === 'compose') && (
            <div className="origin-switch" role="radiogroup" aria-label={kind === 'compose' ? 'Woher kommt die compose.yaml?' : 'Woher kommen die Dateien?'}>
              <label className="choice">
                <input type="radio" name="origin" checked={origin === 'upload'} onChange={() => { setOrigin('upload'); form.reset() }} />
                <span>Hochladen</span>
              </label>
              <label className="choice">
                <input type="radio" name="origin" checked={origin === 'repo'} onChange={() => { setOrigin('repo'); form.reset() }} />
                <span>Aus einem Git-Repo</span>
              </label>
            </div>
          )}
        </fieldset>

        <fieldset className="field-group">
          <legend>Projekt</legend>
          <Field id={form.idFor('name')} label="Name" error={e.name}
            hint={slug && name ? <>Kurzname <code>{slug}</code> – die vollständige Adresse steht nach dem Anlegen auf der Projektseite.</> : 'Frei wählbar; daraus entsteht der Kurzname für die Adresse.'}>
            <input {...form.field('name', name ? `${form.idFor('name')}-hint` : undefined)} value={name} onChange={(x) => setName(x.target.value)} maxLength={120} autoComplete="off" />
          </Field>

          {kind === 'image' && (
            <Field id={form.idFor('source.image')} label="Image" error={e['source.image']} hint="Mit Tag, z.B. nginx:alpine oder ghcr.io/user/app:1.2">
              <input {...form.field('source.image', `${form.idFor('source.image')}-hint`)} value={image} onChange={(x) => setImage(x.target.value)} placeholder="ghcr.io/user/app:1.2" autoComplete="off" spellCheck={false} />
            </Field>
          )}

          {usesRepo && (
            <>
              <Field id={form.idFor('source.repoUrl')} label="Repo-URL" error={e['source.repoUrl'] ?? sourceError} hint="Nur öffentliche Repos über https:// (oder http:// im LAN).">
                <input {...form.field('source.repoUrl', `${form.idFor('source.repoUrl')}-hint`)} value={repoUrl} onChange={(x) => setRepoUrl(x.target.value)} placeholder="https://github.com/user/app.git" autoComplete="off" spellCheck={false} inputMode="url" />
              </Field>
              <Field id={form.idFor('source.ref')} label="Branch, Tag oder Commit" optional error={e['source.ref']} hint="Leer = Standard-Branch des Repos.">
                <input {...form.field('source.ref', `${form.idFor('source.ref')}-hint`)} value={ref} onChange={(x) => setRef(x.target.value)} placeholder="main" autoComplete="off" spellCheck={false} />
              </Field>
            </>
          )}

          {kind === 'dockerfile' && (
            <>
              <Field id={form.idFor('source.dockerfile')} label="Dockerfile" error={e['source.dockerfile']}>
                <input {...form.field('source.dockerfile')} value={dockerfile} onChange={(x) => setDockerfile(x.target.value)} spellCheck={false} />
              </Field>
              <Field id={form.idFor('source.context')} label="Build-Kontext" error={e['source.context']} hint="Ordner im Repo, aus dem gebaut wird; . ist die Wurzel.">
                <input {...form.field('source.context', `${form.idFor('source.context')}-hint`)} value={context} onChange={(x) => setContext(x.target.value)} spellCheck={false} />
              </Field>
            </>
          )}

          {kind === 'compose' && usesRepo && (
            <Field id={form.idFor('source.composePath')} label="Pfad der compose.yaml im Repo" error={e['source.composePath']}>
              <input {...form.field('source.composePath')} value={composePath} onChange={(x) => setComposePath(x.target.value)} spellCheck={false} />
            </Field>
          )}

          {kind === 'compose' && (
            <Field id={form.idFor('source.webService')} label="Web-Dienst" error={e['source.webService']}
              hint={<>Der Dienst, der die Besucher bekommt. Nicht erlaubt sind u.a. <code>ports</code>, <code>privileged</code> und Bind-Mounts – Dateien gehören ins Image.</>}>
              <input {...form.field('source.webService', `${form.idFor('source.webService')}-hint`)} value={webService} onChange={(x) => setWebService(x.target.value)} spellCheck={false} />
            </Field>
          )}

          {kind === 'static' && usesRepo && (
            <>
              <Field id={form.idFor('source.buildCommand')} label="Build-Befehl" optional error={e['source.buildCommand']} hint="Leer = die Dateien im Repo werden so ausgeliefert.">
                <input {...form.field('source.buildCommand', `${form.idFor('source.buildCommand')}-hint`)} value={buildCommand} onChange={(x) => setBuildCommand(x.target.value)} placeholder="npm run build" spellCheck={false} />
              </Field>
              <Field id={form.idFor('source.outputDir')} label="Ausgabeordner" optional error={e['source.outputDir']}>
                <input {...form.field('source.outputDir')} value={outputDir} onChange={(x) => setOutputDir(x.target.value)} placeholder={buildCommand ? 'dist' : '.'} spellCheck={false} />
              </Field>
            </>
          )}

          {usesUpload && (
            <Field id={form.idFor('file')} label={kind === 'compose' ? 'compose.yaml' : 'ZIP-Datei'} error={e.file}
              hint={kind === 'compose' ? 'Höchstens 256 KB. Ohne Repo gibt es kein build: und kein env_file.' : 'Höchstens 100 MB, entpackt höchstens 500 MB und 10 000 Dateien.'}>
              <input
                {...form.field('file', `${form.idFor('file')}-hint`)}
                type="file"
                accept={kind === 'compose' ? '.yaml,.yml' : '.zip,application/zip'}
                onChange={(x) => { setFile(x.target.files?.[0] ?? null); form.validateField('file') }}
              />
            </Field>
          )}

          {needsPort && (
            <div className="field-row">
              <Field id={form.idFor('port')} label="Port im Container" error={e.port} hint="Auf diesem Port lauscht die App im Container.">
                <input {...form.field('port', `${form.idFor('port')}-hint`)} inputMode="numeric" value={port} onChange={(x) => setPort(x.target.value)} />
              </Field>
              <Field id={form.idFor('healthcheckPath')} label="Pfad für den Healthcheck" error={e.healthcheckPath} hint="Muss mit 2xx oder 3xx antworten.">
                <input {...form.field('healthcheckPath', `${form.idFor('healthcheckPath')}-hint`)} value={healthcheckPath} onChange={(x) => setHealthcheckPath(x.target.value)} spellCheck={false} />
              </Field>
            </div>
          )}
        </fieldset>

        <EnvEditor rows={env} onChange={setEnv} prefix="env" errors={e} field={form.field} />

        <fieldset className="field-group">
          <legend>Erreichbarkeit</legend>
          <label className="choice">
            <input type="checkbox" checked={tailnet} onChange={(x) => setTailnet(x.target.checked)} />
            <span>
              Tailnet
              <small>Über Tailscale, im Heimnetz und unterwegs – die Hauptadresse des Servers</small>
            </span>
          </label>
          <label className="choice">
            <input type="checkbox" checked={lan} onChange={(x) => setLan(x.target.checked)} />
            <span>
              Heimnetz (LAN) ohne Tailscale
              <small>Für die eigene interne Adresse braucht es einen lokalen DNS (Router, AdGuard, Pi-hole), der sie auf die LAN-IP des Servers zeigt; sonst geht es nur über die nip.io-Adresse mit der LAN-IP, die sich ändern kann</small>
            </span>
          </label>
          {!tailnet && !lan && <p className="hint">Ohne Weg ist das Projekt nirgends erreichbar; das lässt sich später unter Einstellungen → Erreichbarkeit ändern.</p>}
          <label className="choice choice-disabled">
            <input type="checkbox" disabled />
            <span>
              Öffentlich über Cloudflare Tunnel
              <small>Erst nach dem ersten Scan, unter Einstellungen → Erreichbarkeit</small>
            </span>
          </label>
        </fieldset>

        <FormError id={form.idFor('_form')} message={error ?? e._form ?? (usesUpload ? undefined : e.source && !usesRepo ? e.source : undefined)} />

        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={busy}>
            {busy ? 'Wird angelegt…' : 'Anlegen und deployen'}
          </button>
        </div>
      </form>
    </section>
  )
}

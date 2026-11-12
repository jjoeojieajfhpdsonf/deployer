import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useEnv, useEnvPath } from '../lib/env.js'
import { slugify, createProjectSchema, normalizePublicLabel } from '@airlock/shared'
import { PublicNameField, usePublicNameCheck } from '../components/PublicNameField.js'
import type { PublicName } from '../lib/public-name.js'
import { api, ApiError } from '../api.js'
import { ChatSteps } from '../components/ChatSteps.js'
import { IconWarn } from '../components/Security.js'
import { EnvEditor, type EnvRow } from '../components/EnvEditor.js'
import { PageHead } from '../components/PageHead.js'
import { Field, FieldError, FormError } from '../components/Field.js'
import { useFormErrors, type Errors } from '../lib/form.js'
import { RepoAccessFields, useRepoAccess } from '../components/RepoAccess.js'
import { ExternalFields, emptyExternal, externalSource, useExternalProbe, type ExternalDraft } from '../components/ExternalSource.js'

type Kind = 'image' | 'dockerfile' | 'compose' | 'static' | 'existing' | 'chat'
type Origin = 'upload' | 'repo'

const KINDS: { kind: Kind; title: string; hint: string }[] = [
  // Beispiele wie in Platzhalter und Fehlermeldung des Felds (UI-Qualität 5)
  { kind: 'image', title: 'Fertiges Image', hint: 'Aus einer Registry, z.B. nginx:alpine' },
  { kind: 'dockerfile', title: 'Repo mit Dockerfile', hint: 'Wird geklont und gebaut' },
  { kind: 'compose', title: 'Docker Compose', hint: 'Mehrere Dienste, z.B. App und Datenbank' },
  { kind: 'static', title: 'Statische Seite', hint: 'ZIP oder Repo, optional mit Build-Befehl' },
  { kind: 'existing', title: 'Bestehender Dienst', hint: 'Läuft schon – Airlock macht ihn nur erreichbar' },
  { kind: 'chat', title: 'Per Chat', hint: 'Claude legt das Projekt über den MCP-Server an' },
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
  chat: { kind: 'chat', origin: 'upload' },
  bestehend: { kind: 'existing', origin: 'upload' },
}

/** Vorschau von Kurzname und Adresse, 300 ms nach der letzten Eingabe */
function useNamePreview(name: string) {
  const [debounced, setDebounced] = useState(name)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(name.trim()), 300)
    return () => clearTimeout(t)
  }, [name])
  return useQuery({
    queryKey: ['name-preview', debounced],
    queryFn: () => api.namePreview(debounced),
    // slugify fällt nie auf leer zurück («???» → «projekt», wie beim Anlegen); geprüft wird nur der leere Name
    enabled: debounced !== '',
    // Kurz frisch halten: ein anderes Projekt (z.B. von Claude) kann den Namen inzwischen belegen
    staleTime: 2_000,
    placeholderData: (prev) => prev,
  })
}

/**
 * Unter dem Namen: Kurzname, Adresse, und ob der Kurzname schon belegt ist.
 * Der Hinweis selbst ist keine Live-Region (er gehört per aria-describedby zum
 * Feld); angesagt wird nur eine Kollision, in einer eigenen, immer
 * vorhandenen Region.
 */
function NamePreview({ name, id }: { name: string; id: string }) {
  const q = useNamePreview(name)
  // Solange die Antwort zum alten Namen gehört: nicht als Ergebnis zeigen
  const p = q.isPlaceholderData || q.data?.preview.wanted !== slugify(name.trim()) ? null : q.data?.preview
  const conflict = p && (p.takenBy || p.reserved || p.hostTaken)
  const said = !p ? '' : p.reserved ? `Kurzname ${p.wanted} ist reserviert, das Projekt bekommt ${p.slug}.`
    : p.takenBy ? `Kurzname ${p.wanted} hat schon ${p.takenBy.name}, das Projekt bekommt ${p.slug}.`
    : p.hostTaken ? `Die Adresse von ${p.wanted} ist schon belegt, das Projekt bekommt ${p.slug}.` : ''
  const url = p?.urls[0]
  return (
    <>
      <p className="sr-only" role="status">{said}</p>
      {!name.trim() ? <p className="hint" id={id}>Frei wählbar; daraus entstehen Kurzname und Adresse.</p>
        : !p ? <p className="hint" id={id}>Kurzname <code>{slugify(name)}</code> …</p>
        : (
          <div className="hint name-preview" id={id}>
            {conflict ? (
              <p>
                <IconWarn /> {p.reserved
                  ? <>Der Kurzname <code>{p.wanted}</code> ist für Airlock reserviert.</>
                  : p.takenBy ? <>Den Kurznamen <code>{p.wanted}</code> hat schon <Link to={`/projekte/${p.takenBy.id}`}>{p.takenBy.name}</Link>.</>
                  : <>Die Adresse von <code>{p.wanted}</code> trägt schon ein anderes Projekt.</>}
                {' '}{p.slug ? <>Dieses Projekt bekommt <code>{p.slug}</code> – oder wähle einen anderen Namen.</> : 'Wähle einen anderen Namen.'}
              </p>
            ) : (
              <p>Kurzname <code>{p.slug}</code></p>
            )}
            {url && <p>Adresse <code>{url.replace(/^https?:\/\//, '')}</code>{p.urls.length > 1 && <span className="muted"> · auch {p.urls.slice(1).map((u) => u.replace(/^https?:\/\//, '')).join(', ')}</span>}</p>}
          </div>
        )}
    </>
  )
}

export function NewProject() {
  const navigate = useNavigate()
  const ep = useEnvPath()
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

  // Öffentlich nach dem ersten Scan: Name + Domain der Umgebung; der Name folgt dem Kurznamen, bis jemand ihn ändert
  const { env: currentEnv } = useEnv()
  const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
  const zones = domains.data?.domains.map((d) => d.name) ?? []
  const mainZone = (currentEnv?.zone && zones.includes(currentEnv.zone) ? currentEnv.zone : null) ?? domains.data?.domains.find((d) => d.isDefault)?.name ?? zones[0] ?? ''
  const canPublish = Boolean(domains.data?.publicEnabled) && zones.length > 0
  const [pub, setPub] = useState(false)
  const [pubDraft, setPubDraft] = useState<PublicName & { touched: boolean }>({ label: '', zone: '', apex: false, touched: false })
  const [pubAccess, setPubAccess] = useState<boolean | null>(null)
  const pubName: PublicName = { label: pubDraft.touched ? pubDraft.label : slug, zone: pubDraft.zone || mainZone, apex: pubDraft.apex }
  const access = pubAccess ?? Boolean(currentEnv?.accessDefault)
  const pubCheck = usePublicNameCheck({ projectId: null, name: pubName, enabled: pub && canPublish && kind !== 'chat', takeOver: false, canTakeOver: false })
  // Bestehender Dienst: Ziel, Erreichbarkeit und Zugang; kein Deploy, keine Variablen
  const existing = kind === 'existing'
  const [ext, setExt] = useState<ExternalDraft>(emptyExternal)
  const extProbe = useExternalProbe(ext)
  const [ackUnreachable, setAckUnreachable] = useState(false)
  useEffect(() => setAckUnreachable(false), [ext.container, ext.port, ext.url, ext.mode, ext.insecureTls])
  const needsPort = kind !== 'static' && !existing
  const usesUpload = (kind === 'static' || kind === 'compose') && origin === 'upload'
  const usesRepo = kind === 'dockerfile' || ((kind === 'static' || kind === 'compose') && origin === 'repo')
  // Nacht 3, Etappe 2: Zugang zum Repo (GitHub-App/öffentlich, Deploy-Key, Token) und «Repo prüfen»
  const repoAccess = useRepoAccess(repoUrl, ref)
  const accessRef = useRef<HTMLFieldSetElement>(null)

  /** Eingaben in der Form, die die API erwartet – geprüft mit demselben Schema. */
  function payload(uploadId?: string) {
    const r = opt(ref)
    const source =
      existing ? externalSource(ext)
      : kind === 'image' ? { type: 'image', image }
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
      // Nacht 3, Etappe 2: Deploy-Key oder Token (eben erzeugt) geht mit
      ...(usesRepo && repoAccess.credentialId ? { gitCredentialId: repoAccess.credentialId } : {}),
      ...(needsPort ? { port: port.trim() === '' ? undefined : Number(port) } : {}),
      healthcheckPath,
      env: existing ? [] : env.map((x) => ({ key: x.key, value: x.value, isSecret: x.isSecret })),
      targets: [...(tailnet ? ['tailnet' as const] : []), ...(lan ? ['lan' as const] : [])],
      deploy: !existing,
      ...(existing && ext.login ? { accessGuard: 'login' as const } : {}),
      ...(pub && canPublish ? {
        public: {
          ...(pubName.apex ? { apex: true } : { subdomain: normalizePublicLabel(pubName.label) }),
          zone: pubName.zone, accessProtected: access,
        },
      } : {}),
    }
  }

  const form = useFormErrors({
    schema: createProjectSchema,
    values: () => payload(file ? PENDING_UPLOAD : undefined),
    extra: (): Errors => {
      // Die Prüfung beim Tippen fand ein Hindernis: nicht anlegen (der Grund steht unter dem Feld)
      const pubErr: Errors = pub && canPublish && pubCheck.blocking && pubCheck.verdict.tone === 'bad'
        ? { 'public.subdomain': `Wähle eine andere Adresse: ${pubCheck.verdict.word}` } : {}
      if (!usesUpload) return pubErr
      return { ...pubErr, ...fileErrors() }
    },
  })
  function fileErrors(): Errors {
    if (!file) return { file: kind === 'compose' ? 'Wähle deine compose.yaml aus' : 'Wähle das ZIP mit den Dateien der Seite aus, z.B. dist.zip' }
    if (kind === 'compose' && file.size > MAX_COMPOSE) return { file: `Die Datei ist ${Math.ceil(file.size / 1024)} KB gross; eine compose.yaml darf höchstens 256 KB haben` }
    if (kind === 'static' && file.size > MAX_ZIP) return { file: `Das ZIP ist ${Math.ceil(file.size / 1024 / 1024)} MB gross; höchstens 100 MB` }
    if (kind === 'static' && !/\.zip$/i.test(file.name)) return { file: 'Wähle eine ZIP-Datei (.zip) aus' }
    return {}
  }
  const e = form.errors
  // Deploy-Key erzeugt oder Zugang gewechselt: die Meldung «SSH braucht einen Deploy-Key» am Feld neu prüfen
  const repoUrlError = Boolean(e['source.repoUrl'])
  useEffect(() => {
    if (repoUrlError) form.validateField('source.repoUrl')
  }, [repoAccess.credentialId]) // eslint-disable-line react-hooks/exhaustive-deps
  const showPreview = !e.name || name.trim() !== ''
  // «Upload oder Repo» meldet das Schema auf "source"; beim Hochladen gehört die Meldung zum Dateifeld.
  const sourceError = usesUpload ? undefined : e.source

  async function submit(ev: FormEvent) {
    ev.preventDefault()
    setError(null)
    if (!form.validateAll()) return
    // Bestehender Dienst: vor dem Anlegen die Erreichbarkeit prüfen und zeigen; nicht erreichbar → nachfragen
    if (existing && !ackUnreachable) {
      const r = extProbe.current ?? (await extProbe.run())
      if (!r?.ok) {
        setAckUnreachable(true)
        setError('Das Ziel antwortet gerade nicht (Ergebnis oben). Trotzdem anlegen? Die Adresse zeigt dann die Fehlermeldung von Caddy, bis der Dienst antwortet.')
        return
      }
    }
    setBusy(true)
    // Repo erreichbar? Vor dem Anlegen, mit Meldung und Weg im Abschnitt «Zugang»
    if (usesRepo && !(await repoAccess.ensureOk())) {
      setBusy(false)
      accessRef.current?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
      accessRef.current?.querySelector<HTMLElement>('.repo-access-check button')?.focus({ preventScroll: true })
      return
    }
    try {
      const uploadId = usesUpload && file ? (await api.upload(file)).upload.id : undefined
      const { project, deployment } = await api.createProject(payload(uploadId))
      // UI-Qualität 5: auf der Projektseite läuft gleich der Fortschritt des ersten Deploys
      navigate(ep(`/projekte/${project.id}`), { state: deployment ? { watch: deployment.id } : undefined })
    } catch (err) {
      // Prüft die API anders als erwartet, landet ihre Meldung trotzdem am Feld.
      if (!form.setServerErrors(err)) setError(err instanceof ApiError ? err.message : (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page page-narrow">
      <PageHead crumbs={[{ label: 'Projekte', to: ep('/projekte') }, { label: 'Neues Projekt' }]} title="Neues Projekt">
        {/* Bei «Per Chat» steht dasselbe im Abschnitt darunter */}
        {kind !== 'chat' && <p className="lede">Aus dem Chat geht es ohne Formular: Claude legt Projekte über MCP direkt an.</p>}
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

        {kind === 'chat' ? (
          <section className="field-group chat-source" aria-labelledby="chat-source-h">
            <h2 id="chat-source-h" className="legend">Per Chat</h2>
            <p className="hint">Ohne Formular: Claude legt das Projekt über den MCP-Server von Airlock an und deployt es. Einmal einrichten:</p>
            <ChatSteps />
            <div className="form-actions">
              <Link className="button button-primary" to={ep('/einstellungen/tokens?neu=1')}>Token anlegen</Link>
            </div>
          </section>
        ) : (<>
        <fieldset className="field-group">
          <legend>Projekt</legend>
          {/* Vorschau statt Hinweis: Kurzname, Adresse, Kollision (UI-Qualität 5) */}
          <div className={e.name ? 'field field-invalid' : 'field'}>
            <label htmlFor={form.idFor('name')}>Name</label>
            <input {...form.field('name', showPreview ? `${form.idFor('name')}-hint` : undefined)} value={name} onChange={(x) => setName(x.target.value)} maxLength={120} autoComplete="off" placeholder="Solarertrag heute" />
            {e.name && <FieldError id={form.idFor('name')} message={e.name} />}
            {/* Wie bei den anderen Feldern: bei einer Meldung kein allgemeiner Hinweis; die Vorschau bleibt, sobald es einen Namen gibt */}
            {showPreview && <NamePreview name={name} id={`${form.idFor('name')}-hint`} />}
          </div>

          {existing && <ExternalFields d={ext} onChange={setExt} errors={e} probe={extProbe} idFor={form.idFor} />}

          {kind === 'image' && (
            <Field id={form.idFor('source.image')} label="Image" error={e['source.image']} hint="Mit Tag, z.B. nginx:alpine oder ghcr.io/user/app:1.2">
              <input {...form.field('source.image', `${form.idFor('source.image')}-hint`)} value={image} onChange={(x) => setImage(x.target.value)} placeholder="nginx:alpine" autoComplete="off" spellCheck={false} />
            </Field>
          )}

          {usesRepo && (
            <>
              <Field id={form.idFor('source.repoUrl')} label="Repo-URL" error={e['source.repoUrl'] ?? sourceError} hint="https:// (http:// im LAN) oder für einen Deploy-Key die SSH-Adresse, z.B. git@gitlab.com:user/app.git.">
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

        {usesRepo && <RepoAccessFields a={repoAccess} repoUrl={repoUrl} sectionRef={accessRef} />}

        {!existing && <EnvEditor rows={env} onChange={setEnv} prefix="env" errors={e} field={form.field} />}

        <fieldset className="field-group">
          <legend>Erreichbarkeit</legend>
          <label className="choice">
            <input type="checkbox" checked={tailnet} onChange={(x) => setTailnet(x.target.checked)} />
            <span>
              Tailnet
              <small>Im Heimnetz und unterwegs – die Hauptadresse des Servers</small>
            </span>
          </label>
          <label className="choice">
            <input type="checkbox" checked={lan} onChange={(x) => setLan(x.target.checked)} />
            <span>
              Heimnetz (LAN) ohne Tailnet
              <small>Für die eigene interne Adresse braucht es einen lokalen DNS (Router, AdGuard, Pi-hole), der sie auf die LAN-IP des Servers zeigt; sonst geht es nur über die nip.io-Adresse mit der LAN-IP, die sich ändern kann</small>
            </span>
          </label>
          {!tailnet && !lan && <p className="hint">Ohne Weg ist das Projekt nirgends erreichbar; das lässt sich später unter Einstellungen → Erreichbarkeit ändern.</p>}
          {canPublish ? (
            <>
              <label className="choice">
                <input type="checkbox" checked={pub} onChange={(x) => { setPub(x.target.checked); form.validateField('public.subdomain') }} />
                <span>
                  Öffentlich über Cloudflare Tunnel
                  <small>Nach dem ersten Scan ohne kritischen Befund automatisch; bis dahin nur intern erreichbar</small>
                </span>
              </label>
              {pub && (
                <div className="public-options">
                  <PublicNameField inputId={form.idFor('public.subdomain')} label="Öffentliche Adresse" zones={zones} value={pubName} result={pubCheck}
                    onChange={(n) => setPubDraft({ ...n, touched: true })}
                    takeOver={false} onTakeOver={() => {}} canTakeOver={false}
                    error={e['public.subdomain'] ?? e['public.zone']} placeholder={slug}
                    onBlur={() => form.validateField('public.subdomain')} />
                  <label className="choice">
                    <input type="checkbox" checked={access} onChange={(x) => setPubAccess(x.target.checked)} />
                    <span>Cloudflare Access <small>nur nach Anmeldung per E-Mail-Code</small></span>
                  </label>
                </div>
              )}
            </>
          ) : (
            <label className="choice choice-disabled">
              <input type="checkbox" disabled />
              <span>
                Öffentlich über Cloudflare Tunnel
                <small>{domains.data && !domains.data.publicEnabled
                  ? 'In dieser Umgebung nicht eingerichtet: Einstellungen → Cloudflare & HTTPS'
                  : 'Erst nach dem ersten Scan, unter Einstellungen → Erreichbarkeit'}</small>
              </span>
            </label>
          )}
        </fieldset>

        <FormError id={form.idFor('_form')} message={error ?? e._form ?? (usesUpload ? undefined : e.source && !usesRepo ? e.source : undefined)} />

        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={busy || extProbe.p.state === 'busy'} aria-busy={busy || extProbe.p.state === 'busy' || undefined}>
            {existing ? (ackUnreachable ? 'Trotzdem anlegen' : 'Prüfen und anlegen') : 'Anlegen und deployen'}
          </button>
        </div>
        </>)}
      </form>
    </section>
  )
}

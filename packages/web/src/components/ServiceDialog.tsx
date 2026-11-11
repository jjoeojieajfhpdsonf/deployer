import { useEffect, useId, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  SERVICE_TEMPLATES, serviceTemplate,
  type ProjectDto, type ServiceChangeDto, type ServiceChangeInput, type ServicePlanDto, type ServiceTemplateId, type TopologyDto,
} from '@airlock/shared'
import { api } from '../api.js'
import { apiFieldErrors, type Errors } from '../lib/form.js'
import { Modal } from './Modal.js'
import { ConfirmDialog } from './Confirm.js'
import { Field, FormError } from './Field.js'
import { Diff } from './ClaudeFix.js'
import { Loading, SkLines } from './States.js'

/**
 * Etappe 4 «+ Dienst» und «Dienst entfernen» im Aufbau. Zwei Schritte:
 * erst fragen (Vorlage, Name, Version, Volume, wer sich verbinden darf),
 * dann die Änderung an der compose.yaml als Diff mit den Variablen, die
 * Airlock anlegt (nur Namen – Passwörter erzeugt der Server und zeigt sie
 * nie) → «Übernehmen & deployen» bzw. bei Git-Projekten «Pull Request
 * anlegen». Entfernen: Bestätigung durch Eintippen des Namens, Volume
 * standardmässig behalten.
 */

interface Form {
  template: ServiceTemplateId
  name: string
  version: string
  volume: boolean
  connect: string[]
  connectionVar: string
  image: string
  port: string
  volumePath: string
}

/** Freier Name: «db», sonst «db-2», «db-3» … */
function freeName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`
}

function initial(id: ServiceTemplateId, t: TopologyDto): Form {
  const tpl = serviceTemplate(id)
  const web = t.edit?.webService ?? t.services.find((s) => s.web)?.name ?? null
  return {
    template: id,
    name: freeName(tpl.name, t.services.map((s) => s.name)),
    version: tpl.versions[0] ?? '',
    volume: tpl.volumeDefault,
    connect: tpl.connection.length && web ? [web] : [],
    connectionVar: tpl.connection[0]?.key ?? '',
    image: '',
    port: '',
    volumePath: '',
  }
}

function toInput(f: Form): ServiceChangeInput {
  const tpl = serviceTemplate(f.template)
  return {
    action: 'add',
    template: f.template,
    name: f.name.trim(),
    ...(tpl.image && f.version.trim() ? { version: f.version.trim() } : {}),
    volume: tpl.volume && f.volume,
    connect: tpl.connection.length ? f.connect : [],
    ...(tpl.connection.length && f.connectionVar.trim() ? { connectionVar: f.connectionVar.trim() } : {}),
    ...(f.template === 'custom' ? {
      image: f.image.trim(),
      ...(f.port.trim() ? { port: Number(f.port) } : {}),
      ...(f.volume && f.volumePath.trim() ? { volumePath: f.volumePath.trim() } : {}),
    } : {}),
  }
}

const wayLabel = (plan: ServicePlanDto | undefined, kind: 'add' | 'remove') =>
  plan?.way === 'pull_request' ? 'Pull Request anlegen' : kind === 'add' ? 'Übernehmen & deployen' : 'Entfernen & deployen'

export function AddServiceDialog({ p, t, open, onClose, onDone }: {
  p: ProjectDto; t: TopologyDto; open: boolean; onClose: () => void; onDone: (c: ServiceChangeDto) => void
}) {
  const titleId = useId()
  const ids = { name: useId(), version: useId(), image: useId(), port: useId(), path: useId(), conn: useId(), list: useId() }
  const [form, setForm] = useState<Form>(() => initial('postgres', t))
  const [step, setStep] = useState<'form' | 'review'>('form')
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState<string | undefined>()
  const qc = useQueryClient()

  useEffect(() => {
    if (!open) return
    setForm(initial('postgres', t))
    setStep('form')
    setErrors({})
    setFormError(undefined)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const tpl = serviceTemplate(form.template)
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))
  const apps = t.services.filter((s) => !s.database)

  const plan = useMutation({
    mutationFn: () => api.servicePlan(p.id, toInput(form)),
    onSuccess: () => { setErrors({}); setFormError(undefined); setStep('review') },
    onError: (e) => {
      const fe = apiFieldErrors(e)
      setErrors(fe)
      setFormError(Object.keys(fe).length ? undefined : (e as Error).message)
    },
  })
  const apply = useMutation({
    mutationFn: () => api.serviceApply(p.id, toInput(form), plan.data!.plan.base),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['topology', p.id] })
      void qc.invalidateQueries({ queryKey: ['project', p.id] })
      onDone(r.change)
    },
  })
  const busy = plan.isPending || apply.isPending
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!busy) plan.mutate()
  }
  const pick = (id: ServiceTemplateId) => {
    setForm(initial(id, t))
    setErrors({})
    setFormError(undefined)
  }
  const err = (k: string) => errors[k]
  const described = (id: string, k: string) => (err(k) ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-error` } : {})

  const reviewPlan = plan.data?.plan
  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} busy={busy} wide initialFocus={step === 'form' ? 'input[name="svc-template"]:checked' : '.svc-review-actions .button-primary'}>
      {step === 'form' ? (
        <form className="svc-form" noValidate onSubmit={submit}>
          <h2 id={titleId}>Dienst hinzufügen</h2>
          <p className="dialog-lede">Airlock trägt den Dienst in die compose.yaml ein. Du siehst die Änderung, bevor etwas passiert.</p>
          <fieldset className="svc-templates">
            <legend>Vorlage</legend>
            {SERVICE_TEMPLATES.map((x) => (
              <label key={x.id} className={`svc-template${form.template === x.id ? ' svc-template-on' : ''}`}>
                <input type="radio" name="svc-template" value={x.id} checked={form.template === x.id} onChange={() => pick(x.id)} />
                <span><strong>{x.label}</strong><small>{x.about}</small></span>
              </label>
            ))}
          </fieldset>

          <div className="field-row">
            <Field id={ids.name} label="Name des Dienstes" error={err('name')} hint="So heisst er im Projekt-Netz, z. B. für die Verbindung.">
              <input id={ids.name} value={form.name} onChange={(e) => set({ name: e.target.value })} autoComplete="off" spellCheck={false} {...described(ids.name, 'name')} />
            </Field>
            {tpl.image ? (
              <Field id={ids.version} label="Version" error={err('version')} hint={`Tag von ${tpl.image}`}>
                <input id={ids.version} value={form.version} list={ids.list} onChange={(e) => set({ version: e.target.value })} autoComplete="off" spellCheck={false} {...described(ids.version, 'version')} />
                <datalist id={ids.list}>{tpl.versions.map((v) => <option key={v} value={v} />)}</datalist>
              </Field>
            ) : (
              <Field id={ids.image} label="Image" error={err('image')} hint="Mit Tag, z. B. ghcr.io/me/worker:1.4">
                <input id={ids.image} value={form.image} onChange={(e) => set({ image: e.target.value })} autoComplete="off" spellCheck={false} {...described(ids.image, 'image')} />
              </Field>
            )}
          </div>
          {form.template === 'custom' && (
            <Field id={ids.port} label="Port im Container" optional error={err('port')} hint="Nur im Projekt-Netz erreichbar; nach aussen geht es über den Web-Dienst.">
              <input id={ids.port} inputMode="numeric" value={form.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })} className="svc-port" {...described(ids.port, 'port')} />
            </Field>
          )}

          {tpl.volume && (
            <label className="choice">
              <input type="checkbox" checked={form.volume} onChange={(e) => set({ volume: e.target.checked })} />
              <span>Daten in einem Volume behalten <small>Volume «{form.name.trim() || tpl.name}-data» – bleibt bei Deploys und Neustarts erhalten.</small></span>
            </label>
          )}
          {err('volume') && <p className="field-error">{err('volume')}</p>}
          {form.template === 'custom' && form.volume && (
            <Field id={ids.path} label="Pfad der Daten im Container" error={err('volumePath')}>
              <input id={ids.path} value={form.volumePath} placeholder="/data" onChange={(e) => set({ volumePath: e.target.value })} autoComplete="off" spellCheck={false} {...described(ids.path, 'volumePath')} />
            </Field>
          )}

          {tpl.connection.length > 0 && apps.length > 0 && (
            <fieldset className="svc-connect">
              <legend>Wer darf sich verbinden?</legend>
              <p className="hint">Diese Dienste bekommen {tpl.connection.length > 1 ? 'die Variablen' : 'die Variable'} {tpl.connection.map((c) => c.key).join(', ')} und starten nach {form.name.trim() || tpl.name}.</p>
              {apps.map((s) => (
                <label key={s.id} className="choice">
                  <input type="checkbox" checked={form.connect.includes(s.name)} onChange={(e) => set({ connect: e.target.checked ? [...form.connect, s.name] : form.connect.filter((x) => x !== s.name) })} />
                  <span>{s.name}{s.web ? <small>Web-Dienst – bekommt alle Variablen des Projekts</small> : null}</span>
                </label>
              ))}
              {err('connect') && <p className="field-error">{err('connect')}</p>}
              {form.connect.length > 0 && (
                <Field id={ids.conn} label="Name der Variable für die Verbindung" error={err('connectionVar')}>
                  <input id={ids.conn} value={form.connectionVar} onChange={(e) => set({ connectionVar: e.target.value })} autoComplete="off" spellCheck={false} className="svc-var" {...described(ids.conn, 'connectionVar')} />
                </Field>
              )}
            </fieldset>
          )}
          {tpl.internalUi && (
            <p className="hint svc-internal">Die Oberfläche bekommt eine eigene Adresse, nur über die internen Wege des Projekts (LAN, Tailnet) – nie öffentlich.</p>
          )}

          <FormError id={`${titleId}-err`} message={formError} />
          <div className="dialog-actions">
            <button type="button" onClick={onClose} disabled={busy}>Abbrechen</button>
            <button type="submit" className="button-primary" disabled={busy} aria-busy={plan.isPending || undefined}>Weiter: Änderung ansehen</button>
          </div>
        </form>
      ) : reviewPlan ? (
        <div className="svc-review">
          <h2 id={titleId}>Änderung an {reviewPlan.composePath}</h2>
          <ReviewBody plan={reviewPlan} kind="add" />
          {apply.isError && <p className="error" role="alert">{(apply.error as Error).message}</p>}
          <div className="dialog-actions svc-review-actions">
            <button type="button" onClick={() => setStep('form')} disabled={busy}>Zurück</button>
            <button type="button" className="button-primary" disabled={busy} aria-busy={apply.isPending || undefined} onClick={() => apply.mutate()}>{wayLabel(reviewPlan, 'add')}</button>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

/** Diff, Variablen und Hinweise einer Vorschau */
function ReviewBody({ plan, kind }: { plan: ServicePlanDto; kind: 'add' | 'remove' }) {
  return (
    <>
      <p className="dialog-lede">
        {plan.way === 'pull_request'
          ? <>Airlock legt einen eigenen Branch und einen Pull Request auf <code>{plan.branch}</code> an – nie direkt in den Hauptbranch. Nach dem Merge deployt Airlock, wenn Auto-Deploy an ist.</>
          : kind === 'add' ? 'Airlock speichert die neue Fassung und deployt das Projekt.' : 'Airlock speichert die neue Fassung und deployt; der Container des Dienstes wird entfernt.'}
      </p>
      <Diff text={plan.diff} />
      {plan.variables.length > 0 && (
        <>
          <h3 className="svc-sub">Umgebungsvariablen</h3>
          <ul className="svc-vars">
            {plan.variables.map((v) => (
              <li key={v.key}>
                <code>{v.key}</code>
                <span className="svc-var-tags">
                  <span className="svc-tag">{v.secret ? 'geheim' : 'sichtbar'}</span>
                  <span className="svc-tag">{v.state === 'new' ? (v.secret && v.key.endsWith('PASSWORD') ? 'wird erzeugt' : 'neu') : 'vorhanden, bleibt'}</span>
                </span>
                <small>{v.purpose}</small>
              </li>
            ))}
          </ul>
        </>
      )}
      {plan.notes.length > 0 && <ul className="svc-notes">{plan.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
    </>
  )
}

export function RemoveServiceDialog({ p, service, open, way, onClose, onDone }: {
  p: ProjectDto; service: string; open: boolean; way: 'deploy' | 'pull_request'; onClose: () => void; onDone: (c: ServiceChangeDto) => void
}) {
  const [drop, setDrop] = useState(false)
  const qc = useQueryClient()
  useEffect(() => { if (open) setDrop(false) }, [open])
  const change: ServiceChangeInput = { action: 'remove', name: service, dropVolume: drop }
  const plan = useQuery({
    queryKey: ['service-plan', p.id, service, drop],
    queryFn: () => api.servicePlan(p.id, change),
    enabled: open,
    retry: false,
  })
  const apply = useMutation({
    mutationFn: () => api.serviceApply(p.id, change, plan.data!.plan.base),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['topology', p.id] })
      onDone(r.change)
    },
  })
  const pl = plan.data?.plan
  const volumes = pl?.volumes ?? []
  return (
    <ConfirmDialog
      open={open}
      title={`Dienst «${service}» entfernen?`}
      confirmLabel={wayLabel(pl, 'remove')}
      busy={apply.isPending || plan.isFetching}
      error={apply.isError ? (apply.error as Error).message : plan.isError ? (plan.error as Error).message : undefined}
      onConfirm={() => { if (pl) apply.mutate() }}
      onCancel={onClose}
      typeToConfirm={{ value: service, label: 'Zum Bestätigen den Namen des Dienstes eintippen' }}
    >
      <p>Der Dienst kommt aus der compose.yaml; {way === 'pull_request' ? 'nach dem Merge' : 'beim Deploy'} wird sein Container entfernt.</p>
      {volumes.length > 0 && (way === 'pull_request' ? (
        <p>{volumes.length > 1 ? 'Die Volumes' : 'Das Volume'} {volumes.map((v) => `«${v}»`).join(', ')} {volumes.length > 1 ? 'bleiben' : 'bleibt'} mit allen Daten erhalten – bei Git-Projekten löscht Airlock keine Daten auf Grund eines Merges.</p>
      ) : (
        <label className="choice">
          <input type="checkbox" checked={drop} onChange={(e) => setDrop(e.target.checked)} />
          <span>
            Auch {volumes.length > 1 ? 'die Volumes' : 'das Volume'} {volumes.map((v) => `«${v}»`).join(', ')} löschen
            <small>Ohne Haken bleiben die Daten erhalten. Mit Haken sind sie nach dem Deploy weg.</small>
          </span>
        </label>
      ))}
      {pl ? (
        <details className="svc-details">
          <summary>Änderung ansehen</summary>
          <ReviewBody plan={pl} kind="remove" />
        </details>
      ) : !plan.isError ? <Loading label="Änderung wird berechnet"><SkLines n={2} /></Loading> : null}
    </ConfirmDialog>
  )
}

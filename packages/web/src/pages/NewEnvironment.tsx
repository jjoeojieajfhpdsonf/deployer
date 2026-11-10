import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { createEnvironmentSchema, slugify, type CfTokenCheckDto } from '@airlock/shared'
import { api, ApiError, type CfStatusDto } from '../api.js'
import { PageHead } from '../components/PageHead.js'
import { Field } from '../components/Field.js'
import { Step, TokenStep, CheckResult, DomainsStep, TunnelStep, TunnelSummary, TlsStep, CertSummary, type StepState } from '../components/CloudflareSetup.js'
import { useEnv, useEnvPath, useEnvironments } from '../lib/env.js'
import { copyText } from '../lib/clipboard.js'

/**
 * M9: Assistent «Umgebung anlegen» in den sieben Schritten der SPEC:
 * 1 Name und Kürzel · 2 Cloudflare (Token mitbenutzen oder eigenes) ·
 * 3 Hauptzone und Präfix · 4 Tailnet und lokaler DNS · 5 Zertifikat ·
 * 6 Tunnel · 7 Standards. Schritt 1 legt die Umgebung an (/umgebungen/neu);
 * die übrigen laufen in ihr (/u/<slug>/einrichtung), mit den Bausteinen von
 * «Cloudflare verbinden».
 */

const TITLES = ['Name und Kürzel', 'Cloudflare', 'Hauptzone und Präfix', 'Tailnet und lokaler DNS', 'Zertifikat', 'Tunnel', 'Standards']

/** Schritt 1: auf /umgebungen/neu, legt die Umgebung an. */
export function NewEnvironment() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [short, setShort] = useState('')
  const [shortTouched, setShortTouched] = useState(false)
  const autoSlug = slugTouched ? slug : slugify(name).slice(0, 40)
  const autoShort = shortTouched ? short : name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const create = useMutation({
    mutationFn: () => api.createEnvironment({ name: name.trim(), slug: autoSlug, short: autoShort }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['environments'] })
      navigate(`/u/${r.environment.slug}/einrichtung`)
    },
    onError: (err) => {
      const details = err instanceof ApiError ? (err.details as { path: string; message: string }[] | undefined) : undefined
      if (details?.length) setErrors(Object.fromEntries(details.map((d) => [d.path, d.message])))
    },
  })
  const submit = () => {
    const r = createEnvironmentSchema.safeParse({ name, slug: autoSlug, short: autoShort })
    if (!r.success) {
      setErrors(Object.fromEntries(r.error.issues.map((i) => [String(i.path[0]), i.message])))
      return
    }
    setErrors({})
    create.mutate()
  }

  return (
    <section className="page page-medium">
      <PageHead crumbs={[{ label: 'umgebungen', to: '/umgebungen' }, { label: 'neu' }]} title="Umgebung anlegen" />
      <p className="lede lede-tight">Eine Umgebung ist eine eigene Domain mit internen Adressen, Zertifikat, Tokens und Standards – auf demselben Server.</p>
      <ol className="cf-steps">
        <Step n={1} title={TITLES[0]!} state="current">
          <form noValidate onSubmit={(e) => { e.preventDefault(); submit() }}>
            <div className="field-row">
              <Field id="ne-name" label="Name" error={errors.name} hint="Zum Beispiel die Domain oder wofür die Umgebung da ist.">
                <input id="ne-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus aria-invalid={Boolean(errors.name)} />
              </Field>
              <Field id="ne-short" label="Kürzel" error={errors.short} hint="Zwei Zeichen, im Umschalter oben links.">
                <input id="ne-short" className="input-short" value={autoShort} onChange={(e) => { setShortTouched(true); setShort(e.target.value.slice(0, 2)) }} maxLength={2} aria-invalid={Boolean(errors.short)} />
              </Field>
            </div>
            <Field id="ne-slug" label="Kurzname in der Adresse" error={errors.slug} hint={<>Die Umgebung heisst in Airlock <code>/u/{autoSlug || '…'}</code>.</>}>
              <input id="ne-slug" value={autoSlug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value) }} spellCheck={false} autoComplete="off" aria-invalid={Boolean(errors.slug)} />
            </Field>
            <div className="form-actions">
              <button type="submit" className="button-primary" disabled={create.isPending}>{create.isPending ? 'Wird angelegt…' : 'Anlegen und weiter'}</button>
              <Link className="button" to="/umgebungen">Abbrechen</Link>
            </div>
            {create.isError && !Object.keys(errors).length && <p role="alert" className="error">{(create.error as Error).message}</p>}
          </form>
        </Step>
        {TITLES.slice(1).map((t, i) => <Step key={t} n={i + 2} title={t} state="locked" />)}
      </ol>
    </section>
  )
}

/** Schritte 2–7: in der neuen Umgebung (/u/<slug>/einrichtung). */
export function EnvironmentSetup() {
  const { env, envs } = useEnv()
  const ep = useEnvPath()
  const navigate = useNavigate()
  const qc = useQueryClient()
  useEnvironments()
  const status = useQuery({
    queryKey: ['cloudflare'],
    queryFn: api.cloudflare,
    refetchInterval: (q) => (q.state.data?.tls.phase === 'staging' || q.state.data?.tls.phase === 'production' ? 3_000 : 20_000),
  })
  const [check, setCheck] = useState<CfTokenCheckDto | null>(null)
  const [dnsSeen, setDnsSeen] = useState(false)
  const [tlsLater, setTlsLater] = useState(false)
  const set = (s: CfStatusDto) => {
    qc.setQueryData(['cloudflare'], s)
    void qc.invalidateQueries({ queryKey: ['environments'] })
  }
  if (!env) return null
  if (status.isLoading || !status.data) return <p className="state state-loading">Wird geladen…</p>
  const s = status.data

  const hasToken = s.token.present
  const hasZone = Boolean(s.baseDomain)
  const tlsDone = s.tls.phase === 'done' || tlsLater
  const tunnelDone = Boolean(s.tunnel) || s.tunnelSkipped
  const states: StepState[] = []
  const order = [hasToken, hasZone, dnsSeen, tlsDone, tunnelDone]
  let reached = true
  for (const done of order) {
    states.push(done && reached ? 'done' : reached ? 'current' : 'locked')
    if (!done) reached = false
  }
  const standardsState: StepState = reached ? 'current' : 'locked'

  return (
    <section className="page page-medium">
      <PageHead crumbs={[{ label: 'einrichtung' }]} title={`${env.name} einrichten`} />
      <p className="lede lede-tight">Die Umgebung ist angelegt. Die Schritte lassen sich auch später unter Einstellungen erledigen.</p>
      <ol className="cf-steps">
        <Step n={1} title={TITLES[0]!} state="done" summary={<>{env.name} · Kürzel {env.short} · <code>/u/{env.slug}</code></>} />
        <Step n={2} title={TITLES[1]!} state={states[0]!} summary={<>{env.account?.sharedWith.length ? `Token geteilt mit ${env.account.sharedWith.join(', ')}` : 'Eigenes Token'} · Konto {s.account?.name ?? s.account?.id}</>}>
          <CloudflareChoice s={s} others={envs.filter((e) => e.id !== env.id && e.account)} onDone={set} onChecked={setCheck} check={check} />
        </Step>
        <Step n={3} title={TITLES[2]!} state={states[1]!} summary={<>Hauptzone <code>{env.zone}</code> · intern <code>*.{s.baseDomain}</code></>}>
          <DomainsStep s={s} onSaved={set} />
        </Step>
        <Step n={4} title={TITLES[3]!} state={states[2]!} summary={<>{s.tailscaleIp ? <>Tailnet <code>*.{s.baseDomain}</code> → {s.tailscaleIp}</> : 'ohne Tailnet-Eintrag'}</>}>
          <DnsStep base={s.baseDomain} tailscaleIp={s.tailscaleIp} onDone={() => setDnsSeen(true)} />
        </Step>
        <Step n={5} title={TITLES[4]!} state={states[3]!} summary={s.tls.phase === 'done' ? <CertSummary s={s} /> : <>später – bis dahin nur HTTP</>}>
          <TlsStep s={s} onStarted={set} />
          {s.tls.phase !== 'staging' && s.tls.phase !== 'production' && (
            <div className="form-actions"><button type="button" onClick={() => setTlsLater(true)}>Später einrichten</button></div>
          )}
        </Step>
        <Step n={6} title={TITLES[5]!} state={states[4]!} summary={s.tunnel ? <TunnelSummary s={s} onChanged={set} /> : <>später – «Öffentlich» bleibt bis dahin aus</>}>
          <TunnelStep onDone={set} />
        </Step>
        <Step n={7} title={TITLES[6]!} state={standardsState}>
          <StandardsStep others={envs.filter((e) => e.id !== env.id)} onDone={() => navigate(ep('/projekte'))} />
        </Step>
      </ol>
    </section>
  )
}

function CloudflareChoice({ s, others, onDone, onChecked, check }: {
  s: CfStatusDto; others: { id: string; name: string; account: { name: string | null } | null }[]
  onDone: (s: CfStatusDto) => void; onChecked: (c: CfTokenCheckDto | null) => void; check: CfTokenCheckDto | null
}) {
  const { env } = useEnv()
  const qc = useQueryClient()
  const [mode, setMode] = useState<'share' | 'own'>(others.length ? 'share' : 'own')
  const [from, setFrom] = useState(others[0]?.id ?? '')
  const share = useMutation({
    mutationFn: async () => {
      await api.updateEnvironment(env!.slug, { shareAccountOf: from })
      return api.cloudflare()
    },
    onSuccess: (st) => { onDone(st); void qc.invalidateQueries({ queryKey: ['environments'] }) },
  })
  return (
    <>
      {others.length > 0 && (
        <fieldset className="cf-fieldset">
          <legend className="visually-hidden">Cloudflare-Token</legend>
          <label className="choice">
            <input type="radio" name="cf-mode" checked={mode === 'share'} onChange={() => setMode('share')} />
            <span>Token einer anderen Umgebung mitbenutzen<small>Gleiches Cloudflare-Konto, gleicher Tunnel. Das Token muss die Zone dieser Umgebung sehen.</small></span>
          </label>
          <label className="choice">
            <input type="radio" name="cf-mode" checked={mode === 'own'} onChange={() => setMode('own')} />
            <span>Eigenes Token dieser Umgebung<small>Für eine Zone in einem anderen Konto, oder um die Rechte zu trennen.</small></span>
          </label>
        </fieldset>
      )}
      {mode === 'share' && others.length > 0 ? (
        <>
          <Field id="cf-share" label="Token von">
            <select id="cf-share" value={from} onChange={(e) => setFrom(e.target.value)}>
              {others.map((o) => <option key={o.id} value={o.id}>{o.name}{o.account?.name ? ` · Konto ${o.account.name}` : ''}</option>)}
            </select>
          </Field>
          <div className="form-actions">
            <button type="button" className="button-primary" onClick={() => share.mutate()} disabled={share.isPending || !from}>{share.isPending ? 'Wird verbunden…' : 'Mitbenutzen und weiter'}</button>
          </div>
          {share.isError && <p role="alert" className="error">{(share.error as Error).message}</p>}
        </>
      ) : (
        <>
          <TokenStep s={s} replacing={false} onChecked={onChecked} onSaved={(st) => { onDone(st); onChecked(null) }} />
          {check && <CheckResult check={check} />}
        </>
      )}
    </>
  )
}

function DnsStep({ base, tailscaleIp, onDone }: { base: string | null; tailscaleIp: string | null; onDone: () => void }) {
  const dns = useQuery({ queryKey: ['lan-dns', base], queryFn: api.lanDns, enabled: false })
  const [copied, setCopied] = useState(false)
  const d = dns.data
  return (
    <>
      <ul className="check-list">
        <li className={tailscaleIp ? 'check-ok' : 'check-none'}>
          <span className="check-name">Tailnet</span>
          <span className="check-detail">{tailscaleIp ? `*.${base} → ${tailscaleIp} bei Cloudflare gesetzt (nicht proxied)` : 'keine Tailscale-IP bekannt – unterwegs nicht erreichbar'}</span>
        </li>
        <li className={!d ? 'check-none' : d.ok ? 'check-ok' : 'check-fail'}>
          <span className="check-name">Lokaler DNS</span>
          <span className="check-detail">{d ? d.detail : dns.isFetching ? 'wird geprüft…' : 'noch nicht geprüft'}</span>
        </li>
      </ul>
      {d?.line && (
        <div className="lan-dns-line">
          <p className="hint">Im Heimnetz diese Umschreibung im lokalen DNS (Router, AdGuard oder Pi-hole) eintragen:</p>
          <pre className="code-block">{d.line}</pre>
        </div>
      )}
      <div className="form-actions">
        <button type="button" onClick={() => void dns.refetch()} disabled={dns.isFetching}>{d ? 'Erneut prüfen' : 'Lokalen DNS prüfen'}</button>
        {d?.line && <button type="button" onClick={async () => { setCopied(await copyText(d.line ?? '')); setTimeout(() => setCopied(false), 2000) }}>{copied ? 'Kopiert' : 'Zeile kopieren'}</button>}
        <button type="button" className="button-primary" onClick={onDone}>Weiter</button>
      </div>
    </>
  )
}

function StandardsStep({ others, onDone }: { others: { id: string; slug: string; name: string }[]; onDone: () => void }) {
  const [from, setFrom] = useState(others[0]?.slug ?? '')
  const [mode, setMode] = useState<'copy' | 'default'>(others.length ? 'copy' : 'default')
  const copy = useMutation({ mutationFn: () => api.copyStandards(from), onSuccess: onDone })
  return (
    <>
      <p className="cf-lead">Header-Vorlagen, Pause-Seite und Access-Standard. Später unter Einstellungen → Standards änderbar.</p>
      {others.length > 0 && (
        <label className="choice">
          <input type="radio" name="std-mode" checked={mode === 'copy'} onChange={() => setMode('copy')} />
          <span>Von einer bestehenden Umgebung übernehmen</span>
        </label>
      )}
      {mode === 'copy' && others.length > 0 && (
        <Field id="std-from" label="Übernehmen von">
          <select id="std-from" value={from} onChange={(e) => setFrom(e.target.value)}>
            {others.map((o) => <option key={o.id} value={o.slug}>{o.name}</option>)}
          </select>
        </Field>
      )}
      <label className="choice">
        <input type="radio" name="std-mode" checked={mode === 'default'} onChange={() => setMode('default')} />
        <span>Airlock-Standard<small>Keine Header-Vorlagen, Standard-Pause-Seite, Access aus.</small></span>
      </label>
      <div className="form-actions">
        <button type="button" className="button-primary" onClick={() => (mode === 'copy' ? copy.mutate() : onDone())} disabled={copy.isPending}>{copy.isPending ? 'Wird übernommen…' : 'Fertig – zu den Projekten'}</button>
      </div>
      {copy.isError && <p role="alert" className="error">{(copy.error as Error).message}</p>}
    </>
  )
}

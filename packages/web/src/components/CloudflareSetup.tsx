import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cfDomainsSchema, cfTokenSchema } from '@airlock/shared'
import { api, ApiError, type CfStatusDto, type CfTokenCheckDto } from '../api.js'
import { useFormErrors } from '../lib/form.js'
import { Field } from './Field.js'
import { IconBad, IconExternal, IconOk, IconPending, IconSkipped, IconUp } from './Icons.js'
import { ErrorState, Loading, SkCard } from './States.js'
import { ConfirmDialog, InlineConfirm } from './Confirm.js'
import { MUTATION_TUNNEL } from '../lib/activities.js'
import { relativeTime } from '../lib/format.js'
import { FALLBACK_MS } from '../lib/live.js'
import { dateOf, fmtDate, fmtTime, msOf } from '../lib/dates.js'

/**
 * «Cloudflare verbinden»: Token, Prüfung, Domains, Tunnel, Zertifikat – in
 * dieser Reihenfolge, jeder Schritt erst, wenn der vorige steht. Ersetzt
 * .env, compose.tls.yaml und compose.public.yaml.
 */

const svg = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
const IconOptional = IconSkipped

/* M9: Die Bausteine nutzt auch der Assistent «Umgebung anlegen» (pages/NewEnvironment.tsx). */
/** skipped: bewusst ausgelassen (Tunnel) – neutral, kein Haken, kein Fehler (UI-Qualität 6) */
export type StepState = 'done' | 'current' | 'locked' | 'skipped'

export function Step({ n, title, state, summary, onEdit, children }: {
  n: number; title: string; state: StepState; summary?: React.ReactNode; onEdit?: () => void; children?: React.ReactNode
}) {
  return (
    <li className={`cf-step cf-step-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
      <div className="cf-step-head">
        <span className="cf-step-n" aria-hidden="true">{state === 'done' ? <IconOk /> : state === 'skipped' ? '–' : n}</span>
        <h3 className="cf-step-title" aria-level={2}>
          <span className="visually-hidden">Schritt {n}{state === 'done' ? ', erledigt' : state === 'locked' ? ', noch nicht möglich' : ''}: </span>
          {title}
          {state === 'skipped' && <span className="cf-skipped"> übersprungen</span>}
        </h3>
        {state === 'done' && onEdit && <button type="button" className="link-button cf-edit" onClick={onEdit}>Ändern</button>}
      </div>
      {(state === 'done' || state === 'skipped') && summary && <div className="cf-step-summary">{summary}</div>}
      {state === 'current' && <div className="cf-step-body">{children}</div>}
    </li>
  )
}

export function CloudflareSetup() {
  const qc = useQueryClient()
  const status = useQuery({
    queryKey: ['cloudflare'],
    queryFn: api.cloudflare,
    // Zertifikat und Einstellungen kommen über den Ereignisstrom; Tunnel, cloudflared und Zertifikatsprobe
    // sind Messwerte ohne Ereignis – deshalb auch mit Strom einmal pro Minute (UI-Qualität 3)
    refetchInterval: FALLBACK_MS,
  })
  const [editing, setEditing] = useState<'token' | 'domains' | null>(null)
  const [check, setCheck] = useState<CfTokenCheckDto | null>(null)
  const [showSetup, setShowSetup] = useState(false)
  const [fromSummary, setFromSummary] = useState(false)
  const set = (s: CfStatusDto) => {
    qc.setQueryData(['cloudflare'], s)
    void qc.invalidateQueries({ queryKey: ['system'] })
  }

  if (!status.data && status.isError) return <ErrorState what="Der Cloudflare-Status" error={status.error} retrying={status.isFetching} onRetry={() => void status.refetch()} />
  if (!status.data) return <Loading label="Cloudflare-Status wird geladen"><SkCard lines={3} /><SkCard lines={3} className="sk-gap-lg" /><SkCard lines={3} className="sk-gap-lg" /></Loading>
  const s = status.data

  const ui = s.source === 'ui'
  const hasToken = ui
  const hasDomains = ui && Boolean(s.baseDomain)
  const hasTunnel = ui && Boolean(s.tunnel?.managed)
  // Ohne Tunnel geht es trotzdem weiter: Das Zertifikat braucht nur das Token.
  const tunnelSkipped = ui && !hasTunnel && s.tunnelSkipped
  const tlsDone = s.tls.phase === 'done'

  const st = (done: boolean, ready: boolean, key?: 'token' | 'domains'): StepState => (key && editing === key ? 'current' : done ? 'done' : ready ? 'current' : 'locked')
  const tokenState = st(hasToken, true, 'token')
  const checkState: StepState = tokenState === 'current' ? (check ? 'current' : 'locked') : hasToken ? 'done' : 'locked'

  // UI-Qualität 6: nach der Einrichtung eine Zusammenfassung statt der fünf Schritte
  const complete = ui && hasToken && hasDomains && (hasTunnel || tunnelSkipped) && tlsDone && !editing
  // Umschalten ersetzt den Inhalt: Fokus auf das Gegenstück (sonst fiele er auf <body>)
  const toggle = (setup: boolean) => {
    setShowSetup(setup)
    requestAnimationFrame(() => document.getElementById(setup ? 'cf-show-summary' : 'cf-summary-h')?.focus())
  }
  // «Token ersetzen» aus der Zusammenfassung: nach Speichern oder Abbrechen dorthin zurück
  const backFromToken = () => {
    if (!fromSummary) return
    setFromSummary(false)
    toggle(false)
  }
  if (complete && !showSetup) {
    return (
      <div className="cf">
        <section className="cf-summary panel panel-pad" aria-labelledby="cf-summary-h">
          <div className="cf-summary-head">
            <h3 id="cf-summary-h" className="cf-step-title" aria-level={2} tabIndex={-1}><IconOk /> Cloudflare ist eingerichtet</h3>
            <button type="button" className="button-small" onClick={() => toggle(true)}>Einrichtung anzeigen</button>
          </div>
          <dl className="cf-summary-rows">
            <dt>Token</dt>
            <dd>Gespeichert {s.token.savedAt ? relativeTime(s.token.savedAt) : ''} · Konto {s.account?.name ?? s.account?.id}</dd>
            <dt>Rechte</dt>
            <dd><PermissionSummary check={s.token.lastCheck} /></dd>
            <dt>Domains</dt>
            <dd>Intern <code>*.{s.baseDomain}</code>{s.defaultZone ? <> · öffentlich unter <code>{s.defaultZone}</code></> : ' · keine Standard-Domain'}</dd>
            <dt>Tunnel</dt>
            <dd>{tunnelSkipped ? <><span className="cf-skipped">übersprungen</span> <TunnelSkippedSummary onDone={set} /></> : <TunnelSummary s={s} onChanged={set} />}</dd>
            <dt>Zertifikat</dt>
            <dd><CertSummary s={s} /></dd>
          </dl>
        </section>
        <Manage s={s} onChanged={set} onReplaceToken={() => { setFromSummary(true); setShowSetup(true); setCheck(null); setEditing('token'); requestAnimationFrame(() => document.getElementById('f-token')?.focus()) }} />
      </div>
    )
  }

  return (
    <div className="cf">
      {complete && (
        <div className="cf-summary-head cf-summary-back">
          <button type="button" id="cf-show-summary" className="button-small" onClick={() => toggle(false)}>Zusammenfassung anzeigen</button>
        </div>
      )}
      {s.source === 'env' && (
        <p className="banner banner-info">
          Cloudflare ist noch über <code>.env</code> eingerichtet (<code>compose.tls.yaml</code> / <code>compose.public.yaml</code>).
          Das läuft weiter. Wer hier verbindet, übernimmt in die Oberfläche; die alten Werte bleiben als Rückfall.
        </p>
      )}

      <ol className="cf-steps">
        <Step n={1} title="Token einfügen" state={tokenState} onEdit={() => { setCheck(null); setEditing('token') }}
          summary={<>API-Token gespeichert {s.token.savedAt ? relativeTime(s.token.savedAt) : ''} · Konto {s.account?.name ?? s.account?.id}</>}>
          <TokenStep s={s} replacing={hasToken} onChecked={setCheck} onSaved={(st2) => { set(st2); setCheck(null); setEditing(null); backFromToken() }} onCancel={hasToken ? () => { setCheck(null); setEditing(null); backFromToken() } : undefined} />
        </Step>

        <Step n={2} title="Token prüfen" state={checkState} summary={<PermissionSummary check={s.token.lastCheck} />}>
          {check && <CheckResult check={check} />}
        </Step>

        <Step n={3} title="Domains wählen" state={hasToken ? st(hasDomains, true, 'domains') : 'locked'} onEdit={() => setEditing('domains')}
          summary={<>Intern <code>*.{s.baseDomain}</code>{s.defaultZone ? <> · öffentlich unter <code>{s.defaultZone}</code></> : ' · keine Standard-Domain'}{s.tailscaleIp ? <> · Tailnet {s.tailscaleIp}</> : null}</>}>
          <DomainsStep s={s} onSaved={(st2) => { set(st2); setEditing(null) }} onCancel={hasDomains ? () => setEditing(null) : undefined} />
        </Step>

        <Step n={4} title="Tunnel anlegen" state={hasDomains ? (tunnelSkipped ? 'skipped' : st(hasTunnel, true)) : 'locked'}
          summary={tunnelSkipped ? <TunnelSkippedSummary onDone={set} /> : <TunnelSummary s={s} onChanged={set} />}>
          <TunnelStep onDone={set} />
        </Step>

        <Step n={5} title="Zertifikat einrichten" state={hasTunnel || tunnelSkipped ? (tlsDone ? 'done' : 'current') : 'locked'} summary={<CertSummary s={s} />}>
          <TlsStep s={s} onStarted={set} />
        </Step>
      </ol>

      {ui && <Manage s={s} onChanged={set} onReplaceToken={() => { setCheck(null); setEditing('token'); requestAnimationFrame(() => document.getElementById('f-token')?.focus()) }} />}
    </div>
  )
}

/* --- 1 + 2: Token ----------------------------------------------------------------- */

export function TokenStep({ s, replacing, onChecked, onSaved, onCancel }: {
  s: CfStatusDto; replacing: boolean; onChecked: (c: CfTokenCheckDto | null) => void; onSaved: (s: CfStatusDto) => void; onCancel?: () => void
}) {
  const [token, setToken] = useState('')
  const v = useFormErrors({ schema: cfTokenSchema, values: () => ({ token }) })
  const [checked, setChecked] = useState<CfTokenCheckDto | null>(null)
  const timer = useRef<number | null>(null)

  const runCheck = useMutation({
    mutationFn: (t: string) => api.cloudflareCheck(t),
    onSuccess: (r) => { setChecked(r.check); onChecked(r.check) },
    onError: (err) => { setChecked(null); onChecked(null); v.setServerErrors(err) || v.setErrors({ token: (err as Error).message }) },
  })
  const save = useMutation({
    mutationFn: () => api.cloudflareToken(token.trim()),
    onSuccess: (r) => onSaved(r.status),
    onError: (err) => {
      const d = err instanceof ApiError ? (err.details as { check?: CfTokenCheckDto } | undefined) : undefined
      if (d?.check) { setChecked(d.check); onChecked(d.check) } else v.setServerErrors(err)
    },
  })

  // Sofort prüfen, sobald etwas Token-Ähnliches drinsteht
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current)
    const t = token.trim()
    if (!cfTokenSchema.safeParse({ token: t }).success) { setChecked(null); onChecked(null); return }
    timer.current = window.setTimeout(() => runCheck.mutate(t), 350)
    return () => { if (timer.current) window.clearTimeout(timer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  return (
    <form noValidate ref={v.formRef} onSubmit={(e) => { e.preventDefault(); if (v.validateAll() && checked?.complete) save.mutate() }}>
      {!replacing && (
        <>
          <p className="cf-lead">Erstelle bei Cloudflare ein API-Token mit diesen Rechten. Der Link füllt sie vor; prüfe nur Konto und Zonen.</p>
          <ul className="cf-perms">
            {s.requiredPermissions.map((p) => (
              <li key={p.label}>
                <span className="cf-perm-label">{p.label}</span>
                {!p.required && <span className="cf-tag">optional</span>}
                <span className="cf-perm-why">{p.why}</span>
              </li>
            ))}
          </ul>
          <p className="cf-lead">Unter «Kontoressourcen» dein Konto wählen, unter «Zonenressourcen» alle Zonen oder die, die Airlock nutzen soll.</p>
        </>
      )}
      {replacing && <p className="cf-lead">Neues Token für dasselbe Konto. Das alte gilt, bis das neue geprüft und gespeichert ist; danach kannst du es bei Cloudflare löschen.</p>}
      <a className="button cf-template" href={s.tokenTemplateUrl} target="_blank" rel="noreferrer">Token-Seite bei Cloudflare öffnen <IconExternal /></a>

      <Field id={v.idFor('token')} label="API-Token" error={v.errors.token} hint="Wird sofort geprüft und verschlüsselt gespeichert. Es erscheint nirgends im Klartext.">
        <input
          {...v.field('token', `${v.idFor('token')}-hint`)}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="z.B. 3x4mpl3T0k3n…"
        />
      </Field>
      <p className="cf-checking" aria-live="polite">
        {runCheck.isPending ? <><IconPending /> Prüfe bei Cloudflare…</> : checked ? (checked.complete ? <span className="cf-ok"><IconOk /> Rechte vollständig</span> : <span className="cf-bad"><IconBad /> {checked.valid ? 'Rechte unvollständig – siehe Schritt 2' : checked.message}</span>) : null}
      </p>
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={!checked?.complete || save.isPending} aria-busy={save.isPending || undefined}>{replacing ? 'Token ersetzen' : 'Token speichern'}</button>
        {onCancel && <button type="button" onClick={onCancel}>Abbrechen</button>}
      </div>
    </form>
  )
}

export function CheckResult({ check }: { check: CfTokenCheckDto }) {
  if (!check.valid) return <p className="cf-bad cf-check-msg"><IconBad /> {check.message}</p>
  return (
    <>
      <ul className="cf-check">
        {check.permissions.map((p) => (
          <li key={p.key} className={p.ok ? 'cf-check-ok' : p.required ? 'cf-check-bad' : 'cf-check-opt'}>
            <span className="cf-check-icon">{p.ok ? <IconOk /> : p.required ? <IconBad /> : <IconOptional />}</span>
            <span className="cf-check-label">{p.label}</span>
            <span className="cf-check-state">{p.ok ? 'vorhanden' : p.required ? 'fehlt' : 'fehlt (optional)'}</span>
            {p.detail && !p.ok && <span className="cf-check-detail">{p.detail}</span>}
          </li>
        ))}
      </ul>
      {check.valid && check.zones.length > 0 && (
        <p className="cf-meta">Konto {check.accounts.map((a) => a.name).join(', ') || '–'} · {check.zones.length} {check.zones.length === 1 ? 'Zone' : 'Zonen'}{msOf(check.expiresOn) !== null ? ` · läuft ab am ${fmtDate(check.expiresOn)}` : ''}</p>
      )}
      {!check.complete && <p className="cf-meta">Rechte bei Cloudflare unter «Token bearbeiten» ergänzen, dann hier neu einfügen – das Token selbst bleibt gleich.</p>}
    </>
  )
}

function PermissionSummary({ check }: { check: CfTokenCheckDto | null }) {
  if (!check) return <>geprüft</>
  const opt = check.permissions.filter((p) => !p.required && !p.ok)
  return <>Alle nötigen Rechte vorhanden{opt.length ? ` · ohne ${opt.map((p) => p.label.split('→').pop()!.trim()).join(', ')} (optional)` : ''}</>
}

/* --- 3: Domains ------------------------------------------------------------------- */

export function DomainsStep({ s, onSaved, onCancel }: { s: CfStatusDto; onSaved: (s: CfStatusDto) => void; onCancel?: () => void }) {
  const zones = s.zones
  const current = s.baseDomain ? zones.find((z) => s.baseDomain === z.name || s.baseDomain!.endsWith(`.${z.name}`)) : undefined
  const [baseZone, setBaseZone] = useState(current?.name ?? zones[0]?.name ?? '')
  const [baseLabel, setBaseLabel] = useState(current && s.baseDomain ? s.baseDomain.slice(0, -(current.name.length + 1)) || '' : 'int')
  const [defaultZone, setDefaultZone] = useState<string>(s.defaultZone ?? zones[0]?.name ?? '')
  const [tailscaleIp, setTailscaleIp] = useState(s.tailscaleIp ?? s.detectedTailscaleIp ?? '')
  const [accessEmail, setAccessEmail] = useState(s.accessEmail ?? '')
  const [acmeEmail, setAcmeEmail] = useState(s.acmeEmail ?? '')
  const accounts = s.token.lastCheck?.accounts ?? []
  const [accountId, setAccountId] = useState(s.account?.id ?? accounts[0]?.id ?? '')
  const values = () => ({ baseZone, baseLabel, defaultZone: defaultZone || null, accountId: accountId || undefined, tailscaleIp, accessEmail, acmeEmail })
  const v = useFormErrors({ schema: cfDomainsSchema, values })
  const save = useMutation({ mutationFn: () => api.cloudflareDomains(values()), onSuccess: onSaved, onError: (err) => void v.setServerErrors(err) })
  const preview = `${baseLabel.trim() ? `${baseLabel.trim().toLowerCase()}.` : ''}${baseZone}`
  const e = v.errors

  if (zones.length === 0) return <p className="cf-bad"><IconBad /> Das Token sieht keine Zone. Bei Cloudflare unter «Zonenressourcen» Zonen freigeben, dann das Token ersetzen.</p>

  return (
    <form noValidate ref={v.formRef} onSubmit={(ev) => { ev.preventDefault(); if (v.validateAll()) save.mutate() }}>
      {accounts.length > 1 && (
        <Field id={v.idFor('accountId')} label="Konto" hint="Darin legt Airlock den Tunnel an.">
          <select {...v.field('accountId')} value={accountId} onChange={(x) => setAccountId(x.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      )}
      <fieldset className="cf-fieldset">
        <legend>Interne Adressen</legend>
        <div className="cf-base">
          <Field id={v.idFor('baseLabel')} label="Präfix" error={e.baseLabel}>
            <input {...v.field('baseLabel')} value={baseLabel} onChange={(x) => setBaseLabel(x.target.value)} placeholder="int" spellCheck={false} autoComplete="off" />
          </Field>
          <span className="cf-dot" aria-hidden="true">.</span>
          <Field id={v.idFor('baseZone')} label="Zone" error={e.baseZone}>
            <select {...v.field('baseZone')} value={baseZone} onChange={(x) => setBaseZone(x.target.value)}>
              {zones.map((z) => <option key={z.id} value={z.name}>{z.name}</option>)}
            </select>
          </Field>
        </div>
        <p className="hint">Projekte heissen dann <code>projekt.{preview}</code>, mit einem Wildcard-Zertifikat für <code>*.{preview}</code>. Nur im LAN und Tailnet erreichbar.</p>
      </fieldset>

      <Field id={v.idFor('defaultZone')} label="Standard-Domain für öffentliche Projekte" error={e.defaultZone} hint="Wer ein Projekt öffentlich schaltet und nur eine Subdomain angibt, landet hier, z.B. solar.deine-domain.ch.">
        <select {...v.field('defaultZone', `${v.idFor('defaultZone')}-hint`)} value={defaultZone} onChange={(x) => setDefaultZone(x.target.value)}>
          <option value="">keine – immer den vollen Namen angeben</option>
          {zones.map((z) => <option key={z.id} value={z.name}>{z.name}</option>)}
        </select>
      </Field>

      <Field id={v.idFor('tailscaleIp')} label="Tailnet-IP des Servers" error={e.tailscaleIp} hint={<>Die Hauptadresse: Airlock legt <code>*.{preview}</code> → diese IP bei Cloudflare an (nicht proxied), die internen Namen gehen so überall im Tailnet.{s.detectedTailscaleIp ? <> Auf dem Server erkannt: <code>{s.detectedTailscaleIp}</code>.</> : null}</>}>
        <input {...v.field('tailscaleIp', `${v.idFor('tailscaleIp')}-hint`)} value={tailscaleIp} onChange={(x) => setTailscaleIp(x.target.value)} placeholder="100.101.102.103" inputMode="decimal" spellCheck={false} />
      </Field>

      <details className="cf-more" open={Boolean(s.accessEmail || s.acmeEmail)}>
        <summary>Weitere Angaben (optional)</summary>
        <Field id={v.idFor('accessEmail')} label="E-Mail für Cloudflare Access" optional error={e.accessEmail} hint="Wer sich bei Projekten hinter Access anmelden darf.">
          <input {...v.field('accessEmail', `${v.idFor('accessEmail')}-hint`)} value={accessEmail} onChange={(x) => setAccessEmail(x.target.value)} type="email" placeholder="joel@deine-domain.ch" spellCheck={false} />
        </Field>
        <Field id={v.idFor('acmeEmail')} label="E-Mail für Let's Encrypt" optional error={e.acmeEmail} hint="Kontakt beim ACME-Konto. Let's Encrypt verschickt seit Juni 2025 keine Ablauf-Warnungen mehr; die kommen von Airlock (System → Benachrichtigungen).">
          <input {...v.field('acmeEmail', `${v.idFor('acmeEmail')}-hint`)} value={acmeEmail} onChange={(x) => setAcmeEmail(x.target.value)} type="email" placeholder="joel@deine-domain.ch" spellCheck={false} />
        </Field>
      </details>

      {s.baseDomain && preview !== s.baseDomain && (
        <p className="cf-warn"><IconBad /> Die Basisdomain ändert sich von <code>{s.baseDomain}</code> auf <code>{preview}</code>: Alle Projekte ziehen um, und das Zertifikat muss neu eingerichtet werden.</p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={save.isPending} aria-busy={save.isPending || undefined}>Domains speichern</button>
        {onCancel && <button type="button" onClick={onCancel}>Abbrechen</button>}
      </div>
    </form>
  )
}

/* --- 4: Tunnel -------------------------------------------------------------------- */

export function TunnelStep({ onDone }: { onDone: (s: CfStatusDto) => void }) {
  // Fester Schlüssel: die Aktivitätsanzeige im Kopf zeigt den Vorgang, auch nach einem Seitenwechsel
  const run = useMutation({ mutationKey: [...MUTATION_TUNNEL], mutationFn: api.cloudflareTunnel, onSuccess: onDone, meta: { errorTitle: 'Tunnel nicht angelegt' } })
  const skip = useMutation({ mutationFn: api.cloudflareTunnelSkip, onSuccess: onDone })
  return (
    <>
      <p className="cf-lead">Airlock legt bei Cloudflare einen Tunnel an und startet <code>cloudflared</code> als eigenen Container. Er baut die Verbindung nach aussen auf – am Router bleibt jeder Port zu. Öffentlich wird dadurch noch nichts.</p>
      <p className="cf-meta">Nur für öffentliche Projekte nötig. Das Zertifikat für interne Adressen geht auch ohne Tunnel.</p>
      <div className="form-actions">
        <button type="button" className="button-primary" onClick={() => run.mutate()} disabled={run.isPending || skip.isPending} aria-busy={run.isPending || undefined}>Tunnel anlegen und starten</button>
        <button type="button" onClick={() => skip.mutate()} disabled={run.isPending || skip.isPending}>Später einrichten</button>
      </div>
      {run.isPending && <p className="cf-meta" aria-live="polite">Image holen, Container starten – das dauert beim ersten Mal bis zu einer Minute.</p>}
    </>
  )
}

function TunnelSkippedSummary({ onDone }: { onDone: (s: CfStatusDto) => void }) {
  const run = useMutation({ mutationKey: [...MUTATION_TUNNEL], mutationFn: api.cloudflareTunnel, onSuccess: onDone, meta: { errorTitle: 'Tunnel nicht angelegt' } })
  return (
    <div className="cf-rows">
      <span className="cf-meta"><IconOptional /> Kein Tunnel: Projekte sind nur intern erreichbar, «Öffentlich» bleibt aus.</span>
      <button type="button" className="button-small" onClick={() => run.mutate()} disabled={run.isPending} aria-busy={run.isPending || undefined}>Tunnel jetzt anlegen</button>
      {run.isPending && <span className="cf-meta" aria-live="polite">Image holen, Container starten – das dauert beim ersten Mal bis zu einer Minute.</span>}
    </div>
  )
}

export function TunnelSummary({ s, onChanged }: { s: CfStatusDto; onChanged: (s: CfStatusDto) => void }) {
  const restart = useMutation({ mutationFn: api.cloudflareTunnelRestart, onSuccess: onChanged })
  const t = s.tunnel
  if (!t) return null
  const running = t.container?.running
  const connected = t.status === 'healthy' && t.connections > 0
  return (
    <div className="cf-rows">
      <span className={running ? 'cf-ok' : 'cf-bad'}>{running ? <IconOk /> : <IconBad />} cloudflared {running ? 'läuft' : t.container?.restarting ? 'startet ständig neu' : t.container?.exists ? 'gestoppt' : 'fehlt'}</span>
      <span className={connected && running ? 'cf-ok' : 'cf-bad'}>{connected && running ? <IconOk /> : <IconBad />} {connected && running ? `verbunden, ${t.connections} Verbindungen` : `nicht verbunden${t.status && running ? ` (${t.status})` : ''}`}</span>
      <span className="cf-meta">Tunnel {t.name ?? t.id}</span>
      {!running && t.container?.lastLog && <span className="cf-meta cf-lastlog">Letzte Meldung: <code>{t.container.lastLog}</code></span>}
      {!running && t.managed && <button type="button" className="button-small" onClick={() => restart.mutate()} disabled={restart.isPending} aria-busy={restart.isPending || undefined}>cloudflared neu starten</button>}
      <CloudflaredVersion s={s} onChanged={onChanged} />
      <ForeignIngress s={s} />
    </div>
  )
}

function CloudflaredVersion({ s, onChanged }: { s: CfStatusDto; onChanged: (s: CfStatusDto) => void }) {
  const [confirm, setConfirm] = useState(false)
  const update = useMutation({ mutationFn: api.cloudflareTunnelUpdate, onSuccess: (st) => { setConfirm(false); onChanged(st) } })
  const t = s.tunnel!
  return (
    <div className="cf-version">
      <span className="cf-version-line">
        cloudflared <code>{t.version ?? 'Version unbekannt'}</code>
        {t.updateAvailable
          ? <span className="cf-update"><IconUp /> {t.latestVersion} verfügbar</span>
          : t.latestVersion && t.version ? <span className="cf-meta-inline">aktuell</span> : null}
      </span>
      {t.updateAvailable && !confirm && (
        <button type="button" className="button-small" onClick={() => setConfirm(true)}>Auf {t.latestVersion} aktualisieren</button>
      )}
      {t.updateAvailable && confirm && (
        <InlineConfirm label="Update bestätigen" small tone="primary"
          note="Der Tunnel ist dabei einige Sekunden unterbrochen." noteIcon={false} noteClassName="cf-meta-inline"
          confirmLabel="Jetzt aktualisieren" busy={update.isPending}
          onCancel={() => setConfirm(false)} onConfirm={() => update.mutate()} />
      )}
      {!t.managed && t.updateAvailable && <span className="cf-meta-inline">Läuft aus compose.public.yaml – dort das Image anpassen.</span>}
    </div>
  )
}

/** Warnung: eine Regel des Tunnels zeigt nicht auf Caddy (am IP-Filter und Routing vorbei). */
function ForeignIngress({ s }: { s: CfStatusDto }) {
  const t = s.tunnel!
  if (t.foreignIngress.length === 0) return null
  return (
    <div className="cf-ingress-warn" role="alert">
      <p className="cf-ingress-title"><IconBad /> {t.foreignIngress.length === 1 ? 'Eine Regel des Tunnels zeigt' : `${t.foreignIngress.length} Regeln des Tunnels zeigen`} nicht auf Caddy</p>
      <ul>
        {t.foreignIngress.map((r, i) => (
          <li key={i}><code>{r.hostname ?? '(alle übrigen Namen)'}</code> → <code>{r.service}</code></li>
        ))}
      </ul>
      <p className="cf-meta">Solche Regeln umgehen Caddy: kein IP-Filter, keine Kontrolle durch Airlock. Bei Cloudflare unter Zero Trust → Netzwerke → Tunnel → {t.name ?? 'Tunnel'} → Öffentliche Hostnamen entfernen. Airlock setzt nur <code>http://caddy:80</code>.</p>
    </div>
  )
}

/* --- 5: Zertifikat ------------------------------------------------------------------ */

const PHASES: { key: 'staging' | 'production' | 'done'; label: string }[] = [
  { key: 'staging', label: 'Probelauf (Staging-CA)' },
  { key: 'production', label: 'Echtes Zertifikat' },
  { key: 'done', label: 'HTTPS aktiv' },
]

export function TlsStep({ s, onStarted }: { s: CfStatusDto; onStarted: (s: CfStatusDto) => void }) {
  const start = useMutation({ mutationFn: api.cloudflareTls, onSuccess: onStarted })
  const phase = s.tls.phase
  const running = phase === 'staging' || phase === 'production'
  const idx = phase === 'done' ? 2 : phase === 'production' ? 1 : phase === 'staging' ? 0 : -1
  const retryAt = dateOf(s.tls.retryAt)
  const waiting = useUntil(retryAt)
  return (
    <>
      {phase === 'off' && <p className="cf-lead">Caddy holt ein Wildcard-Zertifikat für <code>*.{s.baseDomain}</code> bei Let's Encrypt, per DNS-Challenge über Cloudflare. Erst ein Probelauf bei der Staging-CA (ohne Risiko, ins Rate-Limit zu laufen), dann das echte. Dauert meist zwei bis vier Minuten.</p>}
      {phase !== 'off' && (
        <ol className="cf-phases" aria-label="Fortschritt">
          {PHASES.map((p, i) => {
            const failedHere = phase === 'failed' && i === (s.tls.ca === 'staging' ? 0 : 1)
            const state = failedHere ? 'bad' : i < idx || phase === 'done' ? 'ok' : i === idx ? 'now' : 'next'
            return (
              <li key={p.key} className={`cf-phase cf-phase-${state}`}>
                <span className="cf-phase-icon">{state === 'ok' ? <IconOk /> : state === 'bad' ? <IconBad /> : <IconPending />}</span>
                <span>{p.label}</span>
                <span className="cf-phase-state">{state === 'ok' ? 'erledigt' : state === 'bad' ? 'gescheitert' : state === 'now' ? 'läuft…' : 'wartet'}</span>
              </li>
            )
          })}
        </ol>
      )}
      {s.tls.steps.length > 0 && (
        <ul className="cf-log" aria-live="polite">
          {s.tls.steps.map((x, i) => (
            <li key={i} className={`cf-log-${x.tone}`}>
              <time dateTime={x.at}>{fmtTime(x.at, true)}</time>
              <span>{x.text}</span>
            </li>
          ))}
        </ul>
      )}
      {!running && phase !== 'done' && (
        <div className="form-actions">
          <button type="button" className="button-primary" onClick={() => start.mutate()} disabled={start.isPending || waiting}>{phase === 'failed' ? 'Nochmals versuchen' : 'Zertifikat einrichten'}</button>
        </div>
      )}
      {!running && phase !== 'done' && retryAt && waiting && (
        <p className="cf-meta" aria-live="polite">Nächster Versuch ab {fmtTime(retryAt)} Uhr. Höchstens ein Versuch pro Stunde bei Let's Encrypt, sonst sperrt es neue Zertifikate für diesen Namen.</p>
      )}
      {!running && phase !== 'done' && s.tls.reusesCert && (
        <p className="cf-meta">Ein gültiges Zertifikat liegt schon bei Caddy. Ein neuer Versuch lädt es, ohne neu zu bestellen.</p>
      )}
      {phase === 'failed' && <p className="cf-meta">Häufig: dem Token fehlt das DNS-Recht für diese Zone, oder ein lokaler DNS fängt <code>_acme-challenge</code> ab. Interne Adressen laufen bis dahin weiter über http.</p>}
    </>
  )
}

/** true, solange `until` in der Zukunft liegt; schaltet von selbst um. */
function useUntil(until: Date | null): boolean {
  const ms = until ? until.getTime() - Date.now() : 0
  const [, tick] = useState(0)
  useEffect(() => {
    if (ms <= 0) return
    const t = window.setTimeout(() => tick((n) => n + 1), Math.min(ms + 500, 2 ** 31 - 1))
    return () => window.clearTimeout(t)
  }, [ms > 0, until?.getTime()])
  return ms > 0
}

export function CertSummary({ s }: { s: CfStatusDto }) {
  const c = s.tls.cert
  if (!c) return <>HTTPS aktiv für <code>*.{s.baseDomain}</code></>
  return <>Gültig bis {fmtDate(c.validTo)}{c.daysLeft !== null ? ` (${c.daysLeft} Tage)` : ''} · {c.issuer ?? 'Let\'s Encrypt'} · erneuert sich selbst</>
}

/* --- Verwalten ---------------------------------------------------------------------- */

function Manage({ s, onChanged, onReplaceToken }: { s: CfStatusDto; onChanged: (s: CfStatusDto) => void; onReplaceToken: () => void }) {
  const [confirm, setConfirm] = useState(false)
  // Fehler zeigt der Dialog selbst (quiet), dort bleibt er offen
  const disconnect = useMutation({ meta: { errorTitle: 'Cloudflare nicht getrennt', noRetry: true, quiet: true }, mutationFn: api.cloudflareDisconnect, onSuccess: (st) => { setConfirm(false); onChanged(st) } })
  return (
    <section className="cf-manage" aria-labelledby="cf-manage-title">
      <h3 id="cf-manage-title">Verbindung</h3>
      <div className="cf-manage-row">
        <div>
          <p className="cf-manage-label">Token ersetzen</p>
          <p className="cf-meta">Für ein neues Token mit anderen Rechten oder nach Ablauf. Tunnel und Zertifikat bleiben.</p>
        </div>
        <button type="button" onClick={onReplaceToken}>Token ersetzen</button>
      </div>
      <div className="cf-manage-row">
        <div>
          <p className="cf-manage-label">Verbindung trennen</p>
          <p className="cf-meta">
            Stoppt cloudflared, löscht den Tunnel bei Cloudflare und vergisst das Token. Interne Adressen laufen danach über http; die Basisdomain bleibt.
            {s.publicProjects > 0 && <> <strong>Erst möglich, wenn kein Projekt mehr öffentlich ist ({s.publicProjects}).</strong></>}
          </p>
        </div>
        <button type="button" className="button-danger" onClick={() => { disconnect.reset(); setConfirm(true) }} disabled={s.publicProjects > 0}>Trennen …</button>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Cloudflare trennen?"
        confirmLabel="Ja, trennen"
        busy={disconnect.isPending}
        error={disconnect.isError ? (disconnect.error as Error).message : null}
        onCancel={() => setConfirm(false)}
        onConfirm={() => disconnect.mutate()}
      >
        <p>Stoppt cloudflared, löscht den Tunnel bei Cloudflare und vergisst das Token. Interne Adressen laufen danach über http; die Basisdomain bleibt.</p>
      </ConfirmDialog>
    </section>
  )
}

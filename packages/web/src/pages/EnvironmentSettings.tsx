import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { HEADER_DEFAULT, HEADER_LABEL, templateHeaderKeys, type HeaderKey } from '@airlock/shared'
import { api, type EnvironmentDto, type HeaderTemplateDto } from '../api.js'
import { PageHead } from '../components/PageHead.js'
import { CloudflareSetup } from '../components/CloudflareSetup.js'
import { PausePageSettings } from '../components/PausePageSettings.js'
import { Field } from '../components/Field.js'
import { IconWarn } from '../components/Icons.js'
import { useEnv, useEnvPath } from '../lib/env.js'
import { copyText } from '../lib/clipboard.js'

export type EnvSettingsSection = 'allgemein' | 'cloudflare' | 'standards'

/**
 * M9: Einstellungen der Umgebung (SPEC «Umgebungen»). Allgemein (Name,
 * Kürzel, Standard, Löschen), Cloudflare & HTTPS (Token, Hauptzone, interne
 * Basis, Zertifikat, Tailnet, lokaler DNS), Standards (Header-Vorlagen,
 * Access, Pause-Seite). Was für alle Umgebungen gilt, steht unter Server.
 */
export function EnvironmentSettings({ section }: { section: EnvSettingsSection }) {
  const { env } = useEnv()
  const ep = useEnvPath()
  if (!env) return null
  const tabs: { key: EnvSettingsSection; to: string; label: string }[] = [
    { key: 'allgemein', to: ep('/einstellungen'), label: 'Allgemein' },
    { key: 'cloudflare', to: ep('/einstellungen/cloudflare'), label: 'Cloudflare & HTTPS' },
    { key: 'standards', to: ep('/einstellungen/standards'), label: 'Standards' },
  ]
  const current = tabs.find((t) => t.key === section)!
  return (
    <section className="page page-medium">
      <PageHead
        crumbs={section === 'allgemein' ? [{ label: 'einstellungen' }] : [{ label: 'einstellungen', to: ep('/einstellungen') }, { label: current.label.toLowerCase() }]}
        title="Einstellungen"
      />
      <nav className="tabs" aria-label="Bereiche der Umgebung">
        {tabs.map((t) => (
          <NavLink key={t.key} to={t.to} end className={({ isActive }) => (isActive ? 'tab tab-active' : 'tab')} aria-current={t.key === section ? 'page' : undefined}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <p className="lede lede-tight">
        Gilt nur für die Umgebung <strong>{env.name}</strong>. Tunnel-Status, Benachrichtigungen und GitHub gelten für alle Umgebungen und stehen unter <NavLink to="/server">Server</NavLink>.
      </p>

      {section === 'allgemein' && <General env={env} />}
      {section === 'cloudflare' && (
        <>
          <EnvFacts env={env} />
          <CloudflareSetup />
          {env.baseDomain && <NameResolution env={env} />}
        </>
      )}
      {section === 'standards' && (
        <>
          <HeaderTemplates />
          <AccessDefaults env={env} />
          <PausePageSettings />
        </>
      )}
    </section>
  )
}

/** Hauptzone, interne Basis, Adresse in Airlock – auf einen Blick. */
function EnvFacts({ env }: { env: EnvironmentDto }) {
  return (
    <div className="env-facts">
      <div className="stat"><span className="label">Hauptzone</span><strong>{env.zone ?? 'noch nicht gewählt'}</strong></div>
      <div className="stat"><span className="label">Interne Basis</span><strong>{env.baseDomain ?? '–'}</strong></div>
      <div className="stat"><span className="label">Adresse in Airlock</span><strong>/u/{env.slug}</strong></div>
    </div>
  )
}

/* --- Allgemein ---------------------------------------------------------------------- */

function General({ env }: { env: EnvironmentDto }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState(env.name)
  const [short, setShort] = useState(env.short)
  useEffect(() => { setName(env.name); setShort(env.short) }, [env.id, env.name, env.short])
  const done = () => void qc.invalidateQueries({ queryKey: ['environments'] })
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.updateEnvironment(env.slug, patch),
    onSuccess: () => { done(); toast.success('Gespeichert') },
  })
  const [confirmDefault, setConfirmDefault] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const remove = useMutation({
    mutationFn: () => api.deleteEnvironment(env.slug),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['environments'] })
      toast.success(`Umgebung «${env.name}» gelöscht`)
      navigate('/umgebungen')
    },
  })
  const dirty = name.trim() !== env.name || short.trim().toUpperCase() !== env.short
  const deleteBlocked = env.isDefault
    ? 'Die Standard-Umgebung lässt sich nicht löschen. Zuerst eine andere zur Standard-Umgebung machen.'
    : env.projects > 0 || env.externalTargets > 0
      ? `Die Umgebung hat noch ${[env.projects ? `${env.projects} ${env.projects === 1 ? 'Projekt' : 'Projekte'}` : '', env.externalTargets ? `${env.externalTargets} externe ${env.externalTargets === 1 ? 'Ziel' : 'Ziele'}` : ''].filter(Boolean).join(' und ')}. Zuerst löschen oder verschieben.`
      : null

  return (
    <>
      <form className="field-group" noValidate onSubmit={(e) => { e.preventDefault(); save.mutate({ name: name.trim(), short: short.trim().toUpperCase() }) }}>
        <legend>Umgebung</legend>
        <div className="field-row">
          <Field id="env-name" label="Name"><input id="env-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></Field>
          <Field id="env-short" label="Kürzel" hint="Zwei Zeichen, im Umschalter oben links."><input id="env-short" aria-describedby="env-short-hint" value={short} onChange={(e) => setShort(e.target.value.slice(0, 2))} maxLength={2} className="input-short" /></Field>
        </div>
        <p className="hint">Adresse in Airlock: <code>/u/{env.slug}</code>{env.isDefault ? ' · Standard-Umgebung: alte Adressen ohne /u/… führen hierher, die Oberfläche läuft unter ihrer internen Basis.' : ''}</p>
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={!dirty || save.isPending}>{save.isPending ? 'Wird gespeichert…' : 'Speichern'}</button>
        </div>
        {save.isError && <p role="alert" className="error">{(save.error as Error).message}</p>}
      </form>

      <fieldset className="field-group">
        <legend>Benachrichtigungen</legend>
        <label className="choice">
          <input type="checkbox" checked={env.notifyMuted} onChange={(e) => save.mutate({ notifyMuted: e.target.checked })} />
          <span>Für diese Umgebung stumm<small>Die Kanäle (Push, E-Mail) gelten für alle Umgebungen; Meldungen nennen die Umgebung im Titel.</small></span>
        </label>
      </fieldset>

      {!env.isDefault && (
        <fieldset className="field-group">
          <legend>Standard-Umgebung</legend>
          <p className="hint">Die Oberfläche von Airlock läuft unter der internen Basis der Standard-Umgebung. Wechselt der Standard, wandert ihre Adresse mit; die alte leitet nicht weiter.</p>
          <div className="form-actions">
            {!confirmDefault ? (
              <button type="button" onClick={() => setConfirmDefault(true)}>Zur Standard-Umgebung machen …</button>
            ) : (
              <>
                <span className="confirm-note"><IconWarn /> Die Oberfläche ist danach unter deployer.{env.baseDomain ?? '…'} erreichbar.</span>
                <button type="button" onClick={() => setConfirmDefault(false)}>Abbrechen</button>
                <button type="button" className="button-primary" onClick={() => { setConfirmDefault(false); save.mutate({ makeDefault: true }) }} autoFocus>Ja, zum Standard machen</button>
              </>
            )}
          </div>
        </fieldset>
      )}

      <section className="danger-zone">
        <h2>Umgebung löschen</h2>
        <p>Entfernt Tailnet-Eintrag, Zertifikat und Tokens der Umgebung. Den Tunnel nur, wenn ihn keine andere Umgebung nutzt.</p>
        {deleteBlocked ? (
          <p className="hint" id="env-delete-blocked">{deleteBlocked}</p>
        ) : null}
        <div className="form-actions">
          {!confirmDelete ? (
            <button type="button" className="button-danger" onClick={() => setConfirmDelete(true)} disabled={Boolean(deleteBlocked)} aria-describedby={deleteBlocked ? 'env-delete-blocked' : undefined}>Umgebung löschen …</button>
          ) : (
            <>
              <span className="confirm-note"><IconWarn /> «{env.name}» und ihre Tokens werden gelöscht.</span>
              <button type="button" onClick={() => setConfirmDelete(false)}>Abbrechen</button>
              <button type="button" className="button-danger-solid" onClick={() => remove.mutate()} disabled={remove.isPending} autoFocus>{remove.isPending ? 'Wird gelöscht…' : 'Ja, löschen'}</button>
            </>
          )}
        </div>
        {remove.isError && <p role="alert" className="error">{(remove.error as Error).message}</p>}
      </section>
    </>
  )
}

/* --- Cloudflare & HTTPS: Namen auflösen ----------------------------------------------- */

function NameResolution({ env }: { env: EnvironmentDto }) {
  const cf = useQuery({ queryKey: ['cloudflare'], queryFn: api.cloudflare })
  const dns = useQuery({ queryKey: ['lan-dns', env.slug], queryFn: api.lanDns, enabled: false })
  const [copied, setCopied] = useState(false)
  const tailscale = cf.data?.tailscaleIp
  const d = dns.data
  return (
    <>
      <h2 className="env-section-title">Namen auflösen</h2>
      <p className="hint">Projekte dieser Umgebung sind intern unter <code>&lt;name&gt;.{env.baseDomain}</code> erreichbar, aus dem LAN und dem Tailnet.</p>
      <ul className="check-list">
        <li className={tailscale ? 'check-ok' : 'check-none'}>
          <span className="check-name">Tailnet</span>
          <span className="check-detail">{tailscale ? `*.${env.baseDomain} → ${tailscale} (Cloudflare, nicht proxied)` : 'keine Tailscale-IP bekannt (Server → Übersicht)'}</span>
        </li>
        <li className={!d ? 'check-none' : d.ok ? 'check-ok' : 'check-fail'}>
          <span className="check-name">Lokaler DNS</span>
          <span className="check-detail">
            {d ? d.detail : dns.isFetching ? 'wird geprüft…' : 'noch nicht geprüft'}
            {' '}<button type="button" className="button-small" onClick={() => void dns.refetch()} disabled={dns.isFetching}>{d ? 'Erneut prüfen' : 'Prüfen'}</button>
          </span>
        </li>
      </ul>
      {d?.line && (
        <div className="lan-dns-line">
          <p className="hint">Im Heimnetz soll der lokale DNS (Router, AdGuard oder Pi-hole) diese Umschreibung haben:</p>
          <pre className="code-block">{d.line}</pre>
          <button type="button" className="button-small" onClick={async () => { setCopied(await copyText(d.line ?? '')); setTimeout(() => setCopied(false), 2000) }}>{copied ? 'Kopiert' : 'Zeile kopieren'}</button>
        </div>
      )}
    </>
  )
}

/* --- Standards: Header-Vorlagen, Access ------------------------------------------------- */

function HeaderTemplates() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['header-templates'], queryFn: api.headerTemplates })
  const [editing, setEditing] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const [adding, setAdding] = useState<string>('')
  const set = useMutation({
    mutationFn: ({ header, v }: { header: string; v: string }) => api.setHeaderTemplate(header, v),
    onSuccess: (r) => { qc.setQueryData(['header-templates'], r); setEditing(null); setAdding('') },
  })
  const remove = useMutation({
    mutationFn: (header: string) => api.removeHeaderTemplate(header),
    onSuccess: (r) => qc.setQueryData(['header-templates'], r),
  })
  const list = q.data?.templates ?? []
  const missing = templateHeaderKeys.filter((h) => !list.some((t) => t.header === h))
  const scope = (t: HeaderTemplateDto) => {
    const own = t.overriddenBy.filter((o) => o.mode === 'own').map((o) => o.project)
    const off = t.overriddenBy.filter((o) => o.mode === 'off').map((o) => o.project)
    return [
      `${t.appliesTo} von ${t.projects} ${t.projects === 1 ? 'Projekt' : 'Projekten'}`,
      own.length ? `${own.join(', ')} mit eigener Regel` : '',
      off.length ? `für ${off.join(', ')} abgeschaltet` : '',
    ].filter(Boolean).join(' · ')
  }

  return (
    <>
      <h2 className="env-section-title">Header-Vorlagen</h2>
      <p className="hint">Caddy setzt diese Header für jedes Projekt der Umgebung, solange das Projekt keine eigene Regel hat. Eine Änderung wirkt sofort auf alle, ohne Redeploy. Die Content-Security-Policy bleibt pro Projekt.</p>
      {q.isLoading ? <p className="state state-loading">Wird geladen…</p> : (
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Header</th><th>Wert</th><th>Zustand</th><th>Gilt für</th><th><span className="visually-hidden">Aktion</span></th></tr></thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.header}>
                  <td className="cell-main">{HEADER_LABEL[t.header as HeaderKey]}</td>
                  <td>
                    {editing === t.header ? (
                      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); set.mutate({ header: t.header, v: value }) }}>
                        <label htmlFor={`tpl-${t.header}`} className="visually-hidden">Wert für {HEADER_LABEL[t.header as HeaderKey]}</label>
                        <input id={`tpl-${t.header}`} value={value} onChange={(e) => setValue(e.target.value)} autoFocus spellCheck={false} />
                        <button type="submit" className="button-small button-primary" disabled={set.isPending}>Speichern</button>
                        <button type="button" className="button-small" onClick={() => setEditing(null)}>Abbrechen</button>
                      </form>
                    ) : <code className="muted">{t.value}</code>}
                  </td>
                  <td><span className="status status-running"><span className="status-dot" aria-hidden="true" />aktiv</span></td>
                  <td className="muted">{scope(t)}</td>
                  <td className="row-actions">
                    {editing !== t.header && <>
                      <button type="button" className="button-small" onClick={() => { setEditing(t.header); setValue(t.value) }}>Ändern</button>
                      <button type="button" className="button-small" onClick={() => remove.mutate(t.header)} disabled={remove.isPending}>Entfernen</button>
                    </>}
                  </td>
                </tr>
              ))}
              {missing.map((h) => (
                <tr key={h}>
                  <td className="cell-main">{HEADER_LABEL[h]}</td>
                  <td>
                    {adding === h ? (
                      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); set.mutate({ header: h, v: value }) }}>
                        <label htmlFor={`tpl-${h}`} className="visually-hidden">Wert für {HEADER_LABEL[h]}</label>
                        <input id={`tpl-${h}`} value={value} onChange={(e) => setValue(e.target.value)} autoFocus spellCheck={false} />
                        <button type="submit" className="button-small button-primary" disabled={set.isPending}>Speichern</button>
                        <button type="button" className="button-small" onClick={() => setAdding('')}>Abbrechen</button>
                      </form>
                    ) : <span className="muted">–</span>}
                  </td>
                  <td><span className="status status-stopped"><span className="status-dot" aria-hidden="true" />aus</span></td>
                  <td className="muted">{h === 'strict-transport-security' ? 'nur unter HTTPS mit echtem Zertifikat' : 'keine Vorlage'}</td>
                  <td className="row-actions">
                    {adding !== h && <button type="button" className="button-small" onClick={() => { setAdding(h); setValue(HEADER_DEFAULT[h]) }}>Vorgeben …</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {set.isError && <p role="alert" className="error">{(set.error as Error).message}</p>}
      {remove.isError && <p role="alert" className="error">{(remove.error as Error).message}</p>}
    </>
  )
}

function AccessDefaults({ env }: { env: EnvironmentDto }) {
  const qc = useQueryClient()
  const [on, setOn] = useState(env.accessDefault)
  const [email, setEmail] = useState(env.accessEmails[0] ?? '')
  useEffect(() => { setOn(env.accessDefault); setEmail(env.accessEmails[0] ?? '') }, [env.id, env.accessDefault, env.accessEmails])
  const save = useMutation({
    mutationFn: () => api.updateEnvironment(env.slug, { accessDefault: on, accessEmails: email.trim() ? [email.trim()] : [] }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['environments'] }); toast.success('Access-Standard gespeichert') },
  })
  const dirty = on !== env.accessDefault || email.trim() !== (env.accessEmails[0] ?? '')
  return (
    <form className="field-group access-defaults" noValidate onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
      <legend>Cloudflare Access</legend>
      <p className="hint">Standard für neue öffentliche Projekte dieser Umgebung. Bestehende Projekte behalten ihre Einstellung.</p>
      <label className="choice">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span>Neue öffentliche Projekte hinter Access stellen<small>Anmeldung per E-Mail-Code, nur mit der Adresse unten.</small></span>
      </label>
      <Field id="access-email" label="Erlaubte E-Mail-Adresse" optional={!on}>
        <input id="access-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="hallo@example.ch" spellCheck={false} />
      </Field>
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={!dirty || save.isPending || (on && !email.trim())}>{save.isPending ? 'Wird gespeichert…' : 'Speichern'}</button>
        {on && !email.trim() && <span className="hint">Mit Access braucht es eine E-Mail-Adresse.</span>}
      </div>
      {save.isError && <p role="alert" className="error">{(save.error as Error).message}</p>}
    </form>
  )
}

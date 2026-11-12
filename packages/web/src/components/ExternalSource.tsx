import { useEffect, useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { checkExternalAddress, type ExternalContainerDto, type ExternalProbeDto } from '@airlock/shared'
import { api } from '../api.js'
import { FieldError } from './Field.js'
import { IconBad, IconOk, IconWarn } from './Icons.js'
import { ErrorState, Loading, SkRows } from './States.js'

/**
 * Neues Projekt › Bestehender Dienst: etwas, das schon läuft, über Airlock
 * erreichbar machen – ohne es zu verwalten. Zwei Wege: ein Container auf
 * diesem Server (Liste, nur lesen) oder eine Adresse im Heimnetz. Vor dem
 * Anlegen prüft Airlock die Erreichbarkeit und zeigt das Ergebnis.
 */
export interface ExternalDraft {
  mode: 'container' | 'address'
  container: string
  port: string
  url: string
  insecureTls: boolean
  /** Zugang «Airlock-Login» gleich beim Anlegen */
  login: boolean
}

export const emptyExternal: ExternalDraft = { mode: 'container', container: '', port: '', url: '', insecureTls: false, login: false }

/** Quelle für die API aus dem Entwurf */
export function externalSource(d: ExternalDraft) {
  return d.mode === 'container'
    ? { type: 'external' as const, container: d.container || undefined, port: d.port.trim() === '' ? undefined : Number(d.port) }
    : { type: 'external' as const, url: d.url.trim() || undefined, insecureTls: d.insecureTls }
}

type Probe = { state: 'idle' } | { state: 'busy' } | { state: 'done'; probe: ExternalProbeDto; key: string } | { state: 'error'; message: string }

const keyOf = (d: ExternalDraft) => (d.mode === 'container' ? `c:${d.container}:${d.port}` : `a:${d.url.trim()}:${d.insecureTls}`)

export function useExternalProbe(d: ExternalDraft) {
  const [p, setP] = useState<Probe>({ state: 'idle' })
  const key = keyOf(d)
  // Eingabe geändert: altes Ergebnis gilt nicht mehr
  useEffect(() => { setP((x) => (x.state === 'done' && x.key !== key ? { state: 'idle' } : x)) }, [key])
  const run = async (): Promise<ExternalProbeDto | null> => {
    setP({ state: 'busy' })
    try {
      const { probe } = await api.externalProbe(externalSource(d))
      setP({ state: 'done', probe, key })
      return probe
    } catch (err) {
      setP({ state: 'error', message: (err as Error).message })
      return null
    }
  }
  const current = p.state === 'done' && p.key === key ? p.probe : null
  return { p, run, current }
}

export function ExternalFields({ d, onChange, errors, probe, idFor }: {
  d: ExternalDraft
  onChange: (d: ExternalDraft) => void
  errors: Record<string, string | undefined>
  probe: ReturnType<typeof useExternalProbe>
  idFor: (k: string) => string
}) {
  const containers = useQuery({ queryKey: ['external-containers'], queryFn: api.externalContainers, enabled: d.mode === 'container' })
  const list = containers.data?.containers ?? []
  const selected = list.find((c) => c.name === d.container)
  const set = (patch: Partial<ExternalDraft>) => onChange({ ...d, ...patch })
  const addr = d.url.trim() ? checkExternalAddress(d.url) : null
  const portListId = useId()

  // Container gewählt: Port vorschlagen (einziger bzw. erster bekannter)
  const pick = (c: ExternalContainerDto) => set({ container: c.name, port: c.ports[0] ? String(c.ports[0].port) : '', login: d.login || Boolean(c.adminUi) })

  return (
    <>
      <div className="origin-switch" role="radiogroup" aria-label="Wo läuft der Dienst?">
        <label className="choice">
          <input type="radio" name="ext-mode" checked={d.mode === 'container'} onChange={() => set({ mode: 'container' })} />
          <span>Container auf diesem Server</span>
        </label>
        <label className="choice">
          <input type="radio" name="ext-mode" checked={d.mode === 'address'} onChange={() => set({ mode: 'address' })} />
          <span>Adresse im Heimnetz</span>
        </label>
      </div>

      {d.mode === 'container' ? (
        <>
          <fieldset className={`field ext-pick${errors['source.container'] ? ' field-invalid' : ''}`} aria-describedby={`${idFor('source.container')}-hint`}>
            <legend className="label">Container</legend>
            <p className="hint" id={`${idFor('source.container')}-hint`}>
              Laufende Container, die nicht von Airlock stammen. Airlock liest sie nur – keine Labels, kein Neustart.
            </p>
            {!containers.data && containers.isError ? (
              <ErrorState what="Die Container-Liste" error={containers.error} retrying={containers.isFetching} onRetry={() => void containers.refetch()} />
            ) : !containers.data ? (
              <Loading label="Container werden gelesen"><SkRows n={3} /></Loading>
            ) : list.length === 0 ? (
              <p className="empty-inline">Kein passender Container läuft gerade.</p>
            ) : (
              <ul className="ext-list">
                {list.map((c) => (
                  <li key={c.id}>
                    <label className={`choice ext-item${c.takenBy ? ' choice-disabled' : ''}`}>
                      <input type="radio" name="ext-container" value={c.name} checked={d.container === c.name} disabled={Boolean(c.takenBy)} onChange={() => pick(c)} />
                      <span>
                        <strong>{c.name}</strong>
                        <small className="ext-meta">
                          <code>{c.image}</code>
                          {c.composeProject && <> · Compose {c.composeProject}</>}
                          {c.hostMode ? ' · Host-Netz' : c.networks.length ? ` · Netz ${c.networks.join(', ')}` : ''}
                          {c.ports.length > 0 && <> · Port {c.ports.map((p) => p.port).join(', ')}</>}
                        </small>
                        {c.takenBy && <small>Schon über Airlock erreichbar: {c.takenBy}</small>}
                        {!c.takenBy && c.adminUi && <small className="ext-admin"><IconWarn /> Verwaltungsoberfläche ({c.adminUi.name})</small>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {errors['source.container'] && <FieldError id={idFor('source.container')} message={errors['source.container']} />}
          </fieldset>

          {selected && (
            <div className={errors['source.port'] ? 'field field-invalid' : 'field'}>
              <label htmlFor={idFor('source.port')}>Port im Container</label>
              <input id={idFor('source.port')} inputMode="numeric" list={portListId} value={d.port} onChange={(x) => set({ port: x.target.value })}
                aria-describedby={`${idFor('source.port')}-hint`} aria-invalid={Boolean(errors['source.port']) || undefined} />
              <datalist id={portListId}>{selected.ports.map((p) => <option key={p.port} value={p.port} />)}</datalist>
              <p className="hint" id={`${idFor('source.port')}-hint`}>
                {selected.ports.length ? `Bekannt: ${selected.ports.map((p) => (p.published ? `${p.port} (veröffentlicht als ${p.published})` : p.port)).join(', ')}.` : 'Das Image nennt keinen Port – gib ihn ein, z.B. 8080.'}
                {selected.hostMode ? ' Im Host-Netz erreicht Caddy ihn über den Docker-Host.' : ''}
              </p>
              {errors['source.port'] && <FieldError id={idFor('source.port')} message={errors['source.port']} />}
            </div>
          )}
        </>
      ) : (
        <>
          <div className={errors['source.url'] ? 'field field-invalid' : 'field'}>
            <label htmlFor={idFor('source.url')}>Adresse</label>
            <input id={idFor('source.url')} value={d.url} onChange={(x) => set({ url: x.target.value })} placeholder="http://192.168.1.20:8123"
              inputMode="url" autoComplete="off" spellCheck={false} aria-describedby={`${idFor('source.url')}-hint`} aria-invalid={Boolean(errors['source.url']) || undefined} />
            <p className="hint" id={`${idFor('source.url')}-hint`}>
              IP und Port im Heimnetz (192.168.x, 10.x, 172.16–31.x) oder im Tailnet (100.64–127.x). Ein Name geht nicht – er könnte später woanders hinzeigen.
            </p>
            {errors['source.url'] && <FieldError id={idFor('source.url')} message={errors['source.url']} />}
          </div>
          {addr?.ok && addr.scheme === 'https' && (
            <label className="choice">
              <input type="checkbox" checked={d.insecureTls} onChange={(x) => set({ insecureTls: x.target.checked })} />
              <span>
                Eigenes Zertifikat erlauben
                <small>Für Geräte mit selbstsigniertem HTTPS (NAS, Router). Die Verbindung bleibt verschlüsselt, das Zertifikat prüft Airlock dann nicht.</small>
              </span>
            </label>
          )}
        </>
      )}

      <ProbeResult probe={probe} canRun={d.mode === 'container' ? Boolean(d.container && d.port) : Boolean(addr?.ok)} />

      <label className="choice">
        <input type="checkbox" checked={d.login} onChange={(x) => set({ login: x.target.checked })} />
        <span>
          Mit Airlock-Login schützen
          <small>Vor jeder Anfrage an die Adresse fragt Airlock nach deiner Anmeldung (mit Passkey). Empfohlen für alles, womit man Server, Netz oder Daten verwalten kann.</small>
        </span>
      </label>
    </>
  )
}

function ProbeResult({ probe, canRun }: { probe: ReturnType<typeof useExternalProbe>; canRun: boolean }) {
  const p = probe.p
  const r = probe.current
  return (
    <div className="ext-probe-box">
      <div className="ext-probe-head">
        <button type="button" onClick={() => void probe.run()} disabled={!canRun || p.state === 'busy'} aria-busy={p.state === 'busy' || undefined}>
          {r ? 'Noch einmal prüfen' : 'Erreichbarkeit prüfen'}
        </button>
        {!canRun && <span className="hint">Erst Container und Port bzw. eine gültige Adresse angeben.</span>}
      </div>
      <div role="status" aria-live="polite">
        {p.state === 'busy' && <p className="hint">Airlock fragt das Ziel an …</p>}
        {p.state === 'error' && <p className="ext-probe ext-probe-bad"><IconBad /> {p.message}</p>}
        {r && (
          <div className={`ext-probe ${r.ok ? 'ext-probe-ok' : r.selfSigned ? 'ext-probe-warn' : 'ext-probe-bad'}`}>
            <p>
              {r.ok ? <IconOk /> : r.selfSigned ? <IconWarn /> : <IconBad />}{' '}
              <strong>{r.ok ? 'Erreichbar' : 'Nicht erreichbar'}</strong>
              {r.ms !== null && r.status !== null && <span className="muted"> · HTTP {r.status} in {r.ms} ms</span>}
              {r.via && <span className="muted"> · {r.via}</span>}
            </p>
            <p>{r.detail}</p>
            {r.adminUi && (
              <p><IconWarn /> {r.adminUi.name} erkannt: öffentlich nur mit Schutz (Airlock-Login oder Cloudflare Access).</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

import { useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  repoAddressKind, shortFingerprint,
  type CreateGitCredentialInput, type GitCredentialDto, type GitHostKeyDto, type ProjectDto, type RepoCheckDto,
} from '@airlock/shared'
import { api, ApiError } from '../api.js'
import { copyText } from '../lib/clipboard.js'
import { notifyOk } from '../lib/feedback.js'
import { relativeTime } from '../lib/format.js'
import { fmtDate } from '../lib/dates.js'
import { IconAlert, IconExternal, IconKey, IconOk, IconWarn } from './Icons.js'
import { ErrorState, Loading, SkLines } from './States.js'
import { SetRow } from './Publication.js'
import { ConfirmDialog } from './Confirm.js'

/**
 * Nacht 3, Etappe 2: Zugang zu privaten Repos – Teile für «Neues Projekt»
 * und Einstellungen › Repo-Zugang.
 *
 * - Öffentlicher Schlüssel zum Kopieren (der private verlässt den Server nie)
 * - «Repo prüfen» mit klarer Meldung und Weg (Link)
 * - Server-Schlüssel beim ersten Verbinden zeigen und bestätigen (TOFU)
 *
 * Zustände immer mit Text und Zeichen, nie nur über Farbe.
 */

export type AccessMode = 'auto' | 'deploy_key' | 'token'

const isGithub = (url: string) => /^https:\/\/(www\.)?github\.com\//i.test(url.trim())

/** Wo man den Deploy-Key einträgt – je nach Anbieter */
export function deployKeyHint(repoUrl: string): string {
  const u = repoUrl.toLowerCase()
  if (u.includes('github.com')) return 'Bei GitHub unter Settings › Deploy keys › Add deploy key eintragen, «Allow write access» aus lassen.'
  if (u.includes('gitlab')) return 'Bei GitLab unter Settings › Repository › Deploy keys eintragen, «Grant write permissions» aus lassen (nur lesend).'
  return 'Beim Anbieter unter «Deploy Keys» eintragen (GitLab: Settings › Repository, Gitea: Einstellungen › Deploy-Schlüssel), nur lesend.'
}

/** Öffentlicher Schlüssel mit «Kopieren» */
export function PublicKeyBox({ credential, repoUrl }: { credential: GitCredentialDto; repoUrl: string }) {
  const [copied, setCopied] = useState<'ok' | 'manual' | null>(null)
  const keyId = useId()
  if (!credential.publicKey) return null
  return (
    <div className="repo-key">
      <p className="repo-key-head"><IconKey size={14} /> Öffentlicher Schlüssel</p>
      <code className="totp-secret repo-key-value" id={keyId}>{credential.publicKey}</code>
      {credential.keyFingerprint && <p className="hint repo-fp">Fingerabdruck <code>{credential.keyFingerprint}</code></p>}
      <div className="repo-key-actions">
        <button type="button" className="button-small" aria-describedby={keyId}
          onClick={async () => setCopied((await copyText(credential.publicKey!)) ? 'ok' : 'manual')}>
          Kopieren
        </button>
        <span className="hint repo-key-hint" role="status">
          {copied === 'ok' ? 'Kopiert. ' : copied === 'manual' ? 'Kopieren ging nicht – bitte von Hand markieren. ' : ''}
          {deployKeyHint(repoUrl)}
        </span>
      </div>
    </div>
  )
}

/** Ergebnis von «Repo prüfen»; bei einem neuen Server die Bestätigung */
export function RepoCheckResult({ check, onConfirm, confirming, confirmError }: {
  check: RepoCheckDto
  onConfirm?: (host: string, keys: GitHostKeyDto[]) => void
  confirming?: boolean
  confirmError?: string | null
}) {
  if (check.ok) {
    return (
      <p className="repo-check repo-check-ok">
        <IconOk size={16} /> <span><strong>Erreichbar.</strong> {check.message.replace(/^Erreichbar /, '')}</span>
      </p>
    )
  }
  if (check.code === 'host_key_unknown' && check.hostKey) {
    const hk = check.hostKey
    return (
      <div className="repo-check repo-check-warn">
        <IconWarn size={16} />
        <div className="repo-check-body">
          <p><strong>Server bestätigen.</strong> {check.message}</p>
          <dl className="repo-hostkeys">
            {hk.keys.map((k) => (
              <div key={k.fingerprint}>
                <dt>{k.type}</dt>
                <dd><code>{k.fingerprint}</code></dd>
              </div>
            ))}
          </dl>
          <p className="hint">GitLab.com nennt seine Fingerabdrücke unter docs.gitlab.com › «SSH host keys fingerprints», GitHub unter docs.github.com › «GitHub's SSH key fingerprints»; bei einem eigenen Server zeigt sie <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>.</p>
          {confirmError && <p className="error" role="alert">{confirmError}</p>}
          {onConfirm && (
            <div className="form-actions">
              <button type="button" className="button-small" disabled={confirming} aria-busy={confirming || undefined} onClick={() => onConfirm(hk.host, hk.keys)}>
                Fingerabdruck stimmt – {hk.host} vertrauen
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="repo-check repo-check-bad">
      <IconAlert size={16} />
      <div className="repo-check-body">
        <p><strong>Nicht erreichbar.</strong> {check.message}</p>
        {check.link && (
          <p>
            {check.link.external
              ? <a href={check.link.href} target="_blank" rel="noreferrer">{check.link.label} <IconExternal /></a>
              : <Link to={check.link.href}>{check.link.label}</Link>}
          </p>
        )}
      </div>
    </div>
  )
}

const errText = (err: unknown) => (err instanceof ApiError ? err.message : (err as Error).message)

/**
 * Zustand des Abschnitts «Zugang» im Formular Neues Projekt. ensureOk() prüft
 * vor dem Anlegen (wenn nicht schon für genau diese Eingaben geprüft).
 */
export function useRepoAccess(repoUrl: string, ref: string) {
  const [mode, setModeRaw] = useState<AccessMode>('auto')
  const [sshKey, setSshKey] = useState<GitCredentialDto | null>(null)
  const [token, setToken] = useState<GitCredentialDto | null>(null)
  const [check, setCheck] = useState<{ key: string; result: RepoCheckDto } | null>(null)
  const [busy, setBusy] = useState<'key' | 'token' | 'check' | 'confirm' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)

  const credential = mode === 'deploy_key' ? sshKey : mode === 'token' ? token : null
  const r = ref.trim() || undefined
  const key = JSON.stringify([repoUrl.trim(), r ?? '', credential?.id ?? ''])
  const current = check?.key === key ? check.result : null

  function setMode(m: AccessMode) {
    setModeRaw(m)
    setCheck(null)
    setError(null)
  }

  async function run(): Promise<RepoCheckDto | null> {
    if (!repoUrl.trim()) return null
    setBusy('check')
    setError(null)
    setConfirmError(null)
    try {
      const { check: result } = await api.gitCheck({ repoUrl: repoUrl.trim(), ref: r, credentialId: credential?.id })
      setCheck({ key, result })
      return result
    } catch (err) {
      setError(errText(err))
      return null
    } finally {
      setBusy(null)
    }
  }

  return {
    mode, setMode, credential, sshKey, token, current, busy, error, confirmError,
    /** Für das Formular: Zugang, der mitgeht */
    credentialId: mode === 'auto' ? undefined : credential?.id,
    run,
    async createKey() {
      setBusy('key')
      setError(null)
      try {
        setSshKey((await api.gitCreateCredential({ kind: 'ssh_key' })).credential)
        setCheck(null)
      } catch (err) {
        setError(errText(err))
      } finally {
        setBusy(null)
      }
    },
    async saveToken(username: string, value: string): Promise<boolean> {
      setBusy('token')
      setError(null)
      try {
        setToken((await api.gitCreateCredential({ kind: 'https_token', token: value, ...(username.trim() ? { username: username.trim() } : {}) })).credential)
        setCheck(null)
        return true
      } catch (err) {
        setError(errText(err))
        return false
      } finally {
        setBusy(null)
      }
    },
    async confirm(host: string, keys: GitHostKeyDto[]) {
      if (!sshKey) return
      setBusy('confirm')
      setConfirmError(null)
      try {
        setSshKey((await api.gitConfirmHostKey(sshKey.id, host, keys.map((k) => k.fingerprint))).credential)
      } catch (err) {
        setConfirmError(errText(err))
        setBusy(null)
        return
      }
      setBusy(null)
      await run()
    },
    /** Vor dem Anlegen: geprüft und erreichbar? Sonst steht die Meldung im Abschnitt. */
    async ensureOk(): Promise<boolean> {
      if (mode !== 'auto' && !credential) {
        setError(mode === 'deploy_key' ? 'Zuerst den Deploy-Key erzeugen und beim Anbieter eintragen.' : 'Zuerst das Token speichern.')
        return false
      }
      const res = current ?? (await run())
      return Boolean(res?.ok)
    },
  }
}

export type RepoAccessState = ReturnType<typeof useRepoAccess>

/* --- Einstellungen › Repo-Zugang --------------------------------------------------------- */

type Confirm = null | 'key' | 'remove' | 'forget'

/** Karte in den Projekt-Einstellungen; nur bei Projekten aus einem Git-Repo */
export function RepoAccessSettings({ p }: { p: ProjectDto }) {
  const qc = useQueryClient()
  const titleId = useId()
  const uid = useId()
  const repoUrl = (p.source && 'repoUrl' in p.source ? p.source.repoUrl : undefined) ?? ''
  const q = useQuery({ queryKey: ['git-access', p.id], queryFn: () => api.projectGitAccess(p.id), enabled: Boolean(repoUrl) })
  const [check, setCheck] = useState<RepoCheckDto | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [tokenForm, setTokenForm] = useState(false)
  const [user, setUser] = useState('')
  const [tok, setTok] = useState('')
  const refresh = () => void qc.invalidateQueries({ queryKey: ['git-access', p.id] })

  const run = useMutation({
    meta: { errorTitle: 'Repo nicht geprüft' },
    mutationFn: () => api.projectGitCheck(p.id),
    onSuccess: (r) => setCheck(r.check),
  })
  const confirmHost = useMutation({
    meta: { errorTitle: 'Server nicht bestätigt', quiet: true },
    mutationFn: ({ host, fps }: { host: string; fps: string[] }) => api.confirmProjectHostKey(p.id, host, fps),
    onSuccess: () => { refresh(); run.mutate() },
  })
  const setAccess = useMutation({
    meta: { errorTitle: 'Zugang nicht gespeichert', quiet: true },
    mutationFn: (input: CreateGitCredentialInput) => api.setProjectGitAccess(p.id, input),
    onSuccess: (_r, input) => {
      refresh()
      setCheck(null)
      setConfirm(null)
      setTokenForm(false)
      setTok('')
      notifyOk(input.kind === 'ssh_key' ? 'Neuer Deploy-Key erzeugt' : 'Token gespeichert', {
        id: `git-access-${p.id}`,
        description: input.kind === 'ssh_key' ? 'Den öffentlichen Schlüssel beim Anbieter eintragen, dann «Prüfen».' : 'Verschlüsselt gespeichert; «Prüfen» zeigt, ob es reicht.',
      })
    },
  })
  const remove = useMutation({
    meta: { errorTitle: 'Zugang nicht entfernt', quiet: true },
    mutationFn: () => api.removeProjectGitAccess(p.id),
    onSuccess: () => { refresh(); setCheck(null); setConfirm(null); notifyOk('Zugang entfernt', { id: `git-access-${p.id}` }) },
  })
  const forget = useMutation({
    meta: { errorTitle: 'Server nicht zurückgesetzt', quiet: true },
    mutationFn: () => api.forgetProjectHostKey(p.id),
    onSuccess: () => { refresh(); setConfirm(null); run.mutate() },
  })

  if (!repoUrl) return null
  const kind = repoAddressKind(repoUrl)
  const a = q.data?.access
  const cred = a?.credential ?? null
  const viaText = !a ? '' : a.via === 'github_app' ? 'GitHub-App' : a.via === 'deploy_key' ? 'Deploy-Key (SSH)' : a.via === 'token' ? 'Zugangstoken (HTTPS)' : 'Öffentlich, ohne Zugang'
  const viaNote = !a ? '' : a.via === 'github_app' ? 'pro Deploy ein Token, nur lesend, nur dieses Repo'
    : a.via === 'anonym' ? (a.githubRepo ? 'für ein privates Repo der GitHub-App Zugriff geben'
      : kind === 'http' ? 'für ein privates Repo: SSH-Adresse mit Deploy-Key (Token nur über https://)'
      : 'für ein privates Repo: Token hinterlegen oder SSH-Adresse mit Deploy-Key')
    : a.via === 'token' ? `Benutzer ${cred?.username ?? ''} · verschlüsselt gespeichert, wird nie angezeigt` : ''
  const busyConfirm = confirm === 'key' ? setAccess.isPending : confirm === 'remove' ? remove.isPending : forget.isPending
  const confirmError = confirm === 'key' ? setAccess.error : confirm === 'remove' ? remove.error : forget.error

  return (
    <section className="set-card" id="set-repo-zugang" aria-labelledby={titleId}>
      <div className="set-head">
        <h2 id={titleId} tabIndex={-1}>Repo-Zugang</h2>
        <div className="set-head-actions">
          <button type="button" className="button-small" onClick={() => run.mutate()} disabled={run.isPending} aria-busy={run.isPending || undefined}>Prüfen</button>
        </div>
      </div>
      {!q.data && q.isError ? <div className="set-row-note"><ErrorState compact what="Der Repo-Zugang" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} /></div>
        : !a ? <Loading label="Repo-Zugang wird geladen" className="set-row-note"><SkLines n={2} /></Loading> : (
        <>
          {/* Ohne eigenen Zugang: was zur Adresse passt (Deploy-Key nur mit SSH-Adresse, Token nur mit https://, nicht neben der GitHub-App) */}
          <SetRow label="Weg" action={!cred && (kind === 'ssh' || (kind === 'https' && !a.githubAppAccess)) ? (
            <span className="repo-actions">
              {kind === 'ssh'
                ? <button type="button" className="button-small" onClick={() => setAccess.mutate({ kind: 'ssh_key' })} disabled={setAccess.isPending}>Deploy-Key einrichten</button>
                : <button type="button" className="button-small" onClick={() => setTokenForm((v) => !v)} aria-expanded={tokenForm}>Token hinterlegen</button>}
            </span>
          ) : undefined}>
            <strong className="set-strong">{viaText}</strong>
            {viaNote && <span className="muted"> · {viaNote}</span>}
          </SetRow>
          {cred?.kind === 'ssh_key' && (
            <>
              <div className="set-row-block">
                <PublicKeyBox credential={cred} repoUrl={repoUrl} />
              </div>
              <SetRow label="Server" action={cred.host ? <button type="button" className="button-small" onClick={() => setConfirm('forget')}>Neu bestätigen …</button> : undefined}>
                {cred.host && cred.hostKeys.length ? (
                  <>
                    <IconOk size={14} className="repo-inline-ok" /> <strong className="set-strong">{cred.host}</strong>
                    <span className="muted"> · bestätigt{cred.hostConfirmedAt ? ` am ${fmtDate(cred.hostConfirmedAt, '')}` : ''} · {cred.hostKeys.map((k) => `${k.type.replace(/^ssh-|-sha2-nistp\d+$/g, '')} ${shortFingerprint(k.fingerprint)}`).join(', ')}</span>
                  </>
                ) : (
                  <><IconWarn /> <span className="muted">noch nicht bestätigt – «Prüfen» zeigt den Fingerabdruck</span></>
                )}
              </SetRow>
            </>
          )}
          {cred?.lastUsedAt && (
            <SetRow label="Zuletzt benutzt"><span className="muted">{relativeTime(cred.lastUsedAt)}</span></SetRow>
          )}
          {cred && (
            <SetRow label="Ändern" action={
              <span className="repo-actions">
                {cred.kind === 'ssh_key'
                  ? <button type="button" className="button-small" onClick={() => setConfirm('key')}>Neuen Schlüssel erzeugen …</button>
                  : <button type="button" className="button-small" onClick={() => setTokenForm((v) => !v)} aria-expanded={tokenForm}>Token ersetzen …</button>}
                <button type="button" className="button-small button-danger" onClick={() => setConfirm('remove')}>Zugang entfernen …</button>
              </span>
            }>
              <span className="muted">Ersetzen und Entfernen fragen nach einer erneuten Bestätigung</span>
            </SetRow>
          )}
          {tokenForm && (
            <form className="set-row-block repo-token-form" onSubmit={(e) => { e.preventDefault(); if (tok.trim()) setAccess.mutate({ kind: 'https_token', token: tok.trim(), ...(user.trim() ? { username: user.trim() } : {}) }) }}>
              <div className="field-row">
                <div className="field">
                  <label htmlFor={`${uid}-user`}>Benutzername <span className="field-optional">(optional)</span></label>
                  <input id={`${uid}-user`} value={user} onChange={(e) => setUser(e.target.value)} placeholder="oauth2" autoComplete="off" spellCheck={false} />
                </div>
                <div className="field">
                  <label htmlFor={`${uid}-token`}>Token</label>
                  <input id={`${uid}-token`} type="password" value={tok} onChange={(e) => setTok(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${uid}-token-hint`} />
                  <p className="hint" id={`${uid}-token-hint`}>Nur Leserecht nötig (GitLab: read_repository), nur über https://.</p>
                </div>
              </div>
              {setAccess.isError && <p className="error" role="alert">{(setAccess.error as Error).message}</p>}
              <div className="form-actions">
                <button type="button" className="button-small" onClick={() => setTokenForm(false)}>Abbrechen</button>
                <button type="submit" className="button-small button-primary" disabled={setAccess.isPending || !tok.trim()} aria-busy={setAccess.isPending || undefined}>Token speichern</button>
              </div>
            </form>
          )}
          <div className="set-row-note repo-access-status" role="status" aria-live="polite">
            {run.isPending ? <p className="hint">Prüfe …</p> : check && (
              <RepoCheckResult check={check}
                onConfirm={(host, keys) => confirmHost.mutate({ host, fps: keys.map((k) => k.fingerprint) })}
                confirming={confirmHost.isPending}
                confirmError={confirmHost.isError ? (confirmHost.error as Error).message : null} />
            )}
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'key' ? 'Neuen Deploy-Key erzeugen?' : confirm === 'remove' ? 'Repo-Zugang entfernen?' : 'Server neu bestätigen?'}
        confirmLabel={confirm === 'key' ? 'Neuen Schlüssel erzeugen' : confirm === 'remove' ? 'Zugang entfernen' : 'Bestätigung zurücksetzen'}
        busy={busyConfirm}
        error={confirmError ? (confirmError as Error).message : null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => (confirm === 'key' ? setAccess.mutate({ kind: 'ssh_key' }) : confirm === 'remove' ? remove.mutate() : forget.mutate())}
      >
        <p>
          {confirm === 'key'
            ? 'Der bisherige Schlüssel gilt sofort nicht mehr. Bis du den neuen beim Anbieter einträgst, scheitern Deploys und Auto-Deploy. Den alten Schlüssel danach beim Anbieter löschen.'
            : confirm === 'remove'
              ? `Schlüssel bzw. Token werden gelöscht. Danach holt Airlock das Repo ${a?.githubAppAccess ? 'über die GitHub-App' : 'ohne Zugang – bei einem privaten Repo scheitern die Deploys'}.`
              : 'Nur, wenn der Anbieter seinen Server-Schlüssel gewechselt hat. Danach zeigt «Prüfen» den neuen Fingerabdruck – vergleiche ihn mit dem, den der Anbieter veröffentlicht.'}
        </p>
      </ConfirmDialog>
    </section>
  )
}

/** Abschnitt «Zugang» in Neues Projekt (unter Repo-URL und Branch) */
export function RepoAccessFields({ a, repoUrl, sectionRef }: { a: RepoAccessState; repoUrl: string; sectionRef?: React.Ref<HTMLFieldSetElement> }) {
  const uid = useId()
  const [user, setUser] = useState('')
  const [tok, setTok] = useState('')
  const tokenInput = useRef<HTMLInputElement>(null)
  const kind = repoAddressKind(repoUrl)
  const github = isGithub(repoUrl)
  const statusId = `${uid}-status`

  return (
    <fieldset className="field-group repo-access" ref={sectionRef}>
      <legend>Zugang zum Repo</legend>
      <div className="origin-switch" role="radiogroup" aria-label="Wie holt Airlock das Repo?">
        <label className="choice">
          <input type="radio" name={`${uid}-mode`} checked={a.mode === 'auto'} onChange={() => a.setMode('auto')} />
          <span>{github ? 'GitHub-App oder öffentlich' : 'Öffentlich'}</span>
        </label>
        <label className="choice">
          <input type="radio" name={`${uid}-mode`} checked={a.mode === 'deploy_key'} onChange={() => a.setMode('deploy_key')} />
          <span>Deploy-Key (SSH)</span>
        </label>
        <label className="choice">
          <input type="radio" name={`${uid}-mode`} checked={a.mode === 'token'} onChange={() => a.setMode('token')} />
          <span>Zugangstoken (HTTPS)</span>
        </label>
      </div>

      {a.mode === 'auto' && (
        <p className="hint">
          {github
            ? <>Private GitHub-Repos holt Airlock über die <Link to="/system/github">GitHub-App</Link>: pro Deploy ein Token, nur lesend, nur für dieses Repo. Öffentliche gehen ohne.</>
            : 'Ohne Zugang – das Repo muss öffentlich sein. Für ein privates Repo: Deploy-Key oder Zugangstoken.'}
        </p>
      )}

      {a.mode === 'deploy_key' && (
        <>
          {kind !== 'ssh' && repoUrl.trim() !== '' && (
            <p className="hint repo-access-note"><IconWarn /> Ein Deploy-Key braucht die SSH-Adresse des Repos, z.B. <code>git@gitlab.com:user/app.git</code>.</p>
          )}
          {a.sshKey ? <PublicKeyBox credential={a.sshKey} repoUrl={repoUrl} /> : (
            <>
              <p className="hint">Airlock erzeugt einen eigenen Schlüssel (ed25519) für dieses Projekt. Der private Teil bleibt verschlüsselt auf dem Server.</p>
              <div className="form-actions">
                <button type="button" className="button-small" onClick={() => void a.createKey()} disabled={a.busy === 'key'} aria-busy={a.busy === 'key' || undefined}>Deploy-Key erzeugen</button>
              </div>
            </>
          )}
        </>
      )}

      {a.mode === 'token' && (
        a.token ? (
          <p className="hint repo-access-saved"><IconOk size={14} /> Token gespeichert (verschlüsselt, wird nie wieder angezeigt) · Benutzer <code>{a.token.username}</code></p>
        ) : (
          <>
            {kind !== 'https' && repoUrl.trim() !== '' && (
              <p className="hint repo-access-note"><IconWarn /> Ein Token geht nur über eine https://-Adresse.</p>
            )}
            <div className="field-row">
              <div className="field">
                <label htmlFor={`${uid}-user`}>Benutzername <span className="field-optional">(optional)</span></label>
                <input id={`${uid}-user`} value={user} onChange={(e) => setUser(e.target.value)} placeholder="oauth2" autoComplete="off" spellCheck={false} aria-describedby={`${uid}-user-hint`} />
                <p className="hint" id={`${uid}-user-hint`}>GitLab: beliebig (oauth2), Gitea: dein Benutzername.</p>
              </div>
              <div className="field">
                <label htmlFor={`${uid}-token`}>Token</label>
                <input id={`${uid}-token`} ref={tokenInput} type="password" value={tok} onChange={(e) => setTok(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${uid}-token-hint`} />
                <p className="hint" id={`${uid}-token-hint`}>Nur Leserecht nötig (GitLab: read_repository).</p>
              </div>
            </div>
            <div className="form-actions">
              <button type="button" className="button-small" disabled={a.busy === 'token' || tok.trim() === ''} aria-busy={a.busy === 'token' || undefined}
                onClick={async () => { if (await a.saveToken(user, tok)) setTok('') }}>
                Token speichern
              </button>
            </div>
          </>
        )
      )}

      <div className="repo-access-check">
        <button type="button" className="button-small" onClick={() => void a.run()} disabled={!repoUrl.trim() || a.busy === 'check'} aria-busy={a.busy === 'check' || undefined} aria-describedby={statusId}>
          Repo prüfen
        </button>
        <div id={statusId} role="status" aria-live="polite" className="repo-access-status">
          {a.busy === 'check' ? <p className="hint">Prüfe …</p>
            : a.error ? <p className="repo-check repo-check-bad"><IconAlert size={16} /> <span>{a.error}</span></p>
            : a.current ? <RepoCheckResult check={a.current} onConfirm={(h, k) => void a.confirm(h, k)} confirming={a.busy === 'confirm'} confirmError={a.confirmError} />
            : null}
        </div>
      </div>
    </fieldset>
  )
}

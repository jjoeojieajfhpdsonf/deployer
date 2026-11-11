import { join } from 'node:path'
import {
  BACKUP_DEFAULT_RETENTION, BACKUP_DEFAULT_TIME, backupRetentionSchema, backupTimeSchema,
  type BackupProjectMode, type BackupRetention, type BackupSettingsDto, type BackupSettingsInput, type BackupTargetDto,
} from '@airlock/shared'
import { getSetting, setSetting } from '../db/index.js'
import { config } from '../config.js'
import { loadOrCreateKey, encrypt, decrypt } from '../lib/crypto.js'
import { registerSecret } from '../lib/redact.js'
import { badRequest } from '../lib/errors.js'
import { audit } from '../domain/audit.js'
import { displayTimeZone } from '../domain/pause-page.js'
import { normalizeLocalPath, repositoryUrl, type ResolvedTarget } from './restic.js'

/**
 * Meilenstein Backup, Etappe 1: Einstellungen der Sicherung (serverweit,
 * app_settings «backup_settings») und Zustand des Zeitplans («backup_state»,
 * getrennt, damit ein Lauf keine gleichzeitige Änderung der Einstellungen
 * überschreibt).
 *
 * Repository-Passwort und S3-Zugangsdaten liegen verschlüsselt mit dem
 * Schlüssel der Secrets (lib/crypto.ts) in der Datenbank und gehen nie in
 * eine Antwort, ein Log oder das Audit-Log.
 */

const SETTINGS_KEY = 'backup_settings'
const STATE_KEY = 'backup_state'

type StoredTarget =
  | { kind: 'local'; path: string }
  | { kind: 's3'; endpoint: string; bucket: string; prefix: string; region: string; accessKeyEnc?: string; secretKeyEnc?: string }

interface Stored {
  target?: StoredTarget
  passwordEnc?: string
  enabled?: boolean
  time?: string
  retention?: BackupRetention
  projects?: Record<string, BackupProjectMode>
  /** Seit wann eingerichtet und eingeschaltet (Zeitplan, «48 h ohne Erfolg») */
  activeSince?: string
}

export interface BackupState {
  lastScheduledAt?: string
  lastStaleNotifiedAt?: string
  lastCheckAt?: string
  /** Repository zuletzt erreicht – gilt nur für diese Adresse (anderes Ziel = ungeprüft) */
  repositoryCheckedAt?: string
  repositoryFor?: string
}

const key = () => loadOrCreateKey(join(config.DATA_DIR, 'keys', 'secrets.key'))
const enc = (s: string) => encrypt(s, key()).toString('base64')
const dec = (s: string) => decrypt(Buffer.from(s, 'base64'), key())

async function loadJson<T>(k: string): Promise<T> {
  const raw = await getSetting(k)
  try {
    return (raw ? JSON.parse(raw) : {}) as T
  } catch {
    return {} as T
  }
}

const loadStored = () => loadJson<Stored>(SETTINGS_KEY)
export const loadState = () => loadJson<BackupState>(STATE_KEY)

/** Zustand teilweise ändern (letzter Lauf, letzte Meldung, letzte Prüfung) */
export async function patchState(patch: Partial<BackupState>): Promise<BackupState> {
  const next = { ...(await loadState()), ...patch }
  await setSetting(STATE_KEY, JSON.stringify(next))
  return next
}

const isConfigured = (s: Stored): boolean =>
  !!s.target && !!s.passwordEnc && (s.target.kind === 'local' || (!!s.target.accessKeyEnc && !!s.target.secretKeyEnc))

/** Alles, was ein Lauf braucht – mit entschlüsselten Geheimnissen. Nur intern. */
export interface ResolvedBackupSettings {
  configured: boolean
  enabled: boolean
  target: ResolvedTarget | null
  password: string | null
  time: string
  timeZone: string
  retention: BackupRetention
  projects: Record<string, BackupProjectMode>
  activeSince: Date | null
}

export async function resolveSettings(): Promise<ResolvedBackupSettings> {
  const s = await loadStored()
  let target: ResolvedTarget | null = null
  let password: string | null = null
  if (s.passwordEnc) password = dec(s.passwordEnc)
  if (s.target?.kind === 'local') target = { kind: 'local', path: s.target.path }
  else if (s.target?.kind === 's3') {
    target = {
      kind: 's3', endpoint: s.target.endpoint, bucket: s.target.bucket, prefix: s.target.prefix, region: s.target.region,
      accessKeyId: s.target.accessKeyEnc ? dec(s.target.accessKeyEnc) : '',
      secretAccessKey: s.target.secretKeyEnc ? dec(s.target.secretKeyEnc) : '',
    }
  }
  // Ab jetzt in jeder Meldung geschwärzt (lib/redact.ts), auch ausserhalb der Sicherung
  registerSecret(password)
  if (target?.kind === 's3') {
    registerSecret(target.accessKeyId)
    registerSecret(target.secretAccessKey)
  }
  return {
    configured: isConfigured(s),
    enabled: s.enabled ?? true,
    target,
    password,
    time: s.time ?? BACKUP_DEFAULT_TIME,
    timeZone: displayTimeZone(),
    retention: s.retention ?? { ...BACKUP_DEFAULT_RETENTION },
    projects: s.projects ?? {},
    activeSince: s.activeSince ? new Date(s.activeSince) : null,
  }
}

function targetDto(t: StoredTarget | undefined): BackupTargetDto | null {
  if (!t) return null
  if (t.kind === 'local') return { kind: 'local', path: t.path }
  return { kind: 's3', endpoint: t.endpoint, bucket: t.bucket, prefix: t.prefix, region: t.region, hasAccessKey: !!t.accessKeyEnc, hasSecretKey: !!t.secretKeyEnc }
}

/** Adresse des Repositorys ohne Geheimnisse (für «geprüft am» je Ziel) */
function storedRepositoryUrl(t: StoredTarget | undefined): string | null {
  if (!t) return null
  try {
    return t.kind === 'local' ? repositoryUrl({ kind: 'local', path: t.path }) : repositoryUrl({ ...t, accessKeyId: '', secretAccessKey: '' })
  } catch {
    return null
  }
}

export async function getBackupSettings(): Promise<BackupSettingsDto> {
  const [s, st] = await Promise.all([loadStored(), loadState()])
  const repo = storedRepositoryUrl(s.target)
  const checkedHere = !!repo && st.repositoryFor === repo
  return {
    configured: isConfigured(s),
    enabled: s.enabled ?? true,
    target: targetDto(s.target),
    hasPassword: !!s.passwordEnc,
    time: s.time ?? BACKUP_DEFAULT_TIME,
    timeZone: displayTimeZone(),
    retention: s.retention ?? { ...BACKUP_DEFAULT_RETENTION },
    projects: s.projects ?? {},
    repositoryCheckedAt: checkedHere ? st.repositoryCheckedAt ?? null : null,
    lastCheckAt: checkedHere ? st.lastCheckAt ?? null : null,
  }
}

/**
 * Einstellungen ändern. Geheimnisse: undefined = unverändert. Ein Wechsel
 * der Ziel-Art verlangt neue Zugangsdaten (die alten gehören zum alten Ziel).
 */
export async function putBackupSettings(input: BackupSettingsInput, actor: string): Promise<BackupSettingsDto> {
  const s = await loadStored()
  const before = { configured: isConfigured(s), enabled: s.enabled ?? true, repo: storedRepositoryUrl(s.target) }
  const changed: string[] = []

  if (input.target) {
    const t = input.target
    if (t.kind === 'local') {
      let path: string
      try {
        path = normalizeLocalPath(t.path)
      } catch (err) {
        throw badRequest((err as Error).message, [{ path: 'target.path', message: (err as Error).message }])
      }
      s.target = { kind: 'local', path }
    } else {
      const old = s.target?.kind === 's3' ? s.target : undefined
      const accessKeyEnc = t.accessKeyId !== undefined ? enc(t.accessKeyId) : old?.accessKeyEnc
      const secretKeyEnc = t.secretAccessKey !== undefined ? enc(t.secretAccessKey) : old?.secretKeyEnc
      if (!accessKeyEnc) throw badRequest('S3: Access-Key fehlt', [{ path: 'target.accessKeyId', message: 'Access-Key fehlt' }])
      if (!secretKeyEnc) throw badRequest('S3: Secret-Key fehlt', [{ path: 'target.secretAccessKey', message: 'Secret-Key fehlt' }])
      s.target = {
        kind: 's3', endpoint: t.endpoint.replace(/\/+$/, ''), bucket: t.bucket, prefix: t.prefix.replace(/^\/+|\/+$/g, ''), region: t.region,
        accessKeyEnc, secretKeyEnc,
      }
    }
    changed.push('target')
  }
  if (input.password !== undefined) {
    s.passwordEnc = enc(input.password)
    changed.push('password')
  }
  if (input.enabled !== undefined) {
    s.enabled = input.enabled
    changed.push('enabled')
  }
  if (input.time !== undefined) {
    s.time = backupTimeSchema.parse(input.time)
    changed.push('time')
  }
  if (input.retention !== undefined) {
    s.retention = backupRetentionSchema.parse(input.retention)
    changed.push('retention')
  }
  if (input.projects !== undefined) {
    // Vorgabe «live» nicht speichern: die Liste enthält nur Abweichungen
    s.projects = Object.fromEntries(Object.entries(input.projects).filter(([, m]) => m !== 'live'))
    changed.push('projects')
  }

  // Frist für Zeitplan und «48 h ohne Erfolg» neu beginnen, wenn die Sicherung
  // gerade (wieder) scharf wird oder auf ein anderes Ziel zeigt
  const nowActive = isConfigured(s) && (s.enabled ?? true)
  const wasActive = before.configured && before.enabled
  if (nowActive && (!wasActive || storedRepositoryUrl(s.target) !== before.repo)) s.activeSince = new Date().toISOString()

  await setSetting(SETTINGS_KEY, JSON.stringify(s))
  // Nur Art und Ziel ohne Zugangsdaten ins Audit-Log
  const t = s.target
  await audit({
    actor, action: 'backup.settings', environmentId: null, result: 'ok',
    params: {
      changed,
      kind: t?.kind ?? null,
      target: t ? (t.kind === 'local' ? t.path : `${t.endpoint}/${t.bucket}${t.prefix ? `/${t.prefix}` : ''}`) : null,
      enabled: s.enabled ?? true,
      time: s.time ?? BACKUP_DEFAULT_TIME,
      retention: s.retention ?? BACKUP_DEFAULT_RETENTION,
    },
  })
  return getBackupSettings()
}

/** Nach einem erfolgreichen Zugriff aufs Repository (Test oder Lauf) */
export async function noteRepositoryReached(target: ResolvedTarget, patch: Partial<BackupState> = {}): Promise<void> {
  const url = repositoryUrl(target)
  const st = await loadState()
  // Anderes Repository: dessen letzte Prüfung (restic check) ist nicht bekannt
  const lastCheckAt = st.repositoryFor === url ? st.lastCheckAt : undefined
  await setSetting(STATE_KEY, JSON.stringify({ ...st, lastCheckAt, repositoryCheckedAt: new Date().toISOString(), repositoryFor: url, ...patch }))
}

/** Letzte Prüfung (restic check) genau dieses Repositorys */
export function lastCheckFor(st: BackupState, target: ResolvedTarget): Date | null {
  return st.repositoryFor === repositoryUrl(target) && st.lastCheckAt ? new Date(st.lastCheckAt) : null
}

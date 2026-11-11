import { join } from 'node:path'
import { mkdir, rm, writeFile, chmod, readdir } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { and, eq, ne } from 'drizzle-orm'
import { UI_HOST_LABEL, type CfStatusDto, type CfTokenCheckDto, type CfPermissionCheck, type CfTlsPhase } from '@airlock/shared'
import { config, setCfRuntime, cf as cfDefault, net, type CfRuntime } from '../config.js'
import { db, schema, getSetting } from '../db/index.js'
import {
  reloadEnvironments, defaultEnvironment, environmentById, allEnvironments, splitBaseDomain, namesForZone, DEFAULT_CLOUDFLARED_NAME, type EnvRuntime,
} from './environments.js'
import { inEnvironment } from '../lib/scope.js'
import { loadOrCreateKey, encrypt, decrypt } from '../lib/crypto.js'
import { Cloudflare, CloudflareError } from '../drivers/cloudflare.js'
import {
  startCloudflared, removeCloudflared, cloudflaredState, ensureCloudflaredRunning, cloudflaredLogTail,
  versionOf, latestCloudflaredVersion, compareVersions, imageWithVersion,
} from '../drivers/cloudflared.js'
import { TUNNEL_SERVICE, CATCH_ALL } from '../lib/public-hosts.js'
import { probeName, type TlsOptions } from '../drivers/caddy-config.js'
import { probeCert, checkIssuedCert, productionIssued, isStagingIssuer, type CertInfo } from '../lib/cert.js'
import { removeStagingWildcard, storedProductionWildcard, type StoredCert } from '../lib/caddy-storage.js'
import { planTlsStart, mayOrderProduction, prodCertUsable, nextProdAttemptAt, clock, PROD_LOG_ASSUMED_MS, type ProdState } from '../lib/tls-plan.js'
import { parseCaddyTlsLog } from '../lib/caddy-tls-log.js'
import { tlsOptionsFor } from '../lib/tls-options.js'
import { caddyAcceptsCloudflareToken } from '../lib/cf-token-format.js'
import * as docker from '../drivers/docker.js'
import { audit } from './audit.js'
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js'
import { log } from '../lib/log.js'
import { publish } from '../lib/events.js'
import { redactSecrets, redactDeep, registerSecret } from '../lib/redact.js'

/**
 * «Cloudflare verbinden» (Systemseite): Token, Konto, Zonen, Tunnel und
 * Zertifikat werden über die Oberfläche eingerichtet und hier gespeichert,
 * das Token verschlüsselt wie die Zugangsdaten der Benachrichtigungen.
 * Was hier fehlt, kommt weiter aus .env (alte Einrichtung über
 * compose.tls.yaml / compose.public.yaml).
 */

const key =() => loadOrCreateKey(join(config.DATA_DIR, 'keys', 'secrets.key'))
const enc = (s: string) => encrypt(s, key()).toString('base64')
const dec = (s: string) => decrypt(Buffer.from(s, 'base64'), key())

type Step = { at: string; text: string; tone: 'info' | 'ok' | 'bad' }

interface Stored {
  tokenEnc?: string
  tokenSavedAt?: string
  lastCheck?: CfTokenCheckDto
  accountId?: string
  accountName?: string
  baseDomain?: string
  tailscaleIp?: string | null
  accessEmail?: string | null
  acmeEmail?: string | null
  tunnel?: { id: string; name: string; tokenEnc: string }
  /** Schritt 4 «Später einrichten»: ohne Tunnel weiter zum Zertifikat */
  tunnelSkipped?: boolean
  /** Festgelegtes cloudflared-Image (nach einem Update per Knopf) */
  cloudflaredImage?: string
  /** prodAttemptAt/prodCert: Rate-Limit-Schutz, siehe lib/tls-plan.ts */
  tls?: { phase: CfTlsPhase; ca: 'production' | 'staging'; startedAt: string; steps: Step[] } & ProdState
}

/*
 * M9: Der Stand liegt nicht mehr als JSON in app_settings.cloudflare, sondern
 * in environments (Basis, Zertifikat, E-Mails), cloudflare_accounts (Token,
 * Konto) und tunnels; die Tailscale-IP serverweit in app_settings
 * «server_network». `Stored` bleibt die Arbeitsform dieser Datei – eine pro
 * Umgebung. app_settings.cloudflare bleibt eine Version lang als Rückfall
 * stehen und wird nicht mehr geschrieben.
 *
 * Für welche Umgebung eine Funktion dieser Datei arbeitet, bestimmt
 * withCloudflareEnv(envId, fn); ohne das die Standard-Umgebung (die alte
 * Systemseite). AsyncLocalStorage trägt die Umgebung auch durch Läufe im
 * Hintergrund (Zertifikats-Einrichtung): zwei Umgebungen kommen sich nie in
 * die Quere.
 */
const NET_KEY = 'server_network'

const states = new Map<string, Stored>()
const envCtx = new AsyncLocalStorage<string>()

/** Umgebung, für die gerade gearbeitet wird. */
const currentEnvId = (): string => envCtx.getStore() ?? defaultEnvironment().id
const currentEnv = (): EnvRuntime => environmentById(currentEnvId()) ?? defaultEnvironment()
const isDefaultEnv = (): boolean => currentEnv().isDefault
/** Arbeitsform der aktuellen Umgebung. */
const st = (): Stored => states.get(currentEnvId()) ?? {}

/** Alle Funktionen dieser Datei innerhalb von fn arbeiten für die Umgebung envId. */
export function withCloudflareEnv<T>(envId: string, fn: () => T): T {
  if (!environmentById(envId)) throw notFound('Umgebung')
  return envCtx.run(envId, fn)
}

const safeDec = (s: string | undefined): string | null => {
  if (!s) return null
  try {
    return dec(s)
  } catch {
    return null
  }
}

/**
 * Wirksame Werte der aktuellen Umgebung. Standard-Umgebung: wie bisher aus
 * config.ts (mit Rückfall auf die alten .env-Variablen); weitere Umgebungen
 * nur aus ihrem eigenen Stand.
 */
const ecf = {
  token: (): string | null => (isDefaultEnv() ? cfDefault.token() : safeDec(st().tokenEnc)),
  tokenSource: (): 'ui' | 'env' | null => (isDefaultEnv() ? cfDefault.tokenSource() : st().tokenEnc ? 'ui' : null),
  accountId: (): string | null => (isDefaultEnv() ? cfDefault.accountId() : st().accountId ?? null),
  tunnelId: (): string | null => (isDefaultEnv() ? cfDefault.tunnelId() : st().tunnel?.id ?? null),
  baseDomain: (): string | null => (isDefaultEnv() ? cfDefault.baseDomain() : st().baseDomain ?? null),
  acmeEmail: (): string | null => (isDefaultEnv() ? cfDefault.acmeEmail() : st().acmeEmail ?? null),
  accessEmail: (): string | null => (isDefaultEnv() ? cfDefault.accessEmail() : st().accessEmail ?? null),
  /** serverweit */
  tailscaleIp: (): string | null => cfDefault.tailscaleIp(),
}

async function readTailscale(): Promise<{ tailscaleIp?: string | null }> {
  const netRaw = await getSetting(NET_KEY)
  try {
    return netRaw ? (JSON.parse(netRaw) as { tailscaleIp?: string | null }) : {}
  } catch {
    return {}
  }
}

/** Stand aller Umgebungen aus den Tabellen. */
async function loadAll(): Promise<void> {
  await reloadEnvironments()
  const tailscale = await readTailscale()
  const seen = new Set<string>()
  for (const env of allEnvironments()) {
    states.set(env.id, storedFromEnvironment(env, tailscale))
    seen.add(env.id)
  }
  for (const id of [...states.keys()]) if (!seen.has(id)) states.delete(id)
}

/** Arbeitsform aus den Tabellen; mit Konto (über die Oberfläche eingerichtet) gelten auch leere Werte. */
function storedFromEnvironment(env: EnvRuntime, tailscale: { tailscaleIp?: string | null }): Stored {
  const { row, account: acc, tunnel } = env
  return {
    ...(acc
      ? {
          tokenEnc: acc.tokenEnc,
          ...(acc.tokenSavedAt ? { tokenSavedAt: acc.tokenSavedAt.toISOString() } : {}),
          ...(acc.lastCheck ? { lastCheck: acc.lastCheck } : {}),
          ...(acc.cfAccountId ? { accountId: acc.cfAccountId } : {}),
          ...(acc.name ? { accountName: acc.name } : {}),
          accessEmail: row.accessEmails[0] ?? null,
          acmeEmail: row.acmeEmail ?? null,
        }
      : {
          ...(row.accessEmails[0] ? { accessEmail: row.accessEmails[0] } : {}),
          ...(row.acmeEmail ? { acmeEmail: row.acmeEmail } : {}),
        }),
    ...(env.baseDomain ? { baseDomain: env.baseDomain } : {}),
    ...('tailscaleIp' in tailscale ? { tailscaleIp: tailscale.tailscaleIp ?? null } : {}),
    ...(tunnel ? { tunnel: { id: tunnel.cfTunnelId, name: tunnel.name, tokenEnc: tunnel.tokenEnc } } : {}),
    ...(tunnel?.cloudflaredImage ? { cloudflaredImage: tunnel.cloudflaredImage } : {}),
    ...(row.tunnelSkipped ? { tunnelSkipped: true } : {}),
    ...(row.tlsState ? { tls: row.tlsState } : {}),
  }
}

/** Container-Name des Tunnels eines Kontos: wie bisher für das Konto der Standard-Umgebung, sonst mit Kurz-ID. */
function containerNameFor(accountRowId: string): string {
  return defaultEnvironment().account?.id === accountRowId ? DEFAULT_CLOUDFLARED_NAME() : `${DEFAULT_CLOUDFLARED_NAME()}-${accountRowId.slice(0, 8)}`
}

/** Arbeitsform der aktuellen Umgebung zurück in die Tabellen schreiben. */
async function persist(next: Stored): Promise<void> {
  const env = currentEnv()
  await db.transaction(async (tx) => {
    let accountId = env.row.cloudflareAccountId
    if (next.tokenEnc) {
      const values = {
        cfAccountId: next.accountId ?? null,
        name: next.accountName ?? null,
        tokenEnc: next.tokenEnc,
        tokenSavedAt: next.tokenSavedAt ? new Date(next.tokenSavedAt) : null,
        lastCheck: next.lastCheck ?? null,
        updatedAt: new Date(),
      }
      if (accountId) {
        await tx.update(schema.cloudflareAccounts).set(values).where(eq(schema.cloudflareAccounts.id, accountId))
      } else {
        accountId = (await tx.insert(schema.cloudflareAccounts).values(values).returning({ id: schema.cloudflareAccounts.id }))[0]!.id
      }
    } else if (accountId) {
      // Getrennt: Konto (mit Tunnel) weg, sofern keine andere Umgebung es nutzt
      const others = await tx.select({ id: schema.environments.id }).from(schema.environments)
        .where(and(eq(schema.environments.cloudflareAccountId, accountId), ne(schema.environments.id, env.id)))
      await tx.update(schema.environments).set({ cloudflareAccountId: null }).where(eq(schema.environments.id, env.id))
      if (!others.length) await tx.delete(schema.cloudflareAccounts).where(eq(schema.cloudflareAccounts.id, accountId))
      accountId = null
    }

    if (accountId) {
      const have = (await tx.select().from(schema.tunnels).where(eq(schema.tunnels.cloudflareAccountId, accountId)))[0]
      if (next.tunnel) {
        const values = { cfTunnelId: next.tunnel.id, name: next.tunnel.name, tokenEnc: next.tunnel.tokenEnc, cloudflaredImage: next.cloudflaredImage ?? null, updatedAt: new Date() }
        if (have) await tx.update(schema.tunnels).set(values).where(eq(schema.tunnels.id, have.id))
        else await tx.insert(schema.tunnels).values({ ...values, cloudflareAccountId: accountId, containerName: env.isDefault ? DEFAULT_CLOUDFLARED_NAME() : containerNameFor(accountId) })
      } else if (have) {
        await tx.delete(schema.tunnels).where(eq(schema.tunnels.id, have.id))
      }
    }

    const zones = (await tx.select({ name: schema.domains.name }).from(schema.domains).where(eq(schema.domains.environmentId, env.id))).map((z) => z.name)
    const split = next.baseDomain ? splitBaseDomain(next.baseDomain, zones) : null
    await tx.update(schema.environments).set({
      cloudflareAccountId: accountId,
      ...(split ? { zoneName: split.zone, internalPrefix: split.prefix } : {}),
      tlsState: next.tls ?? null,
      tunnelSkipped: Boolean(next.tunnelSkipped),
      accessEmails: next.accessEmail ? [next.accessEmail] : [],
      acmeEmail: next.acmeEmail ?? null,
      updatedAt: new Date(),
    }).where(eq(schema.environments.id, env.id))

    if (next.tailscaleIp !== undefined) {
      const value = JSON.stringify({ tailscaleIp: next.tailscaleIp })
      await tx.insert(schema.appSettings).values({ key: NET_KEY, value })
        .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: new Date() } })
    }
  })
  // Alle Umgebungen neu einlesen: Umgebungen mit demselben Konto teilen Token und Tunnel
  await loadAll()
}

async function save(next: Stored): Promise<void> {
  states.set(currentEnvId(), next)
  await persist(next)
  await applyRuntime()
  // UI-Qualität 3: Zertifikat und Cloudflare-Stand ohne Polling in der Oberfläche
  publish({ type: 'cert' })
}

const TOKEN_FILE = 'cloudflare_token'

/** Pfad der Token-Datei für Caddy (gemeinsames Volume): Konto der Standard-Umgebung, wie vor M9. */
export const caddyTokenPath = () => join(config.CADDY_SECRETS_DIR, TOKEN_FILE)

/**
 * M9: Token-Datei eines Kontos. Das Konto der Standard-Umgebung behält
 * «cloudflare_token» (nichts ändert sich für die heutige Installation),
 * weitere Konten bekommen «cloudflare_token_<konto-id>».
 */
export function caddyTokenPathForAccount(accountRowId: string): string {
  return defaultEnvironment().account?.id === accountRowId ? caddyTokenPath() : join(config.CADDY_SECRETS_DIR, `${TOKEN_FILE}_${accountRowId}`)
}

/** Token-Datei der aktuellen Umgebung; null ohne eigenes Konto (Standard-Umgebung: alter Pfad, auch für .env). */
const tokenPathForCurrent = (): string | null => {
  const acc = currentEnv().account
  if (acc) return caddyTokenPathForAccount(acc.id)
  return isDefaultEnv() ? caddyTokenPath() : null
}

/**
 * Datenbankwerte in config.ts übernehmen (Standard-Umgebung) und die
 * Token-Dateien für Caddy schreiben – für ALLE Konten, weil ein Wechsel bei
 * einer Umgebung den Pfad einer anderen ändern kann (geteiltes Konto).
 * Dateien ohne Konto werden entfernt.
 */
async function applyRuntime(): Promise<void> {
  const def = defaultEnvironment()
  const s = states.get(def.id) ?? {}
  const r: Partial<CfRuntime> = {}
  if (s.tokenEnc) {
    const t = safeDec(s.tokenEnc)
    if (t) r.token = t
    else log.error('Cloudflare-Token nicht entschlüsselbar (Schlüsseldatei getauscht?)', { umgebung: def.slug })
  }
  if (s.accountId) r.accountId = s.accountId
  if (s.tunnel) r.tunnelId = s.tunnel.id
  if (s.baseDomain) r.baseDomain = s.baseDomain
  if (s.tailscaleIp !== undefined) r.tailscaleIp = s.tailscaleIp
  if (s.accessEmail !== undefined) r.accessEmail = s.accessEmail
  if (s.acmeEmail !== undefined) r.acmeEmail = s.acmeEmail
  if (s.tls) {
    // https:// in Adressen erst, wenn das echte Zertifikat da ist
    r.tls = s.tls.phase === 'done'
    r.acmeCa = s.tls.ca
  }
  setCfRuntime(r)

  const files = new Map<string, string>()
  for (const env of allEnvironments()) {
    const es = states.get(env.id) ?? {}
    const token = safeDec(es.tokenEnc)
    if (token) registerSecret(token)
    const tunnelToken = safeDec(es.tunnel?.tokenEnc)
    if (tunnelToken) registerSecret(tunnelToken)
    if (env.account && token) files.set(caddyTokenPathForAccount(env.account.id), token)
  }
  await writeCaddyTokens(files)
}

/** Token-Dateien schreiben; eigene Dateien (cloudflare_token*) ohne Konto entfernen. */
async function writeCaddyTokens(files: Map<string, string>): Promise<void> {
  try {
    if (files.size) await mkdir(config.CADDY_SECRETS_DIR, { recursive: true, mode: 0o700 })
    for (const [file, token] of files) {
      await writeFile(file, token, { mode: 0o600 })
      await chmod(file, 0o600)
    }
    const existing = existsSync(config.CADDY_SECRETS_DIR) ? await readdir(config.CADDY_SECRETS_DIR) : []
    for (const name of existing) {
      const full = join(config.CADDY_SECRETS_DIR, name)
      if ((name === TOKEN_FILE || name.startsWith(`${TOKEN_FILE}_`)) && !files.has(full)) await rm(full, { force: true })
    }
  } catch (err) {
    log.warn('Token-Datei für Caddy nicht geschrieben', { dir: config.CADDY_SECRETS_DIR, err: String(err) })
  }
}

/** Beim Start, vor allem anderen, das Adressen braucht. */
export async function loadCloudflareSettings(): Promise<void> {
  await loadAll()
  await applyRuntime()
  // Aufräumen: Schritte aus der Zeit vor dem Schwärzen können ein Token enthalten
  // (caddy-dns/cloudflare v0.2.1: «API token '…' appears invalid»).
  for (const env of allEnvironments()) {
    await withCloudflareEnv(env.id, async () => {
      const tls = st().tls
      if (!tls?.steps.length) return
      const steps = redactDeep(tls.steps)
      if (JSON.stringify(steps) !== JSON.stringify(tls.steps)) {
        await save({ ...st(), tls: { ...tls, steps } })
        log.warn('Token aus gespeicherten Zertifikats-Schritten entfernt', { umgebung: env.slug })
      }
    })
  }
}

/** Container des Tunnels der aktuellen Umgebung (einer pro Konto). */
const cloudflaredName = (): string => {
  const env = currentEnv()
  if (env.tunnel) return env.tunnel.containerName
  return env.account ? containerNameFor(env.account.id) : DEFAULT_CLOUDFLARED_NAME()
}

/**
 * Beim Start, im Hintergrund: je Tunnel (einer pro Konto) cloudflared wieder
 * hochfahren, und je Umgebung eine unterbrochene Zertifikats-Einrichtung
 * weiterführen.
 */
export async function ensureManagedTunnelOnBoot(): Promise<void> {
  const started = new Set<string>()
  for (const env of allEnvironments()) {
    await withCloudflareEnv(env.id, () => ensureEnvOnBoot(started))
  }
}

async function ensureEnvOnBoot(started: Set<string>): Promise<void> {
  const tunnel = st().tunnel
  const name = cloudflaredName()
  if (tunnel && !started.has(name)) {
    started.add(name)
    try {
      const r = await ensureCloudflaredRunning(dec(tunnel.tokenEnc), cloudflaredImage(), name)
      if (r !== 'running') log.info('cloudflared gestartet', { how: r, container: name })
    } catch (err) {
      log.warn('cloudflared nicht gestartet', { container: name, err: (err as Error).message })
    }
  }
  // Eine unterbrochene Zertifikats-Einrichtung weiterführen – auch ohne Tunnel
  // («Später einrichten»); früher brach das hier mit dem Tunnel-Check ab.
  // In der Produktionsphase ist die Bestellung schon gezählt: nicht neu prüfen.
  const tls = st().tls
  if (tls && (tls.phase === 'staging' || tls.phase === 'production')) {
    void runTls('system', { resume: tls.phase === 'production' })
  } else if (tls?.phase === 'failed' && storedProd()) {
    // Fehlgeschlagen, aber ein gültiges produktives Zertifikat liegt im
    // Speicher: Produktions-CA laden und direkt auf «HTTPS aktiv»
    void runTls('system')
  }
}

/**
 * TLS-Optionen für Caddy. Aus der Datenbank: das Token kommt aus der Datei,
 * die Weiterleitung auf https erst, wenn das echte Zertifikat da ist. Sonst
 * die alte Einrichtung über .env.
 */
export function caddyTlsOptions(): (TlsOptions & { redirect: boolean }) | null {
  return tlsOptionsFor(st().tls, {
    baseDomain: ecf.baseDomain(),
    hasToken: Boolean(st().tokenEnc),
    prodUsable: prodCertUsable(prodState()),
    tokenFile: tokenPathForCurrent() ?? caddyTokenPath(),
    email: ecf.acmeEmail(),
    // Die alte Einrichtung über .env gilt nur für die Standard-Umgebung
    ...(isDefaultEnv() ? { legacy: { enabled: config.TLS_MODE === 'cloudflare', acmeCa: config.ACME_CA, email: config.ACME_EMAIL } } : {}),
  })
}

/**
 * M9: TLS-Optionen aller Umgebungen für den Caddy-Abgleich – eine interne
 * Basis je Umgebung mit eigener Regel. Doppelte Basen (sollte die Datenbank
 * verhindern) zählen einmal, die Standard-Umgebung zuerst.
 */
export function caddyTlsOptionsAll(): (TlsOptions & { redirect: boolean; envId: string })[] {
  const out: (TlsOptions & { redirect: boolean; envId: string })[] = []
  for (const env of allEnvironments()) {
    const o = withCloudflareEnv(env.id, caddyTlsOptions)
    if (!o || out.some((x) => x.baseDomain === o.baseDomain)) continue
    // Ein Token, das Caddy beim Laden ablehnt, liesse die ganze Konfiguration
    // scheitern (alle Umgebungen): diese Basis weglassen, die anderen laufen weiter.
    // Die alte Einrichtung über .env (ohne Token-Datei) prüft Caddy selbst.
    if (o.tokenFile && !caddyAcceptsCloudflareToken(withCloudflareEnv(env.id, ecf.token))) {
      warnOnce(`token:${env.id}`, 'Cloudflare-Token dieser Umgebung hat ein Format, das Caddy ablehnt – ihre interne Basis bleibt ohne HTTPS, die anderen Umgebungen laufen weiter', { umgebung: env.slug, basis: o.baseDomain })
      continue
    }
    out.push({ ...o, envId: env.id })
  }
  return out
}

const warned = new Set<string>()
function warnOnce(key: string, msg: string, data: Record<string, unknown>): void {
  if (warned.has(key)) return
  warned.add(key)
  log.warn(msg, data)
}

/** M9: Was andere Module (öffentlich, Tailnet, Adressen) von einer Umgebung brauchen. */
export interface EnvCloudflare {
  envId: string
  token: string | null
  /** Konto bei Cloudflare (cf_account_id) */
  accountId: string | null
  /** Konto in Airlock (cloudflare_accounts.id) – Umgebungen mit gleichem Konto teilen den Tunnel */
  accountRowId: string | null
  tunnelId: string | null
  containerName: string
  baseDomain: string | null
  /** https für interne Namen (echtes Zertifikat da) */
  tls: boolean
  accessEmail: string | null
}

export function cloudflareFor(envId: string): EnvCloudflare {
  return withCloudflareEnv(envId, () => ({
    envId,
    token: ecf.token(),
    accountId: ecf.accountId(),
    accountRowId: currentEnv().account?.id ?? null,
    tunnelId: ecf.tunnelId(),
    containerName: cloudflaredName(),
    baseDomain: ecf.baseDomain(),
    tls: isDefaultEnv() ? cfDefault.tls() : st().tls?.phase === 'done',
    accessEmail: ecf.accessEmail(),
  }))
}

/** Phasen aller Umgebungen mit Basis (für Log-Meldungen beim Caddy-Abgleich). */
export function tlsPhases(): { base: string; phase: CfTlsPhase | null }[] {
  return allEnvironments().flatMap((env) => withCloudflareEnv(env.id, () => {
    const base = ecf.baseDomain()
    return base ? [{ base, phase: st().tls?.phase ?? null }] : []
  }))
}

/** Phase der Zertifikats-Einrichtung, für Log-Meldungen beim Caddy-Abgleich. */
export const tlsPhase = (): CfTlsPhase | null => st().tls?.phase ?? null

const client = (token?: string) => {
  const t = token ?? ecf.token()
  if (!t) throw badRequest('Kein Cloudflare-Token gespeichert')
  return new Cloudflare({ token: t, base: config.CLOUDFLARE_API_BASE })
}

function wrapCf(err: unknown): never {
  if (err instanceof CloudflareError) throw new AppError('cloudflare', redactSecrets(err.message),err.status >= 400 && err.status < 500 ? 400 : 502)
  throw err
}

/* --- Rechte ------------------------------------------------------------------- */

export const REQUIRED_PERMISSIONS: { key: CfPermissionCheck['key']; label: string; required: boolean; why: string }[] = [
  { key: 'zone_read', label: 'Zone → Zone → Lesen', required: true, why: 'Zonen auflisten, Basisdomain und Standard-Domain wählen' },
  { key: 'dns_edit', label: 'Zone → DNS → Bearbeiten', required: true, why: 'Wildcard-Zertifikat (DNS-Challenge), Tailnet-Eintrag, öffentliche Namen' },
  { key: 'tunnel_edit', label: 'Konto → Cloudflare Tunnel → Bearbeiten', required: true, why: 'Tunnel anlegen und seine Regeln setzen' },
  { key: 'access_edit', label: 'Konto → Access: Apps und Richtlinien → Bearbeiten', required: false, why: 'nur für Projekte hinter Cloudflare Access' },
]

/**
 * Vorlage für die Token-Seite bei Cloudflare. Die Rechte sind vorausgefüllt,
 * soweit Cloudflare die Schlüssel kennt; Konto und Zonen wählt man dort.
 */
export function tokenTemplateUrl(): string {
  const groups = [
    { key: 'zone', type: 'read' },
    { key: 'dns', type: 'edit' },
    { key: 'argotunnel', type: 'edit' },
    { key: 'access', type: 'edit' },
  ]
  const q = new URLSearchParams({ permissionGroupKeys: JSON.stringify(groups), name: 'airlock', accountId: '*', zoneId: 'all' })
  return `https://dash.cloudflare.com/profile/api-tokens?${q}`
}

const STATUS_DE: Record<string, string> = { disabled: 'deaktiviert', expired: 'abgelaufen' }

/** Token prüfen: gültig, aktiv, und jedes nötige Recht – ohne etwas anzulegen. */
export async function checkToken(token: string, accountId?: string): Promise<CfTokenCheckDto> {
  const c = client(token.trim())
  const invalid = (message: string): CfTokenCheckDto => ({ valid: false, complete: false, message, expiresOn: null, accounts: [], zones: [], permissions: [] })
  let v: { status: string; expiresOn: string | null }
  try {
    v = await c.verifyToken()
  } catch (err) {
    if (err instanceof CloudflareError && err.status === 0) return invalid(err.message)
    return invalid('Cloudflare kennt dieses Token nicht. Ganz kopiert? Es ist ein «API-Token», nicht der «Global API Key».')
  }
  if (v.status !== 'active') return invalid(`Das Token ist ${STATUS_DE[v.status] ?? v.status}. Bei Cloudflare ein neues erstellen oder es wieder aktivieren.`)

  const accounts = await c.listAccounts().catch(() => [])
  const zones = await c.listZones().catch(() => [])
  const acc = accounts.find((a) => a.id === accountId) ?? accounts[0]

  const zoneChecks = await Promise.all(
    zones.slice(0, 50).map(async (z) => ({ id: z.id, name: z.name, dnsEdit: (await c.probeWrite('POST', `/zones/${z.id}/dns_records`, { type: 'INVALID', name: '', content: '' })) === 'allowed' })),
  )
  const tunnel = acc ? await c.probeWrite('POST', `/accounts/${acc.id}/cfd_tunnel`, { name: '', config_src: 'invalid' }) : 'denied'
  const access = acc ? await c.probeWrite('POST', `/accounts/${acc.id}/access/apps`, { type: 'invalid' }) : 'denied'

  const noDns = zoneChecks.filter((z) => !z.dnsEdit).map((z) => z.name)
  const perms: CfPermissionCheck[] = [
    { key: 'zone_read', label: REQUIRED_PERMISSIONS[0]!.label, required: true, ok: zones.length > 0, detail: zones.length ? null : 'Das Token sieht keine Zone. Recht ergänzen und unter «Zonenressourcen» mindestens eine Zone freigeben.' },
    {
      key: 'dns_edit', label: REQUIRED_PERMISSIONS[1]!.label, required: true,
      ok: zoneChecks.some((z) => z.dnsEdit),
      detail: zones.length === 0 ? 'Ohne sichtbare Zone nicht prüfbar.' : noDns.length === zones.length ? 'Fehlt für alle Zonen.' : noDns.length ? `Fehlt für: ${noDns.join(', ')}` : null,
    },
    {
      key: 'tunnel_edit', label: REQUIRED_PERMISSIONS[2]!.label, required: true, ok: tunnel === 'allowed',
      detail: !acc ? 'Das Token sieht kein Konto. Unter «Kontoressourcen» das Konto freigeben.' : tunnel === 'unknown' ? 'Cloudflare hat unerwartet geantwortet; nicht sicher prüfbar.' : tunnel === 'denied' ? `Fehlt im Konto «${acc.name}».` : null,
    },
    {
      key: 'access_edit', label: REQUIRED_PERMISSIONS[3]!.label, required: false, ok: access === 'allowed',
      detail: access === 'allowed' ? null : 'Optional. Ohne dieses Recht lässt sich kein Projekt hinter Cloudflare Access stellen.',
    },
  ]
  const complete = perms.filter((p) => p.required).every((p) => p.ok)
  const missing = perms.filter((p) => p.required && !p.ok).map((p) => p.label)
  return {
    valid: true,
    complete,
    message: complete ? null : `Es fehlen Rechte: ${missing.join('; ')}.`,
    expiresOn: v.expiresOn,
    accounts,
    zones: zoneChecks,
    permissions: perms,
  }
}

/* --- Ablauf -------------------------------------------------------------------- */

/** Schritt 1/2: Token prüfen und speichern (auch: Token ersetzen). */
export async function saveToken(token: string, actor: string): Promise<CfTokenCheckDto> {
  const t = token.trim()
  // M9: genau so streng wie Caddy beim Laden – ein abgelehntes Token liesse sonst die
  // ganze Caddy-Konfiguration scheitern, mit den Zertifikaten aller Umgebungen
  if (!caddyAcceptsCloudflareToken(t)) throw badRequest('Das sieht nicht wie ein Cloudflare-API-Token aus (40 Zeichen aus Buchstaben, Ziffern, - und _, oder «cfut_…»).', [{ path: 'token', message: 'Füge das API-Token ein, das Cloudflare nach «Token erstellen» einmal anzeigt.' }])
  const check = await checkToken(t, st().accountId)
  if (!check.valid) throw badRequest(check.message ?? 'Token ungültig', [{ path: 'token', message: check.message ?? 'Token ungültig' }])
  if (!check.complete) throw new AppError('cf_permissions', check.message ?? 'Rechte unvollständig', 400, { check })
  if (st().accountId && !check.accounts.some((a) => a.id === st().accountId)) {
    throw badRequest(`Das neue Token sieht das Konto «${st().accountName ?? st().accountId}» nicht, in dem der Tunnel liegt. Ein Token für dasselbe Konto erstellen.`)
  }
  const acc = check.accounts.find((a) => a.id === st().accountId) ?? check.accounts[0]!
  const replacing = Boolean(st().tokenEnc)
  await save({ ...st(), tokenEnc: enc(t), tokenSavedAt: new Date().toISOString(), lastCheck: check, accountId: acc.id, accountName: acc.name })
  await syncZones()
  // Caddy liest die Datei beim Laden: neu laden, auch wenn sich die Konfiguration nicht ändert
  if (caddyTlsOptions()) await reloadCaddy(true)
  await audit({ actor, action: replacing ? 'cloudflare.token.replace' : 'cloudflare.token.set', targetType: 'environment', targetId: currentEnvId(), environmentId: currentEnvId(), params: { account: acc.name }, result: 'ok' })
  return check
}

async function syncZones(): Promise<void> {
  const { syncDomains } = await import('./public.js')
  await syncDomains(client(), currentEnvId()).catch((err) => log.warn('Zonen nicht abgeglichen', { err: String(err) }))
}

export interface DomainChoice {
  baseZone: string
  baseLabel: string
  defaultZone: string | null
  accountId?: string
  tailscaleIp?: string | null
  accessEmail?: string | null
  acmeEmail?: string | null
}

/** Schritt 3: interne Basisdomain und Standard-Domain für öffentliche Projekte. */
export async function saveDomains(input: DomainChoice, actor: string): Promise<void> {
  if (!st().tokenEnc) throw badRequest('Zuerst das Token speichern')
  const { listDomains, setDefaultDomain, claimZone } = await import('./public.js')
  const env = currentEnv()
  const own = inEnvironment(env.id)
  // M9: Eine Zone desselben Kontos, die noch bei einer anderen Umgebung liegt
  // (und dort nicht Hauptzone und nicht öffentlich benutzt ist), wechselt hierher.
  await claimZone(env.id, input.baseZone.toLowerCase())
  const zones = await listDomains(own)
  const zone = zones.find((z) => z.name === input.baseZone.toLowerCase())
  if (!zone) throw badRequest(`${input.baseZone} ist keine Zone dieses Kontos`, [{ path: 'baseZone', message: 'Wähle eine Zone aus der Liste.' }])
  const label = input.baseLabel.trim().toLowerCase()
  const baseDomain = label ? `${label}.${zone.name}` : zone.name
  const before = ecf.baseDomain()
  const account = input.accountId && st().lastCheck?.accounts.find((a) => a.id === input.accountId)
  await save({
    ...st(),
    baseDomain,
    ...(account ? { accountId: account.id, accountName: account.name } : {}),
    ...(input.tailscaleIp !== undefined ? { tailscaleIp: input.tailscaleIp || null } : {}),
    ...(input.accessEmail !== undefined ? { accessEmail: input.accessEmail || null } : {}),
    ...(input.acmeEmail !== undefined ? { acmeEmail: input.acmeEmail || null } : {}),
  })
  if (input.defaultZone) await setDefaultDomain(own, input.defaultZone, actor)
  // Noch unbenannte Umgebung (frische Installation): Name, Slug und Kürzel aus der Hauptzone –
  // wie bei der Übernahme der Einstellungen von vor M9
  if (env.slug === 'standard' && env.name === 'Standard') {
    const n = namesForZone(zone.name)
    const taken = allEnvironments().some((e) => e.id !== env.id && e.slug === n.slug)
    if (!taken) {
      await db.update(schema.environments).set({ name: n.name, slug: n.slug, short: n.short, updatedAt: new Date() }).where(eq(schema.environments.id, env.id))
      await loadAll()
    }
  }
  if (before !== baseDomain) {
    // Bestehende Projekte dieser Umgebung ziehen auf die neue Basis um; ein Zertifikat für die alte gilt nicht mehr
    const { rehostRoutes } = await import('./routes.js')
    const moved = await rehostRoutes(env.id)
    // Das vorhandene Zertifikat gilt für die alte Basisdomain: vergessen
    const tls = st().tls
    if (tls && tls.phase !== 'off') await save({ ...st(), tls: { ...tls, phase: 'off', steps: [], prodCert: undefined } })
    log.info('Basisdomain geändert', { umgebung: env.slug, baseDomain, moved })
  }
  if (net.tailscaleIp()) {
    const { ensureTailnetDnsFor } = await import('./tailnet.js')
    const token = ecf.token()
    if (token) await ensureTailnetDnsFor(baseDomain, token, actor).catch((err) => log.warn('Tailnet-Eintrag nicht gesetzt', { err: (err as Error).message }))
  }
  await reloadCaddy()
  await audit({ actor, action: 'cloudflare.domains', targetType: 'environment', targetId: env.id, environmentId: env.id, params: { baseDomain, defaultZone: input.defaultZone }, result: 'ok' })
}

/** Schritt 4: Tunnel per API anlegen (oder den gleichnamigen wiederverwenden), cloudflared starten. */
/**
 * M9: Ein Tunnel pro Cloudflare-Konto. Nutzt eine andere Umgebung schon
 * dasselbe Konto, ist ihr Tunnel auch dieser (kommt über das Konto mit).
 */
export async function setupTunnel(actor: string): Promise<void> {
  const accountId = st().accountId
  if (!st().tokenEnc || !accountId) throw badRequest('Zuerst das Token speichern')
  const env = currentEnv()
  const c = client()
  const name = `airlock-${(config.SERVER_NAME || 'server').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
  let tunnel: { id: string; name: string }
  let token: string
  try {
    tunnel = st().tunnel ?? (await c.findTunnel(accountId, name)) ?? (await c.createTunnel(accountId, name))
    token = await c.tunnelToken(accountId, tunnel.id)
  } catch (err) {
    wrapCf(err)
  }
  await save({ ...st(), tunnel: { id: tunnel.id, name: tunnel.name, tokenEnc: enc(token) }, tunnelSkipped: false })
  await startCloudflared(token, cloudflaredImage(), cloudflaredName())
  const { reconcileTunnelFor, syncDomains } = await import('./public.js')
  await syncDomains(c, env.id).catch(() => {})
  await reconcileTunnelFor(env.id).catch((err) => log.warn('Tunnel-Regeln nicht gesetzt', { err: String(err) }))
  await reloadCaddy()
  await audit({ actor, action: 'cloudflare.tunnel', targetType: 'environment', targetId: env.id, environmentId: null, params: { name: tunnel.name, tunnel: tunnel.id, umgebung: env.slug }, result: 'ok' })
}

/**
 * Schritt 4 überspringen: Das Zertifikat für interne Adressen braucht keinen
 * Tunnel (DNS-Challenge über das Token). Ohne Tunnel bleibt nur «Öffentlich» aus.
 */
export async function skipTunnel(actor: string): Promise<void> {
  if (!st().tokenEnc) throw badRequest('Zuerst das Token speichern')
  if (!ecf.baseDomain()) throw badRequest('Zuerst die interne Basisdomain wählen')
  if (st().tunnel) return
  await save({ ...st(), tunnelSkipped: true })
  await audit({ actor, action: 'cloudflare.tunnel.skip', targetType: 'environment', targetId: currentEnvId(), environmentId: currentEnvId(), params: {}, result: 'ok' })
}

/** cloudflared neu starten (gleicher Tunnel, frisches Token). */
export async function restartTunnel(actor: string): Promise<void> {
  const tunnel = st().tunnel
  const accountId = st().accountId
  if (!tunnel || !accountId) throw badRequest('Kein Tunnel eingerichtet')
  let token: string
  try {
    token = await client().tunnelToken(accountId, tunnel.id)
  } catch (err) {
    wrapCf(err)
  }
  await save({ ...st(), tunnel: { ...tunnel, tokenEnc: enc(token) } })
  await startCloudflared(token, cloudflaredImage(), cloudflaredName())
  await audit({ actor, action: 'cloudflare.tunnel.restart', targetType: 'system', targetId: tunnel.id, environmentId: null, params: { container: cloudflaredName() }, result: 'ok' })
}

/** Das festgelegte Image: nach einem Update das neue, sonst das aus der Konfiguration. */
const cloudflaredImage = () => st().cloudflaredImage ?? config.CLOUDFLARED_IMAGE

/** cloudflared auf die neueste Version: neues Image festlegen, Container neu anlegen. */
export async function updateCloudflared(actor: string): Promise<void> {
  const tunnel = st().tunnel
  const accountId = st().accountId
  if (!tunnel || !accountId) throw badRequest('cloudflared wird nicht von Airlock verwaltet')
  const latest = await latestCloudflaredVersion(true)
  if (!latest.version) throw new AppError('cloudflared_version', `Neueste Version nicht abrufbar${latest.error ? `: ${latest.error}` : ''}`, 502)
  const current = versionOf(cloudflaredImage())
  if (current && compareVersions(latest.version, current) <= 0) throw badRequest(`cloudflared ${current} ist schon die neueste Version`)
  const image = imageWithVersion(latest.version)
  let token: string
  try {
    token = await client().tunnelToken(accountId, tunnel.id)
  } catch (err) {
    wrapCf(err)
  }
  // Erst anlegen, dann festlegen: scheitert das Holen des Images, bleibt die alte Version
  await startCloudflared(token, image, cloudflaredName())
  await save({ ...st(), cloudflaredImage: image, tunnel: { ...tunnel, tokenEnc: enc(token) } })
  await audit({ actor, action: 'cloudflare.cloudflared.update', targetType: 'system', targetId: tunnel.id, environmentId: null, params: { from: current, to: latest.version }, result: 'ok' })
}

/** M9: je Tunnel zwischengespeichert */
const ingressCache = new Map<string, { at: number; foreign: { hostname: string | null; service: string }[]; error: string | null }>()

/**
 * Regeln des Tunnels, die nicht auf Caddy zeigen (etwa von Hand im
 * Dashboard ergänzt). Der Tunnel soll nur Caddy erreichen; alles andere
 * umginge IP-Filter und Routing. Eine Minute zwischengespeichert.
 */
async function foreignIngress(): Promise<{ foreign: { hostname: string | null; service: string }[]; error: string | null }> {
  const acc = ecf.accountId()
  const tunnel = ecf.tunnelId()
  if (!acc || !tunnel || !ecf.token()) return { foreign: [], error: null }
  const cached = ingressCache.get(tunnel)
  if (cached && Date.now() - cached.at < 60_000) return cached
  let entry: { at: number; foreign: { hostname: string | null; service: string }[]; error: string | null }
  try {
    const rules = await client().getTunnelIngress(acc, tunnel)
    const foreign = rules
      .filter((r) => r.service !== TUNNEL_SERVICE && !(r.service === CATCH_ALL.service && !r.hostname))
      .map((r) => ({ hostname: r.hostname ?? null, service: r.service }))
    entry = { at: Date.now(), foreign, error: null }
  } catch (err) {
    entry = { at: Date.now(), foreign: [], error: (err as Error).message }
  }
  ingressCache.set(tunnel, entry)
  return entry
}

/* --- Zertifikat ------------------------------------------------------------------ */

/** M9: Einrichtung je Umgebung – eine pro Umgebung, Umgebungen unabhängig voneinander. */
const tlsRuns = new Map<string, Promise<void>>()
const tlsRunning = (): boolean => tlsRuns.has(currentEnvId())
const TLS_TIMEOUT_MS = 6 * 60_000

async function step(text: string, tone: Step['tone'] = 'info'): Promise<void> {
  const tls = st().tls
  if (!tls) return
  await save({ ...st(), tls: { ...tls, steps: [...tls.steps, { at: new Date().toISOString(), text: redactSecrets(text), tone }].slice(-30) } })
}

async function setPhase(phase: CfTlsPhase, ca: 'production' | 'staging'): Promise<void> {
  await save({ ...st(), tls: { ...(st().tls ?? { startedAt: new Date().toISOString(), steps: [] }), phase, ca } })
}

/** Schritt 5: erst Staging-CA (ohne Rate-Limit-Risiko), dann Produktion. Läuft im Hintergrund. */
export async function startTls(actor: string): Promise<void> {
  if (!st().tokenEnc) throw badRequest('Zuerst das Token speichern')
  if (!ecf.baseDomain()) throw badRequest('Zuerst die interne Basisdomain wählen')
  if (tlsRunning()) throw conflict('Die Einrichtung des Zertifikats läuft schon')
  // Rate-Limit-Schutz: vorhandenes Zertifikat wiederverwenden, sonst höchstens
  // ein produktiver Versuch pro Stunde (lib/tls-plan.ts)
  const plan = planTlsStart(prodState())
  if (plan.kind === 'wait') {
    throw new AppError('rate_limited', `Nächster Versuch ab ${clock(plan.until)} Uhr: höchstens ein produktiver Versuch pro Stunde, damit Let's Encrypt nicht sperrt.`, 429)
  }
  const phase: CfTlsPhase = plan.kind === 'reuse' ? 'production' : 'staging'
  await save({
    ...st(),
    tls: { prodAttemptAt: st().tls?.prodAttemptAt, prodCert: st().tls?.prodCert, phase, ca: phase === 'production' ? 'production' : 'staging', startedAt: new Date().toISOString(), steps: [] },
  })
  void runTls(actor)
}

/** Gültiges produktives Wildcard-Zertifikat im Caddy-Speicher (Datei gelesen; null ohne eingebundenes Volume). */
function storedProd(): StoredCert | null {
  const base = ecf.baseDomain()
  return base ? storedProductionWildcard(config.CADDY_DATA_DIR, base) : null
}

/**
 * Was über produktive Zertifikate bekannt ist: gesehen, laut Log bezogen –
 * oder im Caddy-Speicher gefunden (gewinnt, wenn es länger gilt).
 */
const prodState = (): ProdState => {
  const known = st().tls?.prodCert
  const s = storedProd()
  const fromStorage = s && (!known || Date.parse(s.validTo) > Date.parse(known.validTo))
    ? { validTo: s.validTo, issuer: s.issuer, seenAt: new Date().toISOString(), source: 'storage' as const, trusted: null }
    : null
  return { prodAttemptAt: st().tls?.prodAttemptAt, prodCert: fromStorage ?? known }
}
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('de-CH') : '–')

/** Produktives Zertifikat gesehen (TLS-Prüfung): merken, damit es nie neu bestellt wird. */
async function rememberProdCert(c: CertInfo | null, base: string): Promise<void> {
  const tls = st().tls
  if (!c || !tls || !productionIssued(c, base)) return
  const prev = tls.prodCert
  if (prev?.source === 'probe' && prev.validTo === c.validTo && prev.trusted === c.ok) return
  await save({ ...st(), tls: { ...tls, prodCert: { validTo: c.validTo!, issuer: c.issuer, seenAt: new Date().toISOString(), source: 'probe', trusted: c.ok } } })
}

/** Laut Caddy-Log produktiv bezogen: merken (Ablauf geschätzt), falls die TLS-Prüfung es nicht sieht. */
async function rememberProdFromLog(at: number, issuer: string): Promise<void> {
  const tls = st().tls
  if (!tls) return
  const prev = tls.prodCert
  if (prev && Date.parse(prev.seenAt) >= at) return
  if (prev?.source === 'probe' && Date.parse(prev.validTo) > at + PROD_LOG_ASSUMED_MS) return
  await save({ ...st(), tls: { ...tls, prodCert: { validTo: new Date(at + PROD_LOG_ASSUMED_MS).toISOString(), issuer, seenAt: new Date(at).toISOString(), source: 'log', trusted: null } } })
}

async function finishDone(actor: string, base: string, issuer: string | null, validTo: string | null, how: string): Promise<void> {
  await setPhase('done', 'production')
  await step(`Zertifikat aktiv: ${issuer ?? "Let's Encrypt"}, gültig bis ${day(validTo)}${how ? ` (${how})` : ''}. Interne Adressen laufen jetzt über https.`, 'ok')
  await reloadCaddy()
  await audit({ actor, action: 'cloudflare.tls', targetType: 'environment', targetId: currentEnvId(), environmentId: currentEnvId(), params: { baseDomain: base, how }, result: 'ok' })
}

/**
 * Ablauf: (0) liefert Caddy schon ein vertrauenswürdiges produktives
 * Zertifikat? → fertig, ohne Bezug. (1) Probelauf bei Staging; sieht er dabei
 * ein produktives → fertig. (2) Produktion: vorhandenes laden oder – höchstens
 * einmal pro Stunde – neu bestellen lassen.
 * resume: nach einem Neustart in der Produktionsphase; die Bestellung ist
 * schon gezählt und läuft in Caddy weiter.
 */
function runTls(actor: string, o: { resume?: boolean } = {}): Promise<void> {
  const envId = currentEnvId()
  const running = tlsRuns.get(envId)
  if (running) return running
  const run = (async () => {
    const base = ecf.baseDomain()!
    try {
      // Staging-Wildcards früherer Probeläufe aus Caddys Speicher entfernen
      // (Volume caddy_data, nicht über den Docker-Socket)
      try {
        if (removeStagingWildcard(config.CADDY_DATA_DIR, base)) {
          await step(`Altes Staging-Zertifikat für *.${base} aus Caddys Speicher entfernt`)
        }
      } catch (err) {
        log.warn('Caddy-Speicher nicht aufgeräumt', { dir: config.CADDY_DATA_DIR, err: String(err) })
      }

      const first = await probeCert(config.CADDY_CONTAINER, 443, `${UI_HOST_LABEL}.${base}`)
      await rememberProdCert(first, base)
      if (checkIssuedCert(first, { base, phase: 'production' }).ready) {
        await finishDone(actor, base, first.issuer, first.validTo, 'Caddy liefert es schon aus, kein neuer Bezug')
        return
      }

      // Liegt ein gültiges produktives Zertifikat im Speicher: kein Probelauf,
      // keine Bestellung – die Konfiguration verwaltet *.<basis> dann ohnehin
      // mit der Produktions-CA, und Caddy lädt es (lib/tls-options.ts).
      const inStorage = storedProd()
      if (inStorage) {
        await step(`Gültiges Zertifikat in Caddys Speicher: ${inStorage.issuer ?? "Let's Encrypt"}, gültig bis ${day(inStorage.validTo)} – kein Probelauf, keine neue Bestellung`, 'ok')
      } else if (st().tls?.phase !== 'production') {
        // Probelauf mit eigenem Namen: prüft Token und DNS-Challenge, ohne je
        // ein Staging-Wildcard in Caddys Cache zu legen
        await setPhase('staging', 'staging')
        await step(`Probelauf: Zertifikat für ${probeName(base)} bei der Staging-CA von Let's Encrypt anfordern (prüft Token und DNS-Challenge über Cloudflare)`)
        const t0 = Date.now()
        await reloadCaddy(true)
        const s = await waitForCert(base, 'staging', t0)
        if (!s.ok) throw new Error(s.error)
        await step(`Probelauf erfolgreich: ${s.issuer}`, 'ok')
      }

      if (!o.resume && !inStorage) {
        const gate = mayOrderProduction(prodState())
        if (!gate.ok) {
          throw new Error(`Kein neuer produktiver Versuch vor ${clock(gate.until)} Uhr: höchstens einer pro Stunde, damit Let's Encrypt nicht sperrt.`)
        }
        if (gate.reuse) {
          const pc = st().tls!.prodCert!
          await step(`Vorhandenes Zertifikat (${pc.issuer ?? "Let's Encrypt"}, gültig bis ${day(pc.validTo)}) aus Caddys Speicher laden – kein neuer Bezug`)
        } else {
          await save({ ...st(), tls: { ...st().tls!, prodAttemptAt: new Date().toISOString() } })
          await step(`Echtes Zertifikat für *.${base} bei Let's Encrypt anfordern`)
        }
      }
      await setPhase('production', 'production')
      const t1 = Date.now()
      await reloadCaddy(true)
      const p = await waitForCert(base, 'production', t1)
      if (!p.ok) throw new Error(p.error)
      await finishDone(actor, base, p.issuer, p.validTo, inStorage ? 'aus Caddys Speicher, kein neuer Bezug' : '')
    } catch (err) {
      const message = (err as Error).message
      await step(message, 'bad')
      await setPhase('failed', st().tls?.ca ?? 'staging')
      await reloadCaddy()
      await audit({ actor, action: 'cloudflare.tls', targetType: 'environment', targetId: envId, environmentId: envId, params: { baseDomain: base }, result: 'error', error: message })
    } finally {
      tlsRuns.delete(envId)
    }
  })()
  tlsRuns.set(envId, run)
  return run
}

type CertWait = { ok: true; issuer: string | null; validTo: string | null } | { ok: false; error: string }

/** In der Produktionsphase: so lange darf ein falsches Zertifikat (nicht vertrauenswürdig oder noch Staging) bestehen, bevor abgebrochen wird */
const WRONG_CERT_GRACE_MS = 60_000

/**
 * Warten, bis Caddy das Zertifikat der Phase ausliefert.
 * - staging: acme-probe.<basis> von der Staging-CA (ohne Prüfung der Kette)
 * - production: *.<basis>, vertrauenswürdig (SNI <UI_HOST_LABEL>.<basis>, vorerst deployer.<basis>)
 * Zweite Quelle ist Caddys Log («certificate obtained successfully» für den
 * Namen). Liefert Caddy in der Produktionsphase nach 60 s noch ein Staging-
 * oder ein nicht vertrauenswürdiges Zertifikat aus, bricht die Phase sofort mit
 * Erklärung ab statt 6 Minuten zu warten. Bei Zeitüberschreitung: was die
 * TLS-Prüfung zuletzt sah und was Caddy zuletzt meldete – oder, ohne Treffer,
 * welcher Zeitraum und welche Logger durchsucht wurden.
 */
async function waitForCert(base: string, phase: 'staging' | 'production', sinceMs: number): Promise<CertWait> {
  const staging = phase === 'staging'
  const wildcard = `*.${base}`
  const name = staging ? probeName(base) : wildcard
  const host = staging ? probeName(base) : `${UI_HOST_LABEL}.${base}`
  const deadline = Date.now() + TLS_TIMEOUT_MS
  let lastError = ''
  let lastReason = ''
  let lastLine: string | null = null
  let logProblem: string | null = null
  let obtainedSeen: number | null = null
  let wrongSince: number | null = null
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000))
    const c = await probeCert(config.CADDY_CONTAINER, 443, host)
    if (!staging) await rememberProdCert(c, base)
    const v = checkIssuedCert(c, { base, phase, name })
    if (v.ready) return { ok: true, issuer: c.issuer, validTo: c.validTo }
    lastReason = v.reason

    // Produktion: nach 60 s noch das falsche Zertifikat → sofort mit Erklärung abbrechen
    if (!staging) {
      const servesWildcard = (c.sans?.length ? c.sans : c.subject ? [c.subject] : []).some((n) => n.toLowerCase() === wildcard.toLowerCase())
      const stillStaging = servesWildcard && isStagingIssuer(c.issuer)
      const untrusted = productionIssued(c, base) && !c.ok
      if (stillStaging || untrusted) {
        wrongSince ??= Date.now()
        if (Date.now() - wrongSince >= WRONG_CERT_GRACE_MS) {
          return {
            ok: false,
            error: stillStaging
              ? `Caddy liefert nach 60 s noch das Staging-Zertifikat für ${wildcard} aus (${c.issuer ?? 'unbekannt'}). Es stammt aus Caddys Zertifikats-Cache eines früheren Laufs; der Cache überlebt das Neuladen. Airlock hat ihn geleert und Staging-Wildcards aus dem Speicher entfernt – greift das nicht, «docker restart ${config.CADDY_CONTAINER}» und dann «Nochmals versuchen».`
              : `Caddy liefert das produktive Zertifikat für ${wildcard} aus (${c.issuer ?? 'unbekannt'}, gültig bis ${day(c.validTo)}), aber Airlock vertraut der Kette nicht: ${c.error ?? 'unbekannter Fehler'}. Es bleibt gespeichert und wird nicht neu bestellt.`,
          }
        }
      } else {
        wrongSince = null
      }
    }

    let logs = ''
    try {
      logs = await docker.getLogs(config.CADDY_CONTAINER, { tail: 400 })
      logProblem = null
    } catch (err) {
      logProblem = `Caddy-Log nicht lesbar (${(err as Error).message})`
    }
    const ev = parseCaddyTlsLog(logs, name, sinceMs)
    lastLine = ev.lastLine ?? lastLine
    if (ev.obtained && !ev.obtained.staging && !staging) await rememberProdFromLog(ev.obtained.at, ev.obtained.issuer)
    if (ev.obtained && ev.obtained.staging === staging) {
      if (obtainedSeen === null) {
        obtainedSeen = Date.now()
        await step(`Caddy meldet: Zertifikat für ${name} bezogen (${ev.obtained.issuer || 'ACME'})`, 'ok')
      }
      if (staging && Date.now() - obtainedSeen >= 30_000) {
        await step(`Hinweis: Die TLS-Prüfung sieht es noch nicht (${v.reason}). Weiter mit Produktion, dort wird voll geprüft.`, 'info')
        return { ok: true, issuer: ev.obtained.issuer || null, validTo: c.validTo }
      }
    }
    if (ev.lastError && ev.lastError !== lastError) {
      lastError = ev.lastError
      await step(`Caddy meldet: ${lastError}`, 'bad')
    }
  }
  const what = staging ? `Staging-Zertifikat für ${name}` : `vertrauenswürdiges Zertifikat für ${wildcard}`
  const searched = `keine Zertifikats-Zeile im Caddy-Log seit ${clock(new Date(sinceMs))} Uhr (Logger tls, tls.obtain, tls.issuance; letzte 400 Zeilen von ${config.CADDY_CONTAINER})`
  const parts = [
    `Nach ${TLS_TIMEOUT_MS / 60_000} Minuten kein ${what}.`,
    obtainedSeen !== null ? 'Caddy hat es laut Log bezogen, liefert es aber nicht aus.' : null,
    `TLS-Prüfung von ${host}: ${lastReason || 'keine Antwort'}.`,
    `Letzte Meldung von Caddy zum Zertifikat: ${lastLine ?? logProblem ?? searched}`,
  ]
  return { ok: false, error: parts.filter(Boolean).join(' ') }
}

/* --- Trennen ------------------------------------------------------------------- */

/** Verbindung trennen: cloudflared weg, Tunnel löschen, Token und Zertifikat weg. Die Basisdomain bleibt. */
export async function disconnect(actor: string): Promise<void> {
  const env = currentEnv()
  // M9: nur öffentliche Projekte DIESER Umgebung halten das Trennen auf
  const publicRows = await db.select({ hostname: schema.routes.hostname }).from(schema.routes)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.routes.projectId))
    .where(and(eq(schema.routes.target, 'public'), eq(schema.projects.environmentId, env.id)))
  if (publicRows.length) {
    throw conflict(`Noch ${publicRows.length === 1 ? 'ist ein Projekt' : `sind ${publicRows.length} Projekte`} öffentlich (${publicRows.map((r) => r.hostname).join(', ')}). Zuerst unter Einstellungen → Erreichbarkeit auf intern stellen.`)
  }
  // Nutzt eine andere Umgebung dasselbe Konto, bleiben Tunnel und cloudflared – nur diese Umgebung löst sich
  const shared = env.account ? allEnvironments().some((e) => e.id !== env.id && e.account?.id === env.account!.id) : false
  const tunnel = st().tunnel
  const accountId = st().accountId
  if (!shared) {
    await removeCloudflared(cloudflaredName())
    if (tunnel && accountId && st().tokenEnc) {
      await client().deleteTunnel(accountId, tunnel.id).catch((err) => log.warn('Tunnel bei Cloudflare nicht gelöscht', { err: String(err) }))
    }
  }
  const baseDomain = st().baseDomain
  const tailscaleIp = st().tailscaleIp
  const keep: Stored = { ...(baseDomain ? { baseDomain } : {}), ...(tailscaleIp !== undefined ? { tailscaleIp } : {}) }
  await save(keep)
  await reloadCaddy(true)
  await audit({ actor, action: 'cloudflare.disconnect', targetType: 'environment', targetId: currentEnvId(), environmentId: currentEnvId(), params: {}, result: 'ok' })
}

/* --- Caddy -------------------------------------------------------------------- */

async function reloadCaddy(force = false): Promise<void> {
  const { reconcileCaddy } = await import('./routes.js')
  await reconcileCaddy({ force }).catch((err) => log.warn('Caddy-Abgleich fehlgeschlagen', { err: String(err) }))
}

/* --- Status --------------------------------------------------------------------- */

export async function cloudflareStatus(): Promise<CfStatusDto> {
  const { listDomains, tunnelStatusFor } = await import('./public.js')
  const env = currentEnv()
  // M9: eigene Zonen plus die noch freien desselben Kontos (nicht Hauptzone einer anderen Umgebung) –
  // so kann eine Umgebung mit mitbenutztem Token ihre Hauptzone wählen (claimZone beim Speichern)
  const sameAccount = env.account ? allEnvironments().filter((e) => e.id !== env.id && e.account?.id === env.account!.id) : []
  const own = await listDomains(inEnvironment(env.id)).catch(() => [])
  const claimable = (await Promise.all(sameAccount.map((e) => listDomains(inEnvironment(e.id)).catch(() => []))))
    .flat()
    .filter((z) => !sameAccount.some((e) => e.zoneName === z.name))
    .map((z) => ({ ...z, isDefault: false }))
  const zones = [...own, ...claimable].sort((a, b) => a.name.localeCompare(b.name))
  const tunnelId = ecf.tunnelId()
  const managed = Boolean(st().tunnel)
  const container = tunnelId ? await cloudflaredState(cloudflaredName()).catch(() => null) : null
  const lastLog = container?.exists && !container.running
    ? (await cloudflaredLogTail(10, cloudflaredName())).split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !/^See 'cloudflared/.test(l)).at(-1) ?? null
    : null
  const ts = tunnelId ? await tunnelStatusFor(env.id).catch(() => null) : null
  const ingress = tunnelId ? await foreignIngress() : { foreign: [], error: null }
  const runningImage = container?.exists ? container.image : managed ? cloudflaredImage() : null
  const latest = tunnelId ? await latestCloudflaredVersion() : { version: null, error: null }
  const currentVersion = versionOf(runningImage)
  const tls = caddyTlsOptions()
  const base = ecf.baseDomain()
  const cert = base && (tls || (st().tls?.phase ?? (isDefaultEnv() && config.TLS_MODE === 'cloudflare' ? 'done' : 'off')) === 'done')
    ? await probeCert(config.CADDY_CONTAINER, 443, `${UI_HOST_LABEL}.${base}`, 3000).catch(() => null)
    : null
  // Nach einem Fehlschlag: liefert Caddy inzwischen ein vertrauenswürdiges
  // produktives Zertifikat aus, ist HTTPS aktiv – ohne neuen Bezug.
  if (cert && base && st().tls) {
    await rememberProdCert(cert, base)
    if (st().tls?.phase === 'failed' && !tlsRunning() && checkIssuedCert(cert, { base, phase: 'production' }).ready) {
      await finishDone('system', base, cert.issuer, cert.validTo, 'nach dem Fehlschlag von Caddy ausgeliefert erkannt')
    }
  }
  const legacyPhase: CfTlsPhase = isDefaultEnv() && config.TLS_MODE === 'cloudflare' ? 'done' : 'off'
  const phase: CfTlsPhase = st().tls?.phase ?? legacyPhase
  const retryAt = st().tls && phase !== 'done' && !tlsRunning() ? nextProdAttemptAt(prodState()) : null
  const publicProjects = (await db.select({ id: schema.routes.id }).from(schema.routes)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.routes.projectId))
    .where(and(eq(schema.routes.target, 'public'), eq(schema.projects.environmentId, env.id)))).length
  // Letzte Sicherung: Schritte, cloudflared-Log, Zertifikats- und Ingress-
  // Fehler stammen aus fremden Meldungen und können Tokens enthalten.
  return redactDeep<CfStatusDto>({
    source: st().tokenEnc ? 'ui' : ecf.tokenSource() === 'env' ? 'env' : null,
    token: { present: Boolean(ecf.token()), source: ecf.tokenSource(), savedAt: st().tokenSavedAt ?? null, lastCheck: st().lastCheck ?? null },
    account: ecf.accountId() ? { id: ecf.accountId()!, name: st().accountName ?? null } : null,
    zones: zones.map((z) => ({ id: z.zoneId, name: z.name, isDefault: z.isDefault })),
    baseDomain: base,
    defaultZone: zones.find((z) => z.isDefault)?.name ?? null,
    tailscaleIp: ecf.tailscaleIp(),
    detectedTailscaleIp: net.detected().tailscaleIp,
    accessEmail: ecf.accessEmail(),
    acmeEmail: ecf.acmeEmail(),
    tunnel: tunnelId
      ? {
          id: tunnelId,
          name: st().tunnel?.name ?? null,
          managed,
          container: container ? { exists: container.exists, running: container.running, restarting: container.restarting, startedAt: container.startedAt, lastLog } : null,
          status: ts?.status ?? null,
          connections: ts?.connections ?? 0,
          version: currentVersion,
          latestVersion: latest.version,
          updateAvailable: Boolean(managed && currentVersion && latest.version && compareVersions(latest.version, currentVersion) > 0),
          foreignIngress: ingress.foreign,
          ingressError: ingress.error,
        }
      : null,
    tunnelSkipped: !tunnelId && Boolean(st().tunnelSkipped),
    tls: {
      enabled: Boolean(tls) || phase === 'done',
      phase,
      ca: st().tls?.ca ?? config.ACME_CA,
      startedAt: st().tls?.startedAt ?? null,
      steps: st().tls?.steps ?? [],
      retryAt: retryAt ? retryAt.toISOString() : null,
      reusesCert: prodCertUsable(prodState()) && phase !== 'done',
      cert: cert ? { issuer: cert.issuer, validTo: cert.validTo, daysLeft: cert.daysLeft, ok: cert.ok, error: cert.error } : null,
    },
    tokenTemplateUrl: tokenTemplateUrl(),
    requiredPermissions: REQUIRED_PERMISSIONS.map(({ label, required, why }) => ({ label, required, why })),
    publicProjects,
  })
}

/** Liegt das gemeinsame Volume für Caddy bereit? (alter Stack ohne caddy_secrets) */
export const caddySecretsReady = () => existsSync(config.CADDY_SECRETS_DIR)

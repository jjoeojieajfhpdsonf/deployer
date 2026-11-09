import { join } from 'node:path'
import { mkdir, rm, writeFile, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import type { CfStatusDto, CfTokenCheckDto, CfPermissionCheck, CfTlsPhase } from '@deployer/shared'
import { config, setCfRuntime, cf, net, type CfRuntime } from '../config.js'
import { db, schema, getSetting, setSetting } from '../db/index.js'
import { loadOrCreateKey, encrypt, decrypt } from '../lib/crypto.js'
import { Cloudflare, CloudflareError } from '../drivers/cloudflare.js'
import {
  startCloudflared, removeCloudflared, cloudflaredState, ensureCloudflaredRunning, cloudflaredLogTail,
  versionOf, latestCloudflaredVersion, compareVersions, imageWithVersion,
} from '../drivers/cloudflared.js'
import { TUNNEL_SERVICE, CATCH_ALL } from '../lib/public-hosts.js'
import type { TlsOptions } from '../drivers/caddy-config.js'
import { probeCert } from '../lib/cert.js'
import * as docker from '../drivers/docker.js'
import { audit } from './audit.js'
import { AppError, badRequest, conflict } from '../lib/errors.js'
import { log } from '../lib/log.js'
import { redactSecrets, redactDeep, registerSecret } from '../lib/redact.js'

/**
 * «Cloudflare verbinden» (Systemseite): Token, Konto, Zonen, Tunnel und
 * Zertifikat werden über die Oberfläche eingerichtet und hier gespeichert,
 * das Token verschlüsselt wie die Zugangsdaten der Benachrichtigungen.
 * Was hier fehlt, kommt weiter aus .env (alte Einrichtung über
 * compose.tls.yaml / compose.public.yaml).
 */

const KEY = 'cloudflare'
const key = () => loadOrCreateKey(join(config.DATA_DIR, 'keys', 'secrets.key'))
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
  tls?: { phase: CfTlsPhase; ca: 'production' | 'staging'; startedAt: string; steps: Step[] }
}

let stored: Stored = {}

async function load(): Promise<Stored> {
  const raw = await getSetting(KEY)
  try {
    return raw ? (JSON.parse(raw) as Stored) : {}
  } catch {
    return {}
  }
}

async function save(next: Stored): Promise<void> {
  stored = next
  await setSetting(KEY, JSON.stringify(next))
  await applyRuntime()
}

/** Pfad der Token-Datei für Caddy (gemeinsames Volume). */
export const caddyTokenPath = () => join(config.CADDY_SECRETS_DIR, 'cloudflare_token')

/** Datenbankwerte in config.ts übernehmen und die Token-Datei für Caddy schreiben. */
async function applyRuntime(): Promise<void> {
  const r: Partial<CfRuntime> = {}
  if (stored.tokenEnc) {
    try {
      r.token = dec(stored.tokenEnc)
      registerSecret(r.token)
    } catch (err) {
      log.error('Cloudflare-Token nicht entschlüsselbar (Schlüsseldatei getauscht?)', { err: String(err) })
    }
  }
  if (stored.tunnel) {
    try {
      registerSecret(dec(stored.tunnel.tokenEnc))
    } catch {
      /* Meldung oben genügt */
    }
  }
  if (stored.accountId) r.accountId = stored.accountId
  if (stored.tunnel) r.tunnelId = stored.tunnel.id
  if (stored.baseDomain) r.baseDomain = stored.baseDomain
  if (stored.tailscaleIp !== undefined) r.tailscaleIp = stored.tailscaleIp
  if (stored.accessEmail !== undefined) r.accessEmail = stored.accessEmail
  if (stored.acmeEmail !== undefined) r.acmeEmail = stored.acmeEmail
  if (stored.tls) {
    // https:// in Adressen erst, wenn das echte Zertifikat da ist
    r.tls = stored.tls.phase === 'done'
    r.acmeCa = stored.tls.ca
  }
  setCfRuntime(r)
  await writeCaddyToken(r.token ?? null)
}

async function writeCaddyToken(token: string | null): Promise<void> {
  const file = caddyTokenPath()
  try {
    if (!token) {
      await rm(file, { force: true })
      return
    }
    await mkdir(config.CADDY_SECRETS_DIR, { recursive: true, mode: 0o700 })
    await writeFile(file, token, { mode: 0o600 })
    await chmod(file, 0o600)
  } catch (err) {
    log.warn('Token-Datei für Caddy nicht geschrieben', { dir: config.CADDY_SECRETS_DIR, err: String(err) })
  }
}

/** Beim Start, vor allem anderen, das Adressen braucht. */
export async function loadCloudflareSettings(): Promise<void> {
  stored = await load()
  await applyRuntime()
  // Aufräumen: Schritte aus der Zeit vor dem Schwärzen können ein Token enthalten
  // (caddy-dns/cloudflare v0.2.1: «API token '…' appears invalid»).
  if (stored.tls?.steps.length) {
    const steps = redactDeep(stored.tls.steps)
    if (JSON.stringify(steps) !== JSON.stringify(stored.tls.steps)) {
      await save({ ...stored, tls: { ...stored.tls, steps } })
      log.warn('Token aus gespeicherten Zertifikats-Schritten entfernt')
    }
  }
}

/** cloudflared wieder hochfahren, falls deployer ihn verwaltet (beim Start, im Hintergrund). */
export async function ensureManagedTunnelOnBoot(): Promise<void> {
  if (!stored.tunnel) return
  try {
    const r = await ensureCloudflaredRunning(dec(stored.tunnel.tokenEnc), cloudflaredImage())
    if (r !== 'running') log.info('cloudflared gestartet', { how: r })
  } catch (err) {
    log.warn('cloudflared nicht gestartet', { err: (err as Error).message })
  }
  // Eine unterbrochene Zertifikats-Einrichtung weiterführen
  if (stored.tls && (stored.tls.phase === 'staging' || stored.tls.phase === 'production')) void runTls('system')
}

/**
 * TLS-Optionen für Caddy. Aus der Datenbank: das Token kommt aus der Datei,
 * die Weiterleitung auf https erst, wenn das echte Zertifikat da ist. Sonst
 * die alte Einrichtung über .env.
 */
export function caddyTlsOptions(): (TlsOptions & { redirect: boolean }) | null {
  const base = cf.baseDomain()
  if (stored.tls) {
    if (!base || !stored.tokenEnc || stored.tls.phase === 'off' || stored.tls.phase === 'failed') return null
    return { baseDomain: base, acmeCa: stored.tls.ca, email: cf.acmeEmail(), tokenFile: caddyTokenPath(), redirect: stored.tls.phase === 'done' }
  }
  if (config.TLS_MODE === 'cloudflare' && base) return { baseDomain: base, acmeCa: config.ACME_CA, email: config.ACME_EMAIL, tokenFile: null, redirect: true }
  return null
}

const client = (token?: string) => {
  const t = token ?? cf.token()
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
  const q = new URLSearchParams({ permissionGroupKeys: JSON.stringify(groups), name: 'deployer', accountId: '*', zoneId: 'all' })
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
  if (!/^[A-Za-z0-9_-]{30,200}$/.test(t)) throw badRequest('Das sieht nicht wie ein Cloudflare-API-Token aus (40 Zeichen aus Buchstaben, Ziffern, - und _).', [{ path: 'token', message: 'Füge das API-Token ein, das Cloudflare nach «Token erstellen» einmal anzeigt.' }])
  const check = await checkToken(t, stored.accountId)
  if (!check.valid) throw badRequest(check.message ?? 'Token ungültig', [{ path: 'token', message: check.message ?? 'Token ungültig' }])
  if (!check.complete) throw new AppError('cf_permissions', check.message ?? 'Rechte unvollständig', 400, { check })
  if (stored.accountId && !check.accounts.some((a) => a.id === stored.accountId)) {
    throw badRequest(`Das neue Token sieht das Konto «${stored.accountName ?? stored.accountId}» nicht, in dem der Tunnel liegt. Ein Token für dasselbe Konto erstellen.`)
  }
  const acc = check.accounts.find((a) => a.id === stored.accountId) ?? check.accounts[0]!
  const replacing = Boolean(stored.tokenEnc)
  await save({ ...stored, tokenEnc: enc(t), tokenSavedAt: new Date().toISOString(), lastCheck: check, accountId: acc.id, accountName: acc.name })
  await syncZones()
  // Caddy liest die Datei beim Laden: neu laden, auch wenn sich die Konfiguration nicht ändert
  if (caddyTlsOptions()) await reloadCaddy(true)
  await audit({ actor, action: replacing ? 'cloudflare.token.replace' : 'cloudflare.token.set', targetType: 'system', targetId: 'cloudflare', params: { account: acc.name }, result: 'ok' })
  return check
}

async function syncZones(): Promise<void> {
  const { syncDomains } = await import('./public.js')
  await syncDomains(client()).catch((err) => log.warn('Zonen nicht abgeglichen', { err: String(err) }))
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
  if (!stored.tokenEnc) throw badRequest('Zuerst das Token speichern')
  const { listDomains, setDefaultDomain } = await import('./public.js')
  const zones = await listDomains()
  const zone = zones.find((z) => z.name === input.baseZone.toLowerCase())
  if (!zone) throw badRequest(`${input.baseZone} ist keine Zone dieses Kontos`, [{ path: 'baseZone', message: 'Wähle eine Zone aus der Liste.' }])
  const label = input.baseLabel.trim().toLowerCase()
  const baseDomain = label ? `${label}.${zone.name}` : zone.name
  const before = cf.baseDomain()
  const account = input.accountId && stored.lastCheck?.accounts.find((a) => a.id === input.accountId)
  await save({
    ...stored,
    baseDomain,
    ...(account ? { accountId: account.id, accountName: account.name } : {}),
    ...(input.tailscaleIp !== undefined ? { tailscaleIp: input.tailscaleIp || null } : {}),
    ...(input.accessEmail !== undefined ? { accessEmail: input.accessEmail || null } : {}),
    ...(input.acmeEmail !== undefined ? { acmeEmail: input.acmeEmail || null } : {}),
  })
  if (input.defaultZone) await setDefaultDomain(input.defaultZone, actor)
  if (before !== baseDomain) {
    // Bestehende Projekte ziehen auf die neue Basisdomain um; ein Zertifikat für die alte gilt nicht mehr
    const { rehostRoutes } = await import('./routes.js')
    const moved = await rehostRoutes()
    if (stored.tls && stored.tls.phase !== 'off') await save({ ...stored, tls: { ...stored.tls, phase: 'off', steps: [] } })
    log.info('Basisdomain geändert', { baseDomain, moved })
  }
  if (net.tailscaleIp()) {
    const { ensureTailnetDns } = await import('./tailnet.js')
    await ensureTailnetDns(actor).catch((err) => log.warn('Tailnet-Eintrag nicht gesetzt', { err: (err as Error).message }))
  }
  await reloadCaddy()
  await audit({ actor, action: 'cloudflare.domains', targetType: 'system', targetId: 'cloudflare', params: { baseDomain, defaultZone: input.defaultZone }, result: 'ok' })
}

/** Schritt 4: Tunnel per API anlegen (oder den gleichnamigen wiederverwenden), cloudflared starten. */
export async function setupTunnel(actor: string): Promise<void> {
  if (!stored.tokenEnc || !stored.accountId) throw badRequest('Zuerst das Token speichern')
  const c = client()
  const name = `deployer-${(config.SERVER_NAME || 'server').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
  let tunnel: { id: string; name: string }
  let token: string
  try {
    tunnel = stored.tunnel ?? (await c.findTunnel(stored.accountId, name)) ?? (await c.createTunnel(stored.accountId, name))
    token = await c.tunnelToken(stored.accountId, tunnel.id)
  } catch (err) {
    wrapCf(err)
  }
  await save({ ...stored, tunnel: { id: tunnel.id, name: tunnel.name, tokenEnc: enc(token) }, tunnelSkipped: false })
  await startCloudflared(token, cloudflaredImage())
  const { reconcileTunnel, syncDomains } = await import('./public.js')
  await syncDomains(c).catch(() => {})
  await reconcileTunnel(c).catch((err) => log.warn('Tunnel-Regeln nicht gesetzt', { err: String(err) }))
  await reloadCaddy()
  await audit({ actor, action: 'cloudflare.tunnel', targetType: 'system', targetId: tunnel.id, params: { name: tunnel.name }, result: 'ok' })
}

/**
 * Schritt 4 überspringen: Das Zertifikat für interne Adressen braucht keinen
 * Tunnel (DNS-Challenge über das Token). Ohne Tunnel bleibt nur «Öffentlich» aus.
 */
export async function skipTunnel(actor: string): Promise<void> {
  if (!stored.tokenEnc) throw badRequest('Zuerst das Token speichern')
  if (!cf.baseDomain()) throw badRequest('Zuerst die interne Basisdomain wählen')
  if (stored.tunnel) return
  await save({ ...stored, tunnelSkipped: true })
  await audit({ actor, action: 'cloudflare.tunnel.skip', targetType: 'system', targetId: 'cloudflare', params: {}, result: 'ok' })
}

/** cloudflared neu starten (gleicher Tunnel, frisches Token). */
export async function restartTunnel(actor: string): Promise<void> {
  if (!stored.tunnel || !stored.accountId) throw badRequest('Kein Tunnel eingerichtet')
  let token: string
  try {
    token = await client().tunnelToken(stored.accountId, stored.tunnel.id)
  } catch (err) {
    wrapCf(err)
  }
  await save({ ...stored, tunnel: { ...stored.tunnel, tokenEnc: enc(token) } })
  await startCloudflared(token, cloudflaredImage())
  await audit({ actor, action: 'cloudflare.tunnel.restart', targetType: 'system', targetId: stored.tunnel.id, params: {}, result: 'ok' })
}

/** Das festgelegte Image: nach einem Update das neue, sonst das aus der Konfiguration. */
const cloudflaredImage = () => stored.cloudflaredImage ?? config.CLOUDFLARED_IMAGE

/** cloudflared auf die neueste Version: neues Image festlegen, Container neu anlegen. */
export async function updateCloudflared(actor: string): Promise<void> {
  if (!stored.tunnel || !stored.accountId) throw badRequest('cloudflared wird nicht von deployer verwaltet')
  const latest = await latestCloudflaredVersion(true)
  if (!latest.version) throw new AppError('cloudflared_version', `Neueste Version nicht abrufbar${latest.error ? `: ${latest.error}` : ''}`, 502)
  const current = versionOf(cloudflaredImage())
  if (current && compareVersions(latest.version, current) <= 0) throw badRequest(`cloudflared ${current} ist schon die neueste Version`)
  const image = imageWithVersion(latest.version)
  let token: string
  try {
    token = await client().tunnelToken(stored.accountId, stored.tunnel.id)
  } catch (err) {
    wrapCf(err)
  }
  // Erst anlegen, dann festlegen: scheitert das Holen des Images, bleibt die alte Version
  await startCloudflared(token, image)
  await save({ ...stored, cloudflaredImage: image, tunnel: { ...stored.tunnel, tokenEnc: enc(token) } })
  await audit({ actor, action: 'cloudflare.cloudflared.update', targetType: 'system', targetId: stored.tunnel.id, params: { from: current, to: latest.version }, result: 'ok' })
}

let ingressCache: { at: number; foreign: { hostname: string | null; service: string }[]; error: string | null } | null = null

/**
 * Regeln des Tunnels, die nicht auf Caddy zeigen (etwa von Hand im
 * Dashboard ergänzt). Der Tunnel soll nur Caddy erreichen; alles andere
 * umginge IP-Filter und Routing. Eine Minute zwischengespeichert.
 */
async function foreignIngress(): Promise<{ foreign: { hostname: string | null; service: string }[]; error: string | null }> {
  const acc = cf.accountId()
  const tunnel = cf.tunnelId()
  if (!acc || !tunnel || !cf.token()) return { foreign: [], error: null }
  if (ingressCache && Date.now() - ingressCache.at < 60_000) return ingressCache
  try {
    const rules = await client().getTunnelIngress(acc, tunnel)
    const foreign = rules
      .filter((r) => r.service !== TUNNEL_SERVICE && !(r.service === CATCH_ALL.service && !r.hostname))
      .map((r) => ({ hostname: r.hostname ?? null, service: r.service }))
    ingressCache = { at: Date.now(), foreign, error: null }
  } catch (err) {
    ingressCache = { at: Date.now(), foreign: [], error: (err as Error).message }
  }
  return ingressCache
}

/* --- Zertifikat ------------------------------------------------------------------ */

let tlsRun: Promise<void> | null = null
const TLS_TIMEOUT_MS = 6 * 60_000

async function step(text: string, tone: Step['tone'] = 'info'): Promise<void> {
  if (!stored.tls) return
  await save({ ...stored, tls: { ...stored.tls, steps: [...stored.tls.steps, { at: new Date().toISOString(), text: redactSecrets(text), tone }].slice(-30) } })
}

async function setPhase(phase: CfTlsPhase, ca: 'production' | 'staging'): Promise<void> {
  await save({ ...stored, tls: { ...(stored.tls ?? { startedAt: new Date().toISOString(), steps: [] }), phase, ca } })
}

/** Schritt 5: erst Staging-CA (ohne Rate-Limit-Risiko), dann Produktion. Läuft im Hintergrund. */
export async function startTls(actor: string): Promise<void> {
  if (!stored.tokenEnc) throw badRequest('Zuerst das Token speichern')
  if (!cf.baseDomain()) throw badRequest('Zuerst die interne Basisdomain wählen')
  if (tlsRun) throw conflict('Die Einrichtung des Zertifikats läuft schon')
  await save({ ...stored, tls: { phase: 'staging', ca: 'staging', startedAt: new Date().toISOString(), steps: [] } })
  void runTls(actor)
}

function runTls(actor: string): Promise<void> {
  tlsRun ??= (async () => {
    const base = cf.baseDomain()!
    try {
      if (stored.tls?.phase !== 'production') {
        await setPhase('staging', 'staging')
        await step(`Probelauf: Zertifikat für *.${base} bei der Staging-CA von Let's Encrypt anfordern (DNS-Challenge über Cloudflare)`)
        await reloadCaddy(true)
        const s = await waitForCert(base, true)
        if (!s.ok) throw new Error(s.error)
        await step(`Probelauf erfolgreich: ${s.issuer}`, 'ok')
      }
      await setPhase('production', 'production')
      await step(`Echtes Zertifikat für *.${base} bei Let's Encrypt anfordern`)
      await reloadCaddy(true)
      const p = await waitForCert(base, false)
      if (!p.ok) throw new Error(p.error)
      await setPhase('done', 'production')
      await step(`Zertifikat aktiv: ${p.issuer}, gültig bis ${p.validTo ? new Date(p.validTo).toLocaleDateString('de-CH') : '–'}. Interne Adressen laufen jetzt über https.`, 'ok')
      await reloadCaddy()
      await audit({ actor, action: 'cloudflare.tls', targetType: 'system', targetId: 'cloudflare', params: { baseDomain: base }, result: 'ok' })
    } catch (err) {
      const message = (err as Error).message
      await step(message, 'bad')
      await setPhase('failed', stored.tls?.ca ?? 'staging')
      await reloadCaddy()
      await audit({ actor, action: 'cloudflare.tls', targetType: 'system', targetId: 'cloudflare', params: { baseDomain: base }, result: 'error', error: message })
    } finally {
      tlsRun = null
    }
  })()
  return tlsRun
}

async function waitForCert(base: string, staging: boolean): Promise<{ ok: true; issuer: string | null; validTo: string | null } | { ok: false; error: string }> {
  const deadline = Date.now() + TLS_TIMEOUT_MS
  let lastHint = ''
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000))
    const c = await probeCert(config.CADDY_CONTAINER, 443, `deployer.${base}`)
    const isStaging = /staging/i.test(c.issuer ?? '')
    if (staging && c.validTo && isStaging) return { ok: true, issuer: c.issuer, validTo: c.validTo }
    if (!staging && c.ok && !isStaging) return { ok: true, issuer: c.issuer, validTo: c.validTo }
    const hint = await caddyAcmeHint()
    if (hint && hint !== lastHint) {
      lastHint = hint
      await step(`Caddy meldet: ${hint}`, 'bad')
    }
  }
  return { ok: false, error: `Nach ${TLS_TIMEOUT_MS / 60_000} Minuten kein ${staging ? 'Staging-' : ''}Zertifikat.${lastHint ? ` Letzte Meldung von Caddy: ${lastHint}` : ' Caddy-Log prüfen (docker logs deployer-caddy).'}` }
}

/** Letzter ACME-Fehler aus Caddys Log, ohne Token (das steht dort nie – nur der Platzhalter). */
async function caddyAcmeHint(): Promise<string | null> {
  const logs = await docker.getLogs(config.CADDY_CONTAINER, { tail: 80 }).catch(() => '')
  const lines = logs.split('\n').filter((l) => /"level":"error"/.test(l) && /acme|challenge|obtain|certificate|dns/i.test(l))
  const last = lines.at(-1)
  if (!last) return null
  try {
    const j = JSON.parse(last) as { msg?: string; error?: string }
    return [j.msg, j.error].filter(Boolean).join(': ').slice(0, 500)
  } catch {
    return last.slice(0, 500)
  }
}

/* --- Trennen ------------------------------------------------------------------- */

/** Verbindung trennen: cloudflared weg, Tunnel löschen, Token und Zertifikat weg. Die Basisdomain bleibt. */
export async function disconnect(actor: string): Promise<void> {
  const publicRows = await db.select({ hostname: schema.routes.hostname }).from(schema.routes).where(eq(schema.routes.target, 'public'))
  if (publicRows.length) {
    throw conflict(`Noch ${publicRows.length === 1 ? 'ist ein Projekt' : `sind ${publicRows.length} Projekte`} öffentlich (${publicRows.map((r) => r.hostname).join(', ')}). Zuerst unter Einstellungen → Erreichbarkeit auf intern stellen.`)
  }
  await removeCloudflared()
  if (stored.tunnel && stored.accountId && stored.tokenEnc) {
    await client().deleteTunnel(stored.accountId, stored.tunnel.id).catch((err) => log.warn('Tunnel bei Cloudflare nicht gelöscht', { err: String(err) }))
  }
  const keep: Stored = { ...(stored.baseDomain ? { baseDomain: stored.baseDomain } : {}), ...(stored.tailscaleIp !== undefined ? { tailscaleIp: stored.tailscaleIp } : {}) }
  await save(keep)
  await reloadCaddy(true)
  await audit({ actor, action: 'cloudflare.disconnect', targetType: 'system', targetId: 'cloudflare', params: {}, result: 'ok' })
}

/* --- Caddy -------------------------------------------------------------------- */

async function reloadCaddy(force = false): Promise<void> {
  const { reconcileCaddy } = await import('./routes.js')
  await reconcileCaddy({ force }).catch((err) => log.warn('Caddy-Abgleich fehlgeschlagen', { err: String(err) }))
}

/* --- Status --------------------------------------------------------------------- */

export async function cloudflareStatus(): Promise<CfStatusDto> {
  const { listDomains, tunnelStatus } = await import('./public.js')
  const zones = await listDomains().catch(() => [])
  const tunnelId = cf.tunnelId()
  const managed = Boolean(stored.tunnel)
  const container = tunnelId ? await cloudflaredState().catch(() => null) : null
  const lastLog = container?.exists && !container.running
    ? (await cloudflaredLogTail(10)).split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !/^See 'cloudflared/.test(l)).at(-1) ?? null
    : null
  const ts = tunnelId ? await tunnelStatus().catch(() => null) : null
  const ingress = tunnelId ? await foreignIngress() : { foreign: [], error: null }
  const runningImage = container?.exists ? container.image : managed ? cloudflaredImage() : null
  const latest = tunnelId ? await latestCloudflaredVersion() : { version: null, error: null }
  const currentVersion = versionOf(runningImage)
  const tls = caddyTlsOptions()
  const phase: CfTlsPhase = stored.tls?.phase ?? (config.TLS_MODE === 'cloudflare' ? 'done' : 'off')
  const base = cf.baseDomain()
  const cert = base && (tls || phase === 'done') ? await probeCert(config.CADDY_CONTAINER, 443, `deployer.${base}`, 3000).catch(() => null) : null
  const publicProjects = (await db.select({ id: schema.routes.id }).from(schema.routes).where(eq(schema.routes.target, 'public'))).length
  // Letzte Sicherung: Schritte, cloudflared-Log, Zertifikats- und Ingress-
  // Fehler stammen aus fremden Meldungen und können Tokens enthalten.
  return redactDeep<CfStatusDto>({
    source: stored.tokenEnc ? 'ui' : cf.tokenSource() === 'env' ? 'env' : null,
    token: { present: Boolean(cf.token()), source: cf.tokenSource(), savedAt: stored.tokenSavedAt ?? null, lastCheck: stored.lastCheck ?? null },
    account: cf.accountId() ? { id: cf.accountId()!, name: stored.accountName ?? null } : null,
    zones: zones.map((z) => ({ id: z.zoneId, name: z.name, isDefault: z.isDefault })),
    baseDomain: base,
    defaultZone: zones.find((z) => z.isDefault)?.name ?? null,
    tailscaleIp: cf.tailscaleIp(),
    detectedTailscaleIp: net.detected().tailscaleIp,
    accessEmail: cf.accessEmail(),
    acmeEmail: cf.acmeEmail(),
    tunnel: tunnelId
      ? {
          id: tunnelId,
          name: stored.tunnel?.name ?? null,
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
    tunnelSkipped: !tunnelId && Boolean(stored.tunnelSkipped),
    tls: {
      enabled: Boolean(tls) || phase === 'done',
      phase,
      ca: stored.tls?.ca ?? config.ACME_CA,
      startedAt: stored.tls?.startedAt ?? null,
      steps: stored.tls?.steps ?? [],
      cert: cert ? { issuer: cert.issuer, validTo: cert.validTo, daysLeft: cert.daysLeft, ok: cert.ok, error: cert.error } : null,
    },
    tokenTemplateUrl: tokenTemplateUrl(),
    requiredPermissions: REQUIRED_PERMISSIONS.map(({ label, required, why }) => ({ label, required, why })),
    publicProjects,
  })
}

/** Liegt das gemeinsame Volume für Caddy bereit? (alter Stack ohne caddy_secrets) */
export const caddySecretsReady = () => existsSync(config.CADDY_SECRETS_DIR)

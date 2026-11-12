import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomBytes, createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { join } from 'node:path'
import { UI_HOST_LABEL, type PasskeyHostDto } from '@airlock/shared'
import { getSetting, setSetting } from '../db/index.js'
import { hashPassword, verifyPassword, loadOrCreateKey } from '../lib/crypto.js'
import { config, cf, net } from '../config.js'
import { unauthorized, AppError } from '../lib/errors.js'
import { bearerFrom } from '../lib/tokens.js'
import { verifyToken } from '../domain/tokens.js'
import { inEnvironment, sessionScope } from '../lib/scope.js'
import { log } from '../lib/log.js'
import { audit } from '../domain/audit.js'
import { AuthService, SESSION_MAX_AGE_MS, type ClientInfo, type RpContext } from '../auth/service.js'
import type { SessionRow } from '../auth/store.js'
import { PgAuthStore } from '../auth/store-pg.js'
import { clientIp } from '../auth/client.js'
import { hostHeader, passkeyHostFor } from '../auth/rp.js'

export const SESSION_COOKIE = 'airlock_session'
/** Zweiter Schritt der Anmeldung (nach dem richtigen Passwort), 5 Min. */
export const PENDING_COOKIE = 'airlock_login'
/** Passkey-Herausforderung (Anmeldung, Bestätigung, Einrichten), 5 Min. */
export const CHALLENGE_COOKIE = 'airlock_webauthn'

/**
 * Ein Konto (Passwort aus .env bzw. in der Oberfläche geändert), dazu
 * Passkeys und Authenticator-App (Nacht 3, Etappe 1). Sitzungen stehen in
 * auth_sessions; das Cookie trägt nur einen zufälligen Wert (signiert),
 * in der Datenbank steht dessen SHA-256.
 *
 * Auch wenn der Dienst nur im LAN haengt: ohne Login kann jedes Geraet im
 * Netz Container starten.
 */

/* --- Dienst ---------------------------------------------------------------- */

let service: AuthService | null = null
let dummyHash: string | null = null

/** Der Anmelde-Dienst (im Betrieb mit PostgreSQL); Tests setzen ihren eigenen */
export function auth(): AuthService {
  if (!service) {
    service = new AuthService({
      store: new PgAuthStore(),
      key: () => loadOrCreateKey(join(config.DATA_DIR, 'keys', 'secrets.key')),
      audit,
      verifyPassword,
      get dummyHash() {
        // Einmal berechnet: ein gültiger Hash mit denselben Parametern wie das echte Passwort
        dummyHash ??= hashPassword(randomBytes(16).toString('hex'))
        return dummyHash
      },
      lanCidr: () => net.lanCidr(),
      accountName: () => config.ADMIN_NAME || 'Admin',
    })
  }
  return service
}

export function setAuthService(s: AuthService | null): void {
  service = s
}

/* --- Passwort ---------------------------------------------------------------- */

/** Fingerabdruck des Passworts aus .env – nur um eine Änderung dort zu erkennen. */
// Bewusst weiter «deployer-env»: der gespeicherte Fingerabdruck stammt aus
// der deployer-Zeit. Ein anderer Text liesse ihn nicht mehr passen, und das
// in der Oberfläche geänderte Passwort würde auf ADMIN_PASSWORD zurückgesetzt.
const envFingerprint = () => createHash('sha256').update(`deployer-env\0${config.ADMIN_PASSWORD}`).digest('hex')

/**
 * Passwort beim Start. ADMIN_PASSWORD aus .env gilt beim ersten Start und
 * immer dann, wenn es sich in .env GEÄNDERT hat (Weg zurück, falls das
 * Passwort vergessen ist). Ein in der Oberfläche geändertes Passwort bleibt
 * sonst über Neustarts erhalten – vorher setzte jeder Start .env wieder durch.
 */
export async function ensureAdminPassword(): Promise<void> {
  const stored = await getSetting('admin_password_hash')
  const fp = await getSetting('admin_password_env_fp')
  if (stored && fp === envFingerprint()) return
  if (stored && fp === null && verifyPassword(config.ADMIN_PASSWORD, stored)) {
    await setSetting('admin_password_env_fp', envFingerprint())
    return
  }
  await setSetting('admin_password_hash', hashPassword(config.ADMIN_PASSWORD))
  await setSetting('admin_password_env_fp', envFingerprint())
  await setSetting('admin_password_changed', JSON.stringify({ at: new Date().toISOString(), source: 'env' }))
  log.info(stored ? 'Admin-Passwort aus der Umgebung übernommen (.env geändert)' : 'Admin-Passwort gesetzt')
}

/** Passwort ändern; alle anderen Sitzungen werden abgemeldet (keep = die eigene bleibt) */
export async function changePassword(current: string, next: string, keep: SessionRow | null = null): Promise<number> {
  const stored = await getSetting('admin_password_hash')
  if (!stored || !verifyPassword(current, stored)) throw new AppError('invalid_credentials', 'Das bisherige Passwort stimmt nicht', 400)
  if (next === current) throw new AppError('bad_request', 'Das neue Passwort ist dasselbe wie das bisherige', 400)
  await setSetting('admin_password_hash', hashPassword(next))
  await setSetting('admin_password_changed', JSON.stringify({ at: new Date().toISOString(), source: 'ui' }))
  return auth().revokeOthers(keep, 'password')
}

export async function passwordInfo(): Promise<{ changedAt: string | null; source: 'env' | 'ui' | null }> {
  const raw = await getSetting('admin_password_changed')
  if (!raw) return { changedAt: null, source: null }
  const v = JSON.parse(raw) as { at: string; source: 'env' | 'ui' }
  return { changedAt: v.at, source: v.source }
}

/**
 * Passwort noch einmal prüfen (Export des Backup-Schlüssels), mit der Sperre
 * nach Fehlversuchen des Logins.
 */
export async function login(ip: string, password: string): Promise<boolean> {
  return auth().recheckPassword(password, ip)
}

export async function sessionSecret(): Promise<string> {
  if (config.SESSION_SECRET) return config.SESSION_SECRET
  const stored = await getSetting('session_secret')
  if (stored) return stored
  const fresh = randomBytes(32).toString('hex')
  await setSetting('session_secret', fresh)
  return fresh
}

/* --- Wer fragt an ------------------------------------------------------------ */

/**
 * Adressen von Caddy: nur von dort glauben wir X-Forwarded-For (auth/client.ts).
 * Aufgelöst über den Containernamen, eine Minute gemerkt, im Hintergrund erneuert.
 */
let caddyPeers: { set: Set<string>; at: number; busy: boolean } = { set: new Set(), at: 0, busy: false }
let fixedPeers: Set<string> | null = null

function refreshCaddyPeers(): void {
  if (caddyPeers.busy || Date.now() - caddyPeers.at < 60_000) return
  caddyPeers.busy = true
  lookup(config.CADDY_CONTAINER, { all: true })
    .then((r) => { caddyPeers = { set: new Set(r.map((a) => a.address)), at: Date.now(), busy: false } })
    .catch(() => { caddyPeers = { set: new Set(), at: Date.now(), busy: false } })
}

/** Tests: vertraute Gegenstellen festlegen (null = wieder auflösen) */
export function setTrustedPeers(peers: string[] | null): void {
  fixedPeers = peers ? new Set(peers) : null
}

export function clientInfo(request: FastifyRequest): ClientInfo {
  if (!fixedPeers) refreshCaddyPeers()
  const ua = request.headers['user-agent']
  return {
    ip: clientIp(request.ip, request.headers['x-forwarded-for'], fixedPeers ?? caddyPeers.set),
    userAgent: typeof ua === 'string' ? ua : null,
  }
}

/**
 * Kam die Anfrage über HTTPS bei Caddy an? Caddy setzt X-Forwarded-Proto
 * selbst und überschreibt, was ein Client mitschickt. Ein vorgetäuschtes
 * "https" schadet nicht – es macht nur das eigene Cookie strenger (und ein
 * Passkey prüft ohnehin den Origin im Browser).
 */
export function viaHttps(request: FastifyRequest): boolean {
  const v = request.headers['x-forwarded-proto']
  return (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim() === 'https'
}

/** Passkeys auf dieser Adresse? (auth/rp.ts) */
export function passkeyHost(request: FastifyRequest): { dto: PasskeyHostDto; rp: RpContext | null; host: string | null } {
  const origin = request.headers.origin
  const r = passkeyHostFor({
    host: hostHeader(request.headers.host),
    https: viaHttps(request),
    tls: cf.tls(),
    baseDomain: cf.baseDomain(),
    label: UI_HOST_LABEL,
    dev: config.NODE_ENV === 'development',
    origin: typeof origin === 'string' ? origin : null,
  })
  return { ...r, host: r.dto.rpId }
}

export function requirePasskeyHost(request: FastifyRequest): RpContext {
  const { rp, dto } = passkeyHost(request)
  if (!rp) {
    throw new AppError('passkey_unavailable', dto.mainUrl
      ? `Passkeys gelten nur unter ${dto.mainUrl}. Hier mit Passwort und Authenticator-Code anmelden.`
      : 'Passkeys brauchen HTTPS unter dem internen Namen der Oberfläche. Hier mit Passwort und Authenticator-Code anmelden.', 400)
  }
  return rp
}

/* --- Cookies ------------------------------------------------------------------ */

const cookieBase = (request: FastifyRequest) => ({
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  // Secure, sobald über HTTPS. Über nip.io (HTTP, kein Zertifikat) bleibt der
  // Login möglich – sonst wäre der Rückfall zu.
  secure: viaHttps(request),
  signed: true,
})

export function setSessionCookie(reply: FastifyReply, request: FastifyRequest, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, { ...cookieBase(request), maxAge: SESSION_MAX_AGE_MS / 1000 })
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
}

export function setShortCookie(reply: FastifyReply, request: FastifyRequest, name: string, value: string): void {
  reply.setCookie(name, value, { ...cookieBase(request), maxAge: 5 * 60 })
}

export function clearShortCookie(reply: FastifyReply, name: string): void {
  reply.clearCookie(name, { path: '/' })
}

/** Wert eines signierten Cookies oder null */
export function signedCookie(request: FastifyRequest, name: string): string | null {
  const raw = request.cookies[name]
  if (!raw) return null
  const r = request.unsignCookie(raw)
  return r.valid && r.value ? r.value : null
}

/** Sitzung zur Anfrage (null = nicht angemeldet). Merkt sie sich an der Anfrage. */
export async function currentSession(request: FastifyRequest): Promise<SessionRow | null> {
  if (request.authSession !== undefined && request.authSession !== null) return request.authSession
  const s = await auth().resolveSession(signedCookie(request, SESSION_COOKIE), clientInfo(request).ip)
  request.authSession = s
  return s
}

/** Sitzung oder 401 (für Routen, die nur mit Anmeldung gehen) */
export function sessionOf(request: FastifyRequest): SessionRow {
  if (!request.authSession) throw unauthorized()
  return request.authSession
}

/**
 * Erneute Bestätigung verlangen (sudo, 10 Min.) – nur für Anmeldungen in der
 * Oberfläche. API-Tokens und MCP bleiben, wie sie sind (Auftrag); was dort
 * heikel ist, hat eigene Bestätigungen bzw. ist für Tokens ganz gesperrt.
 */
export function requireSudo(request: FastifyRequest): void {
  if (request.tokenId) return
  auth().requireSudo(sessionOf(request))
}

/**
 * Heikle Aktionen: nur nach erneuter Bestätigung. Entschieden am
 * Routenmuster wie der Wächter selbst. Dazu kommen die Änderungen am zweiten
 * Faktor (auth/service.ts prüft selbst) und «öffentlich schalten» über
 * PUT /projects/:id/routes (prüft der Handler, nur wenn es neu öffentlich wird).
 */
export const SUDO_ROUTES: readonly string[] = [
  'POST /api/v1/projects/:id/public',
  'POST /api/v1/projects/:id/public/resume',
  'POST /api/v1/projects/:id/public/request/approve',
  'DELETE /api/v1/projects/:id',
  'POST /api/v1/tokens',
  'POST /api/v1/environments/:env/tokens',
  'POST /api/v1/system/backup/restore',
  // Nacht 3, Etappe 2: Repo-Zugang entfernen und bestätigten Server-Schlüssel vergessen.
  // Ersetzen (PUT …/git-access) fragt der Handler nur, wenn es schon einen Zugang gibt.
  'DELETE /api/v1/projects/:id/git-access',
  'DELETE /api/v1/projects/:id/git-access/host-key',
  // Nacht 3, Etappe 3: verwaistes Volume löschen (darin liegen Daten; dazu Namen eintippen)
  'DELETE /api/v1/system/storage/volumes/:name',
]
const sudoRoutes = new Set(SUDO_ROUTES)

declare module 'fastify' {
  interface FastifyRequest {
    /** "ui:joel" bei Anmeldung, "token:<name>" bei API-Token (M3). */
    actor: string
    tokenId: string | null
    /** Sitzung der Oberfläche (null ohne Anmeldung oder bei API-Token) */
    authSession: SessionRow | null
  }
}

/** Ohne Anmeldung erreichbar (Routenmuster) */
export const OPEN_ROUTES = new Set([
  '/api/v1/auth/login', '/api/v1/auth/login/second-factor', '/api/v1/auth/passkey/login/options', '/api/v1/auth/passkey/login',
  '/api/v1/auth/me', '/health', '/api/v1/csp-reports/:key',
])

/**
 * Schuetzt alles unter /api/v1 ausser den ausdruecklich offenen Pfaden.
 *
 * Zwei Wege hinein: Session-Cookie (UI) oder `Authorization: Bearer dpl_…`
 * (Skripte, M3). Tokens verwalten geht nur mit Anmeldung: ein gestohlenes
 * Token könnte sich sonst ein zweites anlegen und den Widerruf überdauern.
 */
export function registerAuthGuard(app: FastifyInstance): void {
  app.decorateRequest('actor', '')
  app.decorateRequest('tokenId', null)
  app.decorateRequest('authSession', null)
  app.decorateRequest('scope', null as never)
  if (!fixedPeers) refreshCaddyPeers()
  app.addHook('onRequest', async (request) => {
    // Entschieden wird am ROUTENMUSTER, das der Router gewählt hat – nie am
    // rohen Pfad. Der Router dekodiert Prozentkodierung: "/%61pi/v1/projects"
    // landet auf "/api/v1/projects", hätte aber eine Prüfung des rohen Pfads
    // ("beginnt mit /api/") umgangen. Genau das war seit M1 möglich
    // (gefunden im Review von M3).
    const route = request.routeOptions.url
    if (!route) return // keine Route: 404 ohne Daten
    if (!route.startsWith('/api/')) return
    if (OPEN_ROUTES.has(route)) return

    const bearer = bearerFrom(request.headers.authorization)
    if (bearer) {
      const identity = await verifyToken(bearer)
      if (!identity) throw unauthorized()
      if (route.startsWith('/api/v1/tokens') || route.startsWith('/api/v1/environments/:env/tokens') || route.startsWith('/api/v1/auth/')) {
        throw new AppError('forbidden', 'Tokens lassen sich nur mit einer Anmeldung verwalten, nicht mit einem Token', 403)
      }
      // M6: ebenso die Benachrichtigungen – ein gestohlenes Token könnte sie
      // sonst auf ein fremdes ntfy oder Postfach umleiten.
      if (route.startsWith('/api/v1/notifications')) {
        throw new AppError('forbidden', 'Benachrichtigungen lassen sich nur mit einer Anmeldung einstellen', 403)
      }
      // M8: ebenso die GitHub App – ein Token könnte sie sonst auf eine fremde App umstellen
      if (route.startsWith('/api/v1/github')) {
        throw new AppError('forbidden', 'Die GitHub-Verbindung lässt sich nur mit einer Anmeldung einrichten', 403)
      }
      // Nacht 3, Etappe 2: Repo-Zugänge (Deploy-Key, Token, Server-Schlüssel) nur mit Anmeldung –
      // ein Token könnte sonst einen eigenen Schlüssel unterschieben oder einen fremden Server bestätigen
      if (route.startsWith('/api/v1/git/') || route.startsWith('/api/v1/projects/:id/git-access')) {
        throw new AppError('forbidden', 'Repo-Zugänge lassen sich nur mit einer Anmeldung verwalten, nicht mit einem API-Token', 403)
      }
      // M9: hosts-Block nennt die Namen aller Umgebungen – nur mit Anmeldung
      if (route.startsWith('/api/v1/system/hosts')) {
        throw new AppError('forbidden', 'Die hosts-Datei gibt es nur mit einer Anmeldung, nicht mit einem Token', 403)
      }
      // M9: Umgebungen verwalten (anlegen, ändern, Vorlagen, Cloudflare je Umgebung) nur mit
      // Anmeldung. Ein Token liest seine Umgebung und legt darin Projekte und externe Ziele an.
      if (route.startsWith('/api/v1/environments/:env/cloudflare')) {
        throw new AppError('forbidden', 'Cloudflare lässt sich nur mit einer Anmeldung einrichten, nicht mit einem API-Token', 403)
      }
      const envWriteAllowed = route === '/api/v1/environments/:env/projects' || route === '/api/v1/environments/:env/external-targets'
      if (route.startsWith('/api/v1/environments') && request.method !== 'GET' && !envWriteAllowed) {
        throw new AppError('forbidden', 'Umgebungen lassen sich nur mit einer Anmeldung verwalten', 403)
      }
      // Backup: Ziel, Zugangsdaten, Läufe – auch lesen nur mit Anmeldung. Ein Token könnte
      // das Ziel sonst auf einen fremden Speicher umstellen und alle Daten abziehen.
      if (route.startsWith('/api/v1/system/backup')) {
        throw new AppError('forbidden', 'Das Backup lässt sich nur mit einer Anmeldung einrichten und auslösen, nicht mit einem API-Token', 403)
      }
      // Nacht 3, Etappe 3: Speicher – die Liste nennt Volumes und Projekte aller Umgebungen,
      // Aufräumen und Volumes löschen nur mit Anmeldung. MCP liest Summen (get_disk_usage).
      if (route.startsWith('/api/v1/system/storage')) {
        throw new AppError('forbidden', 'Speicher und Aufräumen gibt es nur mit einer Anmeldung, nicht mit einem API-Token (MCP: get_disk_usage)', 403)
      }
      // Etappe 3: Städte-Datenbank laden/entfernen (Download bei DB-IP) nur mit Anmeldung
      if (route.startsWith('/api/v1/system/traffic') && request.method !== 'GET') {
        throw new AppError('forbidden', 'Die Städte-Datenbank lässt sich nur mit einer Anmeldung laden oder entfernen', 403)
      }
      // Cloudflare verbinden: Token, Tunnel, Zertifikat – auch lesen nur mit Anmeldung.
      if (route.startsWith('/api/v1/system/cloudflare')) {
        throw new AppError('forbidden', 'Cloudflare lässt sich nur mit einer Anmeldung einrichten, nicht mit einem API-Token', 403)
      }
      // M4/M5: DNS bei Cloudflare ändern nur mit Anmeldung.
      if (route.startsWith('/api/v1/system/tailnet-dns') || ((route.startsWith('/api/v1/domains') || route.startsWith('/api/v1/environments/:env/domains')) && request.method !== 'GET')) {
        throw new AppError('forbidden', 'DNS bei Cloudflare lässt sich nur mit einer Anmeldung ändern', 403)
      }
      request.actor = `token:${identity.name}`
      request.tokenId = identity.id
      // M9: ein Token sieht nur seine Umgebung
      request.scope = inEnvironment(identity.environmentId)
      return
    }
    const session = await currentSession(request)
    if (!session) throw unauthorized()
    request.actor = 'ui:joel'
    request.scope = sessionScope()
    // Etappe 1 (Nacht 3): heikle Aktionen nur nach erneuter Bestätigung
    if (sudoRoutes.has(`${request.method} ${route}`)) auth().requireSudo(session)
  })
}

export const actorFor = (request: FastifyRequest): string => request.actor || 'ui:joel'

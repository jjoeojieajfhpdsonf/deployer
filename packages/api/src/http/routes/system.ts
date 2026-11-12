import type { FastifyInstance, FastifyRequest } from 'fastify'
import { listScopeFor } from '../scope.js'
import { statfs, readFile } from 'node:fs/promises'
import { cpus, totalmem, freemem } from 'node:os'
import { scanQueueLength } from '../../security/scan.js'
import { asc, ne } from 'drizzle-orm'
import { db, schema, pool } from '../../db/index.js'
import { cf, config, net, nipioEnabled, nipioHost, primaryHost, urlForHost } from '../../config.js'
import { networkState, checkNetwork } from '../../domain/network.js'
import { currentCert, certProblemNow } from '../../jobs/cert.js'
import { daysLeftOf } from '../../lib/cert.js'
import { ensureTailnetDns, tailnetDnsConfigured } from '../../domain/tailnet.js'
import { listDomains, syncDomains, setDefaultDomain, reconcileTunnel, tunnelStatus, publicEnabled } from '../../domain/public.js'
import { z } from 'zod'
import { CloudflareError } from '../../drivers/cloudflare.js'
import { actorFor } from '../auth.js'
import { badRequest, AppError } from '../../lib/errors.js'
import { redactDeep } from '../../lib/redact.js'
import { assessClientIps, parseAccessLog } from '../../lib/client-ips.js'
import { dockerBlockState } from '../../traffic/service.js'
import * as docker from '../../drivers/docker.js'
import * as caddy from '../../drivers/caddy.js'
import { listAudit } from '../../domain/audit.js'
import { expiryInfo, setChatExpiryDays } from '../../domain/expiry-settings.js'
import type { SystemStatusDto } from '@airlock/shared'
import { cfTokenSchema, cfDomainsSchema, UI_HOST_LABEL, PRODUCT_NAME } from '@airlock/shared'
import {
  cloudflareStatus, checkToken, saveToken, saveDomains, setupTunnel, skipTunnel, restartTunnel, updateCloudflared, startTls, disconnect,
  withCloudflareEnv,
} from '../../domain/cloudflare-settings.js'
import { resolveEnv } from '../../domain/environment-admin.js'

async function check(name: string, fn: () => Promise<string>): Promise<{ name: string; ok: boolean; detail: string }> {
  try {
    return { name, ok: true, detail: await fn() }
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message }
  }
}

/**
 * Kopierfertiger Block fuer /etc/hosts. Ohne Wildcards: eine Zeile, alle Namen.
 * Nur sinnvoll mit Basisdomain - ohne sie sind die Adressen nip.io-Namen, die
 * sich ohnehin selbst aufloesen. Dann gibt es keinen Block.
 */
export async function hostsBlock(): Promise<string | null> {
  if (!cf.baseDomain()) return null
  // Tailscale ist die Hauptadresse: dieselbe IP gilt im LAN und unterwegs (mit Tailscale)
  const ip = net.tailscaleIp() ?? net.lanIp()
  const rows = await db.select({ hostname: schema.routes.hostname }).from(schema.routes).where(ne(schema.routes.target, 'public')).orderBy(asc(schema.routes.hostname))
  // Ohne Doppel (LAN und Tailnet teilen sich den Namen), ohne öffentliche Namen.
  const names = [...new Set([primaryHost(UI_HOST_LABEL), ...rows.map((r) => r.hostname)])]
  if (!ip) {
    return [
      '# Keine IP des Servers bekannt (weder Tailnet noch LAN).',
      '# Tailscale einrichten, siehe docs/INSTALL.md.',
      `# <IP-des-Servers>  ${names.join(' ')}`,
    ].join('\n')
  }
  return `${ip}  ${names.join(' ')}`
}

/**
 * Auslastung des Rechners, auf dem der Container läuft. Auf Linux teilt der
 * Container Kernel und /proc mit dem Server – die Werte sind die des Servers.
 * Unter Docker Desktop sind es die der VM.
 */
async function memoryUsage(): Promise<{ used: number; total: number } | null> {
  try {
    const info = await readFile('/proc/meminfo', 'utf8')
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? NaN) * 1024
    const total = kb('MemTotal')
    const avail = kb('MemAvailable')
    if (Number.isFinite(total) && Number.isFinite(avail)) return { used: total - avail, total }
  } catch {
    /* kein /proc (Entwicklung auf dem Mac) */
  }
  return { used: totalmem() - freemem(), total: totalmem() }
}

/** CPU über ein kurzes Messfenster (200 ms), ohne Bibliothek. */
async function cpuPercent(): Promise<number | null> {
  const sample = () => cpus().reduce((a, c) => {
    const t = c.times
    a.idle += t.idle
    a.total += t.user + t.nice + t.sys + t.idle + t.irq
    return a
  }, { idle: 0, total: 0 })
  const a = sample()
  await new Promise((r) => setTimeout(r, 200))
  const b = sample()
  const total = b.total - a.total
  if (total <= 0) return null
  return Math.round((1 - (b.idle - a.idle) / total) * 100)
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  /** Projektseite: Frist der Chat-Projekte (Tage ohne Änderung bis zum Stopp) */
  app.get('/system/expiry', async () => expiryInfo())
  app.put('/system/expiry', async (request) => {
    const { days } = z.object({ days: z.number() }).parse(request.body ?? {})
    return setChatExpiryDays(days, actorFor(request))
  })

  app.get('/system/status', async (): Promise<SystemStatusDto> => {
    const checks = await Promise.all([
      check('Datenbank', async () => {
        await pool.query('SELECT 1')
        return 'erreichbar'
      }),
      check('Docker', async () => `API ${await docker.version()}`),
      check('Caddy', async () => {
        await caddy.ping()
        return `Admin über ${config.CADDY_ADMIN_SOCKET}`
      }),
      check('Caddy-Admin nur über Unix-Socket', async () => {
        await caddy.assertAdminOnUnixSocket()
        return 'kein TCP :2019'
      }),
    ])

    let diskFreeBytes: number | null = null
    let diskTotalBytes: number | null = null
    try {
      const s = await statfs(config.DATA_DIR)
      diskFreeBytes = Number(s.bavail) * Number(s.bsize)
      diskTotalBytes = Number(s.blocks) * Number(s.bsize)
    } catch {
      diskFreeBytes = null
    }
    const mem = await memoryUsage()

    const base = cf.baseDomain()
    const nip = nipioHost(UI_HOST_LABEL)
    const cert = await currentCert().catch(() => null)

    // Welche Absender sieht Caddy bei Anfragen auf Airlock? (Zugriffs-Log, 30 Minuten)
    const clientIps = await (async () => {
      try {
        const since = Date.now() - 30 * 60_000
        const [logs, gateways] = await Promise.all([docker.getLogs(config.CADDY_CONTAINER, { tail: 2000, since: Math.floor(since / 1000) }), docker.bridgeGateways()])
        return assessClientIps(parseAccessLog(logs, since), gateways, since)
      } catch {
        return null
      }
    })()

    // Prüfungen und Zertifikatsfehler stammen aus fremden Meldungen (Caddy, Cloudflare)
    return redactDeep<SystemStatusDto>({
      clientIps,
      // Zugriffe neu: Abweisungen aus dem Docker-Netz auf Projekt-Routen (letzte Stunde, > 3)
      dockerBlocks: dockerBlockState(),
      version: config.version,
      checks,
      diskFreeBytes,
      ipFilterEnabled: config.CADDY_IP_FILTER,
      baseDomain: cf.baseDomain(),
      serverLanIp: net.lanIp(),
      network: (() => {
        const n = networkState()
        return { mode: n.mode, checkedAt: n.checkedAt, lanIp: net.lanIp(), lanCidr: net.lanCidr(), lanDev: n.lanDev, tailscaleIp: net.tailscaleIp(), tailscaleSource: cf.tailscaleIp() ? 'eingetragen' as const : n.tailscaleIp ? 'erkannt' as const : null, detectedTailscaleIp: n.tailscaleIp }
      })(),
      nipioEnabled: nipioEnabled(),
      hostsBlock: await hostsBlock(),
      server: {
        name: config.SERVER_NAME || PRODUCT_NAME,
        cpuPercent: await cpuPercent(),
        memUsedBytes: mem?.used ?? null,
        memTotalBytes: mem?.total ?? null,
        diskUsedBytes: diskTotalBytes !== null && diskFreeBytes !== null ? diskTotalBytes - diskFreeBytes : null,
        diskTotalBytes,
      },
      scanQueue: scanQueueLength(),
      tls: {
        mode: cf.tls() ? 'cloudflare' : 'off',
        acmeCa: cf.acmeCa(),
        cert: cert ? { ...cert, daysLeft: daysLeftOf(cert), problem: certProblemNow(cert) } : null,
        tailscaleIp: cf.tailscaleIp(),
      },
      publicTunnel: await (async () => {
        const t = await tunnelStatus()
        return t ? { configured: true, status: t.status, connections: t.connections } : { configured: false, status: null, connections: 0 }
      })(),
      // Geprueft wird im Browser, nicht auf dem Server: die Frage ist, ob
      // DIESES Geraet den Namen aufloest. Eine Aufloesung auf dem Server
      // beantwortet sie nicht.
      reachability: [
        base
          ? { way: 'dns', label: `Interner Name (${UI_HOST_LABEL}.${base})`, url: `${urlForHost(`${UI_HOST_LABEL}.${base}`)}/health` }
          : { way: 'dns', label: 'Interner Name (keine Basisdomain gesetzt)', url: null },
        { way: 'nipio', label: nip ? `nip.io (${nip})` : 'nip.io (keine IP des Servers bekannt)', url: nip ? `http://${nip}/health` : null },
      ],
    })
  })

  // M4: Tailnet-Eintrag bei Cloudflare von Hand anstossen (nur mit Anmeldung, siehe auth.ts).
  app.post('/system/tailnet-dns', async (request) => {
    if (!(await tailnetDnsConfigured())) {
      throw badRequest('Tailnet-DNS braucht eine Umgebung mit Basisdomain und Cloudflare-Token sowie die Tailnet-IP')
    }
    try {
      // M9: ein Eintrag je Umgebung; «record» bleibt der der Standard-Umgebung (erste)
      const records = await ensureTailnetDns(actorFor(request))
      return { record: records[0] ?? null, records }
    } catch (err) {
      if (err instanceof CloudflareError) throw new AppError('cloudflare', err.message, err.status >= 400 && err.status < 500 ? 400 : 502)
      throw err
    }
  })

  /** Netz des Servers sofort neu lesen (sonst stündlich). */
  app.post('/system/network/check', async (request) => {
    const changed = await checkNetwork(actorFor(request))
    return { changed, network: networkState() }
  })

  /* --- Cloudflare verbinden (nur mit Anmeldung, siehe auth.ts) ------------------ */

  /*
   * M9: dieselben Schritte je Umgebung unter /environments/:env/cloudflare;
   * /system/cloudflare bleibt für die Standard-Umgebung (alte Oberfläche,
   * Skripte). Beide nur mit Anmeldung (auth.ts).
   */
  const cfRoutes = (prefix: string, envOf: (r: FastifyRequest) => string | null) => {
    const inEnv = <T>(r: FastifyRequest, fn: () => Promise<T>): Promise<T> => {
      const envId = envOf(r)
      return envId ? withCloudflareEnv(envId, fn) : fn()
    }
    app.get(prefix, async (r) => inEnv(r, cloudflareStatus))
    // Nur prüfen, nichts speichern (Schritt 2 sofort beim Einfügen)
    app.post(`${prefix}/check`, async (r) => {
      const { token } = cfTokenSchema.parse(r.body)
      return { check: await checkToken(token) }
    })
    app.put(`${prefix}/token`, async (r) => inEnv(r, async () => {
      const { token } = cfTokenSchema.parse(r.body)
      return { check: await saveToken(token, actorFor(r)), status: await cloudflareStatus() }
    }))
    app.put(`${prefix}/domains`, async (r) => inEnv(r, async () => {
      await saveDomains(cfDomainsSchema.parse(r.body), actorFor(r))
      return cloudflareStatus()
    }))
    const step = (path: string, fn: (actor: string) => Promise<void>) =>
      app.post(`${prefix}${path}`, async (r) => inEnv(r, async () => {
        await fn(actorFor(r))
        return cloudflareStatus()
      }))
    step('/tunnel', setupTunnel)
    step('/tunnel/skip', skipTunnel)
    step('/tunnel/restart', restartTunnel)
    step('/tunnel/update', updateCloudflared)
    step('/tls', startTls)
    app.delete(prefix, async (r) => inEnv(r, async () => {
      await disconnect(actorFor(r))
      return cloudflareStatus()
    }))
  }
  cfRoutes('/system/cloudflare', () => null)
  cfRoutes('/environments/:env/cloudflare', (r) => resolveEnv((r.params as { env: string }).env).id)

  /* --- M5: Domains und Cloudflare --------------------------------------------- */

  // M9: Zonen der Umgebung (Pfad /environments/:env/domains oder ?environment=)
  const listZones = async (request: FastifyRequest) => {
    const scope = listScopeFor(request)
    return { domains: await listDomains(scope), publicEnabled: publicEnabled(scope.envId) }
  }
  app.get('/domains', listZones)
  app.get('/environments/:env/domains', listZones)

  const sync = async (request: FastifyRequest) => {
    const scope = listScopeFor(request)
    return { domains: await syncDomains(undefined, scope.envId) }
  }
  app.post('/domains/sync', sync)
  app.post('/environments/:env/domains/sync', sync)

  const setDefault = async (request: FastifyRequest) => {
    const scope = listScopeFor(request)
    const { name } = z.object({ name: z.string().min(3).max(253) }).parse(request.body)
    return { domains: await setDefaultDomain(scope, name, actorFor(request)) }
  }
  app.put('/domains/default', setDefault)
  app.put('/environments/:env/domains/default', setDefault)

  // Tunnel-Ingress aus der Datenbank neu setzen (nur mit Anmeldung, siehe auth.ts).
  app.post('/system/cloudflare-sync', async () => {
    await syncDomains()
    return { tunnel: await reconcileTunnel() }
  })

  app.get('/system/hosts', async (_request, reply) => {
    reply.type('text/plain; charset=utf-8')
    return (
      (await hostsBlock()) ??
      '# Keine Basisdomain gesetzt: die Adressen sind nip.io-Namen und lösen sich selbst auf.\n'
    )
  })

  // M9: Einträge der Umgebung plus Server-Ereignisse
  type AuditQuery = { limit?: string; before?: string; action?: string; targetId?: string }
  const auditList = async (request: FastifyRequest) => {
    const q = request.query as AuditQuery
    return {
      events: await listAudit(listScopeFor(request), {
        limit: q.limit ? Number(q.limit) : undefined,
        before: q.before,
        action: q.action,
        targetId: q.targetId,
      }),
    }
  }
  app.get('/audit', auditList)
  app.get('/environments/:env/audit', auditList)
}

import type { FastifyInstance } from 'fastify'
import { statfs, readFile } from 'node:fs/promises'
import { cpus, totalmem, freemem } from 'node:os'
import { scanQueueLength } from '../../security/scan.js'
import { asc, ne } from 'drizzle-orm'
import { db, schema, pool } from '../../db/index.js'
import { config, nipioEnabled, nipioHost, primaryHost, urlForHost } from '../../config.js'
import { currentCert, certProblemNow } from '../../jobs/cert.js'
import { daysLeftOf } from '../../lib/cert.js'
import { ensureTailnetDns, tailnetDnsConfigured } from '../../domain/tailnet.js'
import { listDomains, syncDomains, setDefaultDomain, reconcileTunnel, tunnelStatus, publicEnabled } from '../../domain/public.js'
import { z } from 'zod'
import { CloudflareError } from '../../drivers/cloudflare.js'
import { actorFor } from '../auth.js'
import { badRequest, AppError } from '../../lib/errors.js'
import * as docker from '../../drivers/docker.js'
import * as caddy from '../../drivers/caddy.js'
import { listAudit } from '../../domain/audit.js'
import type { SystemStatusDto } from '@deployer/shared'

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
  if (!config.INTERNAL_BASE_DOMAIN) return null
  const ip = config.SERVER_LAN_IP
  const rows = await db.select({ hostname: schema.routes.hostname }).from(schema.routes).where(ne(schema.routes.target, 'public')).orderBy(asc(schema.routes.hostname))
  // Ohne Doppel (LAN und Tailnet teilen sich den Namen), ohne öffentliche Namen.
  const names = [...new Set([primaryHost('deployer'), ...rows.map((r) => r.hostname)])]
  if (!ip) {
    return [
      '# SERVER_LAN_IP ist nicht gesetzt.',
      '# Auf dem Server "pnpm ip" ausführen und den Wert in .env eintragen.',
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

    const base = config.INTERNAL_BASE_DOMAIN
    const nip = nipioHost('deployer')
    const cert = await currentCert().catch(() => null)

    return {
      version: config.version,
      checks,
      diskFreeBytes,
      ipFilterEnabled: config.CADDY_IP_FILTER,
      baseDomain: config.INTERNAL_BASE_DOMAIN,
      serverLanIp: config.SERVER_LAN_IP,
      nipioEnabled,
      hostsBlock: await hostsBlock(),
      server: {
        name: config.SERVER_NAME || 'deployer',
        cpuPercent: await cpuPercent(),
        memUsedBytes: mem?.used ?? null,
        memTotalBytes: mem?.total ?? null,
        diskUsedBytes: diskTotalBytes !== null && diskFreeBytes !== null ? diskTotalBytes - diskFreeBytes : null,
        diskTotalBytes,
      },
      scanQueue: scanQueueLength(),
      tls: {
        mode: config.TLS_MODE,
        acmeCa: config.ACME_CA,
        cert: cert ? { ...cert, daysLeft: daysLeftOf(cert), problem: certProblemNow(cert) } : null,
        tailscaleIp: config.TAILSCALE_IP,
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
          ? { way: 'dns', label: `Interner Name (deployer.${base})`, url: `${urlForHost(`deployer.${base}`)}/health` }
          : { way: 'dns', label: 'Interner Name (keine Basisdomain gesetzt)', url: null },
        { way: 'nipio', label: nip ? `nip.io (${nip})` : 'nip.io (SERVER_LAN_IP fehlt)', url: nip ? `http://${nip}/health` : null },
      ],
    }
  })

  // M4: Tailnet-Eintrag bei Cloudflare von Hand anstossen (nur mit Anmeldung, siehe auth.ts).
  app.post('/system/tailnet-dns', async (request) => {
    if (!tailnetDnsConfigured()) {
      throw badRequest('Tailnet-DNS braucht TLS_MODE=cloudflare, INTERNAL_BASE_DOMAIN und TAILSCALE_IP')
    }
    try {
      return { record: await ensureTailnetDns(actorFor(request)) }
    } catch (err) {
      if (err instanceof CloudflareError) throw new AppError('cloudflare', err.message, err.status >= 400 && err.status < 500 ? 400 : 502)
      throw err
    }
  })

  /* --- M5: Domains und Cloudflare --------------------------------------------- */

  app.get('/domains', async () => ({ domains: await listDomains(), publicEnabled: publicEnabled() }))

  app.post('/domains/sync', async () => ({ domains: await syncDomains() }))

  app.put('/domains/default', async (request) => {
    const { name } = z.object({ name: z.string().min(3).max(253) }).parse(request.body)
    return { domains: await setDefaultDomain(name, actorFor(request)) }
  })

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

  app.get<{ Querystring: { limit?: string; before?: string; action?: string } }>(
    '/audit',
    async (request) => ({
      events: await listAudit({
        limit: request.query.limit ? Number(request.query.limit) : undefined,
        before: request.query.before,
        action: request.query.action,
      }),
    }),
  )
}

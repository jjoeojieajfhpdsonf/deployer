import type { FastifyInstance } from 'fastify'
import { statfs } from 'node:fs/promises'
import { asc } from 'drizzle-orm'
import { db, schema, pool } from '../../db/index.js'
import { config, nipioEnabled, nipioHost, primaryHost } from '../../config.js'
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
  const rows = await db.select({ hostname: schema.routes.hostname }).from(schema.routes).orderBy(asc(schema.routes.hostname))
  const names = [primaryHost('deployer'), ...rows.map((r) => r.hostname)]
  if (!ip) {
    return [
      '# SERVER_LAN_IP ist nicht gesetzt.',
      '# Auf dem Server "pnpm ip" ausführen und den Wert in .env eintragen.',
      `# <IP-des-Servers>  ${names.join(' ')}`,
    ].join('\n')
  }
  return `${ip}  ${names.join(' ')}`
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
    try {
      const s = await statfs(config.DATA_DIR)
      diskFreeBytes = Number(s.bavail) * Number(s.bsize)
    } catch {
      diskFreeBytes = null
    }

    const base = config.INTERNAL_BASE_DOMAIN
    const nip = nipioHost('deployer')

    return {
      version: config.version,
      checks,
      diskFreeBytes,
      ipFilterEnabled: config.CADDY_IP_FILTER,
      baseDomain: config.INTERNAL_BASE_DOMAIN,
      serverLanIp: config.SERVER_LAN_IP,
      nipioEnabled,
      hostsBlock: await hostsBlock(),
      // Geprueft wird im Browser, nicht auf dem Server: die Frage ist, ob
      // DIESES Geraet den Namen aufloest. Eine Aufloesung auf dem Server
      // beantwortet sie nicht.
      reachability: [
        base
          ? { way: 'dns', label: `Interner Name (deployer.${base})`, url: `http://deployer.${base}/health` }
          : { way: 'dns', label: 'Interner Name (keine Basisdomain gesetzt)', url: null },
        { way: 'nipio', label: nip ? `nip.io (${nip})` : 'nip.io (SERVER_LAN_IP fehlt)', url: nip ? `http://${nip}/health` : null },
      ],
    }
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

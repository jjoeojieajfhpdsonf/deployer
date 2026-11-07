import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { bearerFrom } from '../lib/tokens.js'
import { verifyToken } from '../domain/tokens.js'
import { createMcpServer } from './server.js'
import { log } from '../lib/log.js'

/**
 * MCP über Streamable HTTP unter /mcp.
 *
 * - Jeder einzelne Aufruf prüft das Bearer-Token erneut. Ein widerrufenes
 *   Token beendet damit auch eine offene Sitzung beim nächsten Aufruf.
 * - Eine Sitzung gehört dem Token, das sie eröffnet hat. Ein anderes Token
 *   kann sie nicht weiterbenutzen, auch wenn es die Sitzungs-ID kennt.
 * - Unbenutzte Sitzungen verfallen nach einer Stunde.
 */

interface Session {
  transport: StreamableHTTPServerTransport
  server: McpServer
  tokenId: string
  lastSeen: number
}

const SESSION_IDLE_MS = 60 * 60_000
/** 20 MB Dateien pro Aufruf, als Base64 rund 27 MB, plus JSON drumherum. */
const MCP_BODY_LIMIT = 32 * 1024 * 1024

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  const sessions = new Map<string, Session>()

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > SESSION_IDLE_MS) {
        sessions.delete(id)
        void s.transport.close().catch(() => {})
      }
    }
  }, 10 * 60_000)
  sweep.unref()
  app.addHook('onClose', async () => {
    clearInterval(sweep)
    for (const s of sessions.values()) await s.transport.close().catch(() => {})
  })

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    bodyLimit: MCP_BODY_LIMIT,
    handler: async (request, reply) => {
      const identity = await verifyToken(bearerFrom(request.headers.authorization) ?? '')
      if (!identity) {
        reply.code(401).header('www-authenticate', 'Bearer realm="deployer"').send({
          jsonrpc: '2.0', error: { code: -32001, message: 'Gültiges API-Token nötig (Authorization: Bearer dpl_…)' }, id: null,
        })
        return reply
      }

      const sid = request.headers['mcp-session-id']
      let session: Session | undefined

      if (typeof sid === 'string' && sid) {
        session = sessions.get(sid)
        if (!session) {
          reply.code(404).send({ jsonrpc: '2.0', error: { code: -32001, message: 'Sitzung unbekannt oder abgelaufen' }, id: null })
          return reply
        }
        if (session.tokenId !== identity.id) {
          log.warn('MCP-Sitzung mit fremdem Token benutzt', { token: identity.name })
          reply.code(403).send({ jsonrpc: '2.0', error: { code: -32001, message: 'Diese Sitzung gehört einem anderen Token' }, id: null })
          return reply
        }
      } else {
        if (request.method !== 'POST' || !isInitializeRequest(request.body)) {
          reply.code(400).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Erst initialisieren (ohne Mcp-Session-Id)' }, id: null })
          return reply
        }
        const server = createMcpServer(identity)
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server, tokenId: identity.id, lastSeen: Date.now() })
          },
        })
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId)
        }
        await server.connect(transport)
        session = { transport, server, tokenId: identity.id, lastSeen: Date.now() }
      }

      session.lastSeen = Date.now()
      reply.hijack()
      await session.transport.handleRequest(request.raw, reply.raw, request.body)
      return reply
    },
  })
}

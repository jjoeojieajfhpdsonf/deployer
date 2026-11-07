import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { ZodError } from 'zod'
import { existsSync } from 'node:fs'
import { config } from '../config.js'
import { AppError } from '../lib/errors.js'
import { registerAuthGuard, sessionSecret } from './auth.js'
import { authRoutes } from './routes/auth.js'
import { projectRoutes } from './routes/projects.js'
import { deploymentRoutes } from './routes/deployments.js'
import { systemRoutes } from './routes/system.js'
import { uploadRoutes } from './routes/uploads.js'
import { tokenRoutes } from './routes/tokens.js'
import { securityRoutes } from './routes/security.js'
import { mcpRoutes } from '../mcp/http.js'
import { DEFAULT_LIMITS } from '../lib/unzip.js'

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
  })

  await app.register(cookie, { secret: await sessionSecret() })
  await app.register(multipart, { limits: { fileSize: DEFAULT_LIMITS.maxArchiveBytes, files: 1 } })

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      reply.code(400).send({
        error: {
          code: 'bad_request',
          // Die erste Meldung als Text; alle mit Pfad in details – das Formular
          // zeigt sie unter dem jeweiligen Feld (gleiche Regeln wie im Browser).
          message: err.issues[0]?.message ?? 'Eingabe nicht gültig',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      })
      return
    }
    if (err instanceof AppError) {
      reply.code(err.status).send({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      })
      return
    }
    // Multipart-Grenzen und andere Fastify-Fehler mit eigenem Status.
    const fastifyErr = err as { statusCode?: number; message?: string }
    const status = fastifyErr.statusCode
    if (status && status < 500) {
      reply
        .code(status)
        .send({ error: { code: 'bad_request', message: fastifyErr.message ?? 'Eingabe nicht gültig' } })
      return
    }
    request.log.error({ err }, 'Unbehandelter Fehler')
    reply.code(500).send({ error: { code: 'internal', message: 'Interner Fehler' } })
  })

  /**
   * /health ist offen und erlaubt CORS: die System-Ansicht prueft damit aus
   * dem Browser, welcher der Erreichbarkeitswege auf DIESEM Geraet
   * funktioniert. Ohne CORS waere die Antwort opak und nicht auswertbar.
   */
  app.get('/health', async (_request, reply) => {
    reply.header('access-control-allow-origin', '*')
    return { ok: true, version: config.version }
  })

  registerAuthGuard(app)

  // M3: MCP mit eigener Token-Prüfung, ausserhalb von /api/v1.
  await app.register(mcpRoutes)

  await app.register(
    async (api) => {
      await api.register(authRoutes)
      await api.register(tokenRoutes)
      await api.register(securityRoutes)
      await api.register(projectRoutes)
      await api.register(deploymentRoutes)
      await api.register(systemRoutes)
      await api.register(uploadRoutes)
    },
    { prefix: '/api/v1' },
  )

  const webDist = config.WEB_DIST
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' })
    // SPA: alles, was keine API ist, bekommt die index.html.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.code(404).send({ error: { code: 'not_found', message: 'Unbekannter Endpunkt' } })
        return
      }
      reply.sendFile('index.html')
    })
  } else {
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'not_found', message: 'Unbekannter Endpunkt' } })
    })
  }

  return app
}

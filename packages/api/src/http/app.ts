import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { ZodError } from 'zod'
import { existsSync } from 'node:fs'
import { config } from '../config.js'
import { AppError } from '../lib/errors.js'
import { registerAuthGuard, sessionSecret } from './auth.js'
import { registerScopeGuard } from './scope.js'
import { environmentRoutes } from './routes/environments.js'
import { authRoutes } from './routes/auth.js'
import { projectRoutes } from './routes/projects.js'
import { deploymentRoutes } from './routes/deployments.js'
import { eventRoutes } from './routes/events.js'
import { systemRoutes } from './routes/system.js'
import { backupRoutes } from './routes/backup.js'
import { clientErrorRoutes } from './routes/client-errors.js'
import { uploadRoutes } from './routes/uploads.js'
import { tokenRoutes } from './routes/tokens.js'
import { securityRoutes } from './routes/security.js'
import { fixRoutes, cspReportRoutes } from './routes/fix.js'
import { githubRoutes } from './routes/github.js'
import { mcpRoutes } from '../mcp/http.js'
import { DEFAULT_LIMITS } from '../lib/unzip.js'
import { redactSecrets, redactDeep } from '../lib/redact.js'
import { requestLogLevel, isStreamRoute } from '../lib/request-log.js'
import { closeAllStreams } from '../lib/events.js'

/**
 * Leerer Body mit Content-Type application/json gilt als {} statt als Fehler
 * (Fastify lehnt ihn sonst mit FST_ERR_CTP_EMPTY_JSON_BODY ab). Gilt für alle
 * Endpunkte, auch für API-Clients, die den Header immer mitschicken. Nicht
 * leere Bodies gehen weiter durch Fastifys Parser (Schutz vor __proto__).
 */
export function acceptEmptyJson(app: FastifyInstance): void {
  const defaultJson = app.getDefaultJsonParser('error', 'ignore')
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, raw, done) => {
    if ((raw as string).trim() === '') return done(null, {})
    defaultJson(req, raw as string, done)
  })
}

/** Fehler fürs Fastify-Log, mit geschwärzter Meldung und Stack. */
function serializeErr(raw: unknown): { [key: string]: unknown; type: string; message: string; stack: string } {
  const e = raw as (Error & { code?: string; statusCode?: number }) | null
  return {
    type: e?.constructor?.name ?? 'Error',
    message: redactSecrets(e?.message ?? String(raw)),
    stack: redactSecrets(e?.stack ?? ''),
    ...(e?.code ? { code: e.code } : {}),
    ...(e?.statusCode ? { statusCode: e.statusCode } : {}),
  }
}

/** Alle Routen der zuletzt gebauten App (M9: der Umgebungs-Test geht jede mit :id durch). */
export const registeredRoutes: { method: string; url: string }[] = []

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : config.NODE_ENV === 'test' ? 'warn' : 'debug',
      // Fehler von Caddy, Cloudflare und cloudflared können Tokens enthalten
      serializers: { err: serializeErr },
    },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
    // Eigene Zugriffszeile (unten): Polling auf debug, siehe request-log.ts
    disableRequestLogging: true,
  })
  registeredRoutes.length = 0
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) registeredRoutes.push({ method: String(m), url: r.url })
  })

  app.addHook('onResponse', async (request, reply) => {
    const ms = reply.elapsedTime
    // Nach writeHead kennt Node den Content-Type nicht mehr: am Routenmuster entscheiden
    const level = requestLogLevel(request.method, reply.statusCode, ms, isStreamRoute(request.routeOptions.url))
    request.log[level]({ method: request.method, url: request.url.split('?')[0], status: reply.statusCode, ms: Math.round(ms) }, 'Anfrage')
  })

  // UI-Qualität 3: offene SSE-Ströme beim Herunterfahren schliessen, sonst wartet app.close() ewig
  app.addHook('preClose', async () => closeAllStreams())

  acceptEmptyJson(app)

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
        error: { code: err.code, message: redactSecrets(err.message), ...(err.details ? { details: redactDeep(err.details) } : {}) },
      })
      return
    }
    // Multipart-Grenzen und andere Fastify-Fehler mit eigenem Status.
    const fastifyErr = err as { statusCode?: number; message?: string }
    const status = fastifyErr.statusCode
    if (status && status < 500) {
      reply
        .code(status)
        .send({ error: { code: 'bad_request', message: redactSecrets(fastifyErr.message) ?? 'Eingabe nicht gültig' } })
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
  // M9: Objekte einer fremden Umgebung sind «nicht gefunden», für jeden Pfad mit :id
  registerScopeGuard(app)

  // M3: MCP mit eigener Token-Prüfung, ausserhalb von /api/v1.
  await app.register(mcpRoutes)

  await app.register(
    async (api) => {
      await api.register(authRoutes)
      await api.register(tokenRoutes)
      await api.register(securityRoutes)
      // M8: Fix-Assistent und CSP-Meldungen (eigene Parser, nur in diesem Plugin)
      await api.register(fixRoutes)
      await api.register(cspReportRoutes)
      await api.register(githubRoutes)
      await api.register(projectRoutes)
      await api.register(deploymentRoutes)
      await api.register(eventRoutes)
      await api.register(systemRoutes)
      // Meilenstein Backup (nur mit Anmeldung, siehe auth.ts)
      await api.register(backupRoutes)
      await api.register(uploadRoutes)
      await api.register(clientErrorRoutes)
      // M9: Umgebungen
      await api.register(environmentRoutes)
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

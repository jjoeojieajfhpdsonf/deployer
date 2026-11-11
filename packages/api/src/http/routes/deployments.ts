import type { FastifyInstance } from 'fastify'
import { getDeployment, toDeploymentDto } from '../../domain/deployments.js'
import { readLog, subscribe } from '../../deploy/journal.js'
import { trackStream } from '../../lib/events.js'

export async function deploymentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/deployments/:id', async (request) => {
    const row = await getDeployment(request.params.id)
    return { deployment: toDeploymentDto(row), log: readLog(row.id) }
  })

  /** Fortschritt der Pipeline als Server-Sent Events. */
  app.get<{ Params: { id: string } }>('/deployments/:id/events', async (request, reply) => {
    const row = await getDeployment(request.params.id)

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const write = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)

    // Wer spaet dazukommt, bekommt zuerst den bisherigen Inhalt, damit er den
    // Anfang des Deploys nicht verpasst.
    const backlog = readLog(row.id)
    if (backlog) {
      for (const line of backlog.split('\n')) {
        if (line.length) write({ type: 'line', line, at: row.startedAt.toISOString() })
      }
    }
    write({ type: 'status', status: row.status, at: new Date().toISOString() })

    const terminal = ['active', 'failed', 'superseded', 'rolled_back']
    if (terminal.includes(row.status)) {
      write({ type: 'done', ok: row.status === 'active', at: new Date().toISOString() })
      reply.raw.end()
      return reply
    }

    let closed = false
    const end = () => {
      if (closed) return
      closed = true
      clearInterval(keepalive)
      unsubscribe()
      untrack()
      reply.raw.end()
    }
    const unsubscribe = subscribe(row.id, (event) => {
      if (closed) return
      write(event)
      if (event.type === 'done') end()
    })
    const keepalive = setInterval(() => { if (!closed) reply.raw.write(': ping\n\n') }, 20_000)
    // UI-Qualität 3: beim Herunterfahren schliessen (sonst wartet app.close())
    const untrack = trackStream(end)
    request.raw.on('close', end)

    return reply
  })
}

import type { FastifyInstance } from 'fastify'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { db, schema } from '../../db/index.js'
import { config } from '../../config.js'
import { DEFAULT_LIMITS } from '../../lib/unzip.js'
import { badRequest } from '../../lib/errors.js'
import { audit } from '../../domain/audit.js'
import { actorFor } from '../auth.js'

/**
 * Nimmt ein ZIP entgegen und legt es ab. Entpackt wird erst im Deploy, mit
 * allen Pruefungen aus lib/unzip.ts.
 */
export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.post('/uploads', async (request, reply) => {
    const file = await request.file({ limits: { fileSize: DEFAULT_LIMITS.maxArchiveBytes } })
    if (!file) throw badRequest('Es wurde keine Datei mitgeschickt')
    if (!/\.zip$/i.test(file.filename)) throw badRequest('Nur .zip-Dateien werden angenommen')

    const id = randomUUID()
    const dir = join(config.DATA_DIR, 'uploads')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${id}.zip`)

    const hash = createHash('sha256')
    let size = 0
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length
        hash.update(chunk)
        cb(null, chunk)
      },
    })

    try {
      await pipeline(file.file, meter, createWriteStream(path))
    } catch (err) {
      await rm(path, { force: true })
      throw badRequest(`Upload fehlgeschlagen: ${(err as Error).message}`)
    }

    // fastify-multipart bricht nicht ab, sondern markiert die Ueberschreitung.
    if (file.file.truncated) {
      await rm(path, { force: true })
      throw badRequest(`Archiv ist grösser als ${DEFAULT_LIMITS.maxArchiveBytes} Bytes`)
    }

    const inserted = await db
      .insert(schema.uploads)
      .values({ id, filename: file.filename, sizeBytes: size, sha256: hash.digest('hex') })
      .returning()

    await audit({
      actor: actorFor(request), action: 'upload.create', targetType: 'upload', targetId: id,
      params: { filename: file.filename, size }, result: 'ok',
    })

    reply.code(201)
    return { upload: { id, filename: file.filename, sizeBytes: size, sha256: inserted[0]!.sha256 } }
  })
}

import tarStream from 'tar-stream'
import { createWriteStream } from 'node:fs'
import { mkdir, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform, type Readable } from 'node:stream'
import { safeJoin, DEFAULT_LIMITS, type UnzipLimits } from './unzip.js'
import { AppError } from './errors.js'

/**
 * Entpackt ein Tar mit denselben Regeln wie lib/unzip.ts: kein Pfad aus dem
 * Ziel heraus, keine Symlinks oder Hardlinks, keine Geräte, Grenzen beim
 * Entpacken mitgezählt.
 *
 * Gebraucht für die Ausgabe des Build-Containers (GET /containers/{id}/archive).
 * Deren Inhalt kommt aus einem fremden Build-Skript und ist genauso wenig
 * vertrauenswürdig wie ein hochgeladenes ZIP.
 */

const rejected = (msg: string) => new AppError('tar_rejected', msg, 400)

export interface UntarOptions {
  limits?: UnzipLimits
  /** Ersten Pfadteil abschneiden: GET /archive auf /work/dist liefert "dist/...". */
  stripFirst?: boolean
}

export async function extractTarSafely(
  input: Readable,
  destDir: string,
  opts: UntarOptions = {},
): Promise<{ files: number; bytes: number }> {
  const limits = opts.limits ?? DEFAULT_LIMITS
  await mkdir(destDir, { recursive: true, mode: 0o755 })

  let entries = 0
  let files = 0
  let bytes = 0
  const extract = tarStream.extract()

  const done = new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      void (async () => {
        entries++
        if (entries > limits.maxEntries) throw rejected(`Mehr als ${limits.maxEntries} Einträge`)

        let name = header.name.replace(/^\.\//, '')
        if (opts.stripFirst) {
          const i = name.indexOf('/')
          name = i === -1 ? '' : name.slice(i + 1)
        }

        if (header.type === 'symlink' || header.type === 'link') {
          throw rejected(`Link "${header.name}" in der Build-Ausgabe ist nicht erlaubt`)
        }
        if (header.type !== 'file' && header.type !== 'directory' && header.type !== 'contiguous-file') {
          throw rejected(`Eintrag "${header.name}" (${header.type}) ist weder Datei noch Ordner`)
        }

        // Der oberste Ordner selbst nach stripFirst.
        if (name === '' || name === '/') {
          stream.resume()
          stream.on('end', next)
          return
        }

        const target = safeJoin(destDir, name)
        if (target === null) {
          throw rejected(`Eintrag "${header.name}" zeigt aus dem Zielordner heraus`)
        }

        if (header.type === 'directory') {
          await mkdir(target, { recursive: true, mode: 0o755 })
          stream.resume()
          stream.on('end', next)
          return
        }

        if ((header.size ?? 0) > limits.maxFileBytes) {
          throw rejected(`"${header.name}" ist grösser als erlaubt`)
        }
        await mkdir(dirname(target), { recursive: true, mode: 0o755 })

        let fileBytes = 0
        const counter = new Transform({
          transform(chunk: Buffer, _e, cb) {
            fileBytes += chunk.length
            bytes += chunk.length
            if (fileBytes > limits.maxFileBytes) return cb(rejected(`"${header.name}" überschreitet ${limits.maxFileBytes} Bytes`))
            if (bytes > limits.maxTotalBytes) return cb(rejected(`Ausgabe überschreitet ${limits.maxTotalBytes} Bytes`))
            cb(null, chunk)
          },
        })
        await pipeline(stream, counter, createWriteStream(target, { mode: 0o644 }))
        await chmod(target, 0o644)
        files++
        next()
      })().catch((err) => {
        extract.destroy(err as Error)
        reject(err)
      })
    })
    extract.on('finish', () => resolve())
    extract.on('error', (err) => reject(err instanceof AppError ? err : rejected(`Tar nicht lesbar: ${err.message}`)))
  })

  input.on('error', (err) => extract.destroy(err))
  input.pipe(extract)
  await done
  return { files, bytes }
}

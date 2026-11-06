import yauzl from 'yauzl'
import { createWriteStream } from 'node:fs'
import { mkdir, chmod } from 'node:fs/promises'
import { dirname, resolve, sep, isAbsolute } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { AppError } from './errors.js'

/**
 * Entpacken ist der gefaehrlichste Teil von M1: hier bestimmen fremde Daten
 * Pfade auf dem Dateisystem.
 */

export interface UnzipLimits {
  maxArchiveBytes: number
  maxTotalBytes: number
  maxEntries: number
  maxFileBytes: number
}

export const DEFAULT_LIMITS: UnzipLimits = {
  maxArchiveBytes: 100 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
  maxEntries: 10_000,
  maxFileBytes: 50 * 1024 * 1024,
}

const rejected = (msg: string) => new AppError('zip_rejected', msg, 400)

/**
 * Loest einen Archiv-Eintragspfad gegen das Zielverzeichnis auf.
 *
 * Geprueft wird am AUFGELOESTEN Ergebnis, nicht per Textsuche nach "..".
 * Eine Textsuche laesst sich mit Kodierungen und Mischformen umgehen; der
 * aufgeloeste Pfad nicht.
 *
 * Gibt null zurueck, wenn der Eintrag aus dem Zielordner ausbrechen wuerde.
 */
export function safeJoin(destDir: string, entryName: string): string | null {
  if (entryName.length === 0) return null
  // Backslashes sind in ZIP-Namen nicht erlaubt, kommen aber vor. Wer sie
  // schickt, meint Windows-Pfade - abgelehnt statt umgedeutet.
  if (entryName.includes('\\')) return null
  if (entryName.includes('\0')) return null
  // Absolute Pfade und Laufwerksangaben.
  if (entryName.startsWith('/') || isAbsolute(entryName)) return null
  if (/^[a-zA-Z]:/.test(entryName)) return null

  const base = resolve(destDir)
  const target = resolve(base, entryName)
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

/** Unix-Dateityp aus den externen Attributen des ZIP-Eintrags. */
export function entryFileType(externalFileAttributes: number): 'file' | 'dir' | 'symlink' | 'other' {
  const mode = (externalFileAttributes >>> 16) & 0xffff
  const type = mode & 0xf000
  if (type === 0xa000) return 'symlink'
  if (type === 0x4000) return 'dir'
  // Typ-Bits 0 heisst "nicht angegeben", nicht "Sondertyp": Pythons zipfile
  // und andere Werkzeuge speichern nur Rechte (z.B. 0o600). Ordner erkennt
  // der Aufrufer zusaetzlich am abschliessenden "/".
  if (type === 0x8000 || type === 0) return 'file'
  // Geraete, FIFOs, Sockets.
  return 'other'
}

export interface UnzipResult {
  files: number
  bytes: number
}

/**
 * Entpackt ein ZIP nach destDir. destDir muss leer sein und wird angelegt.
 *
 * Die Grenzen werden WAEHREND des Entpackens mitgezaehlt, nicht vorher aus
 * dem ZIP-Verzeichnis gelesen: bei einer Zip-Bombe luegen genau diese
 * Angaben.
 */
export async function extractZipSafely(
  zipPath: string,
  destDir: string,
  limits: UnzipLimits = DEFAULT_LIMITS,
): Promise<UnzipResult> {
  const zip = await new Promise<yauzl.ZipFile>((res, rej) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, z) => {
      if (err || !z) rej(rejected(`Archiv nicht lesbar: ${err?.message ?? 'unbekannt'}`))
      else res(z)
    })
  })

  if (zip.entryCount > limits.maxEntries) {
    zip.close()
    throw rejected(`Archiv hat ${zip.entryCount} Einträge, erlaubt sind ${limits.maxEntries}`)
  }

  let files = 0
  let bytes = 0

  await mkdir(destDir, { recursive: true, mode: 0o755 })

  // yauzl prüft Namen selbst mit und wirft dann einen gewöhnlichen Error
  // ("invalid relative path", "absolute path"). Das ist willkommene doppelte
  // Absicherung, muss aber als AppError herauskommen, damit die API 400
  // antwortet und nicht 500.
  const asRejected = (err: unknown): unknown =>
    err instanceof AppError ? err : rejected(`Archiv abgelehnt: ${(err as Error).message}`)

  await new Promise<void>((res, rej) => {
    const fail = (err: unknown) => {
      zip.close()
      rej(asRejected(err))
    }

    zip.on('error', fail)
    zip.on('end', () => res())

    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        try {
          files++
          if (files > limits.maxEntries) {
            throw rejected(`Mehr als ${limits.maxEntries} Einträge im Archiv`)
          }

          const kind = entryFileType(entry.externalFileAttributes)

          // Symlinks und Hardlinks: die zweite Haelfte von Zip Slip. Ein
          // Symlink-Eintrag auf /etc und eine nachfolgende Datei "darunter"
          // schreiben am Zielordner vorbei, obwohl jeder einzelne Pfad
          // harmlos aussieht.
          if (kind === 'symlink') {
            throw rejected(`Symlink "${entry.fileName}" im Archiv ist nicht erlaubt`)
          }
          if (kind === 'other') {
            throw rejected(`Eintrag "${entry.fileName}" ist weder Datei noch Ordner`)
          }

          const target = safeJoin(destDir, entry.fileName)
          if (target === null) {
            throw rejected(
              `Eintrag "${entry.fileName}" zeigt aus dem Zielordner heraus (Zip Slip)`,
            )
          }

          if (entry.fileName.endsWith('/') || kind === 'dir') {
            await mkdir(target, { recursive: true, mode: 0o755 })
            zip.readEntry()
            return
          }

          if (entry.uncompressedSize > limits.maxFileBytes) {
            throw rejected(
              `"${entry.fileName}" ist grösser als erlaubt (${limits.maxFileBytes} Bytes)`,
            )
          }

          await mkdir(dirname(target), { recursive: true, mode: 0o755 })

          const readStream = await new Promise<NodeJS.ReadableStream>((r, j) => {
            zip.openReadStream(entry, (err, s) => (err || !s ? j(rejected(`"${entry.fileName}" nicht lesbar`)) : r(s)))
          })

          let fileBytes = 0
          const counter = new Transform({
            transform(chunk: Buffer, _enc, cb) {
              fileBytes += chunk.length
              bytes += chunk.length
              if (fileBytes > limits.maxFileBytes) {
                cb(rejected(`"${entry.fileName}" überschreitet beim Entpacken ${limits.maxFileBytes} Bytes`))
                return
              }
              if (bytes > limits.maxTotalBytes) {
                cb(rejected(`Archiv überschreitet entpackt ${limits.maxTotalBytes} Bytes (Zip-Bombe?)`))
                return
              }
              cb(null, chunk)
            },
          })

          await pipeline(readStream, counter, createWriteStream(target, { mode: 0o644 }))
          await chmod(target, 0o644)
          zip.readEntry()
        } catch (err) {
          fail(err)
        }
      })()
    })

    zip.readEntry()
  })

  return { files, bytes }
}

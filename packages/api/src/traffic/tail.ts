import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * Liest eine Log-Datei fortlaufend weiter, die Caddy rotiert (lumberjack:
 * die volle Datei wird zu «visits-<zeit>.log» umbenannt, eine neue
 * «visits.log» beginnt). Merkt sich Inode und Position; nach einer Rotation
 * liest es zuerst den Rest der alten Datei (an ihrer Inode wiedererkannt),
 * dann die neue von vorn. Nur ganze Zeilen kommen heraus.
 */

export interface TailPosition {
  ino: number
  pos: number
}

/** Höchstens so viel pro Aufruf lesen (der nächste Aufruf liest weiter) */
const MAX_READ = 4 * 1024 * 1024

export class LogTail {
  constructor(
    private readonly file: string,
    public position: TailPosition | null = null,
  ) {}

  /** Existiert die Datei? */
  async exists(): Promise<boolean> {
    return stat(this.file).then((s) => s.isFile()).catch(() => false)
  }

  private async readFrom(path: string, from: number, limit = MAX_READ): Promise<{ lines: string[]; next: number }> {
    const fh = await open(path, 'r')
    try {
      const size = (await fh.stat()).size
      if (size <= from) return { lines: [], next: from }
      const len = Math.min(size - from, limit)
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, from)
      const chunk = buf.subarray(0, bytesRead)
      const lastNl = chunk.lastIndexOf(0x0a)
      // Keine ganze Zeile: warten (ausser die Zeile ist absurd lang – dann verwerfen)
      if (lastNl < 0) return { lines: [], next: len >= limit ? from + len : from }
      const text = chunk.subarray(0, lastNl).toString('utf8')
      return { lines: text.split('\n').filter((l) => l.length > 0), next: from + lastNl + 1 }
    } finally {
      await fh.close()
    }
  }

  /** Rotierte Datei mit dieser Inode im selben Ordner suchen */
  private async rotated(ino: number): Promise<string | null> {
    const dir = dirname(this.file)
    const stem = basename(this.file).replace(/\.log$/, '')
    const names = await readdir(dir).catch(() => [] as string[])
    for (const n of names) {
      if (!n.startsWith(`${stem}-`)) continue
      const s = await stat(join(dir, n)).catch(() => null)
      if (s?.ino === ino) return join(dir, n)
    }
    return null
  }

  /** Neue ganze Zeilen seit dem letzten Aufruf */
  async poll(): Promise<string[]> {
    const s = await stat(this.file).catch(() => null)
    if (!s?.isFile()) return []
    const out: string[] = []
    let p = this.position
    if (p && p.ino !== s.ino) {
      // Rotiert: Rest der alten Datei, dann die neue von vorn
      const old = await this.rotated(p.ino)
      if (old) {
        // Rest vollständig lesen (in Stücken), damit beim Umschalten nichts fehlt
        for (let i = 0; i < 64; i++) {
          const r = await this.readFrom(old, p.pos)
          out.push(...r.lines)
          if (r.next === p.pos) break
          p = { ino: p.ino, pos: r.next }
        }
      }
      p = { ino: s.ino, pos: 0 }
    }
    if (!p) p = { ino: s.ino, pos: 0 }
    // Gekürzt (copytruncate o. ä.): von vorn
    if (s.size < p.pos) p = { ino: s.ino, pos: 0 }
    const r = await this.readFrom(this.file, p.pos)
    out.push(...r.lines)
    this.position = { ino: s.ino, pos: r.next }
    return out
  }
}

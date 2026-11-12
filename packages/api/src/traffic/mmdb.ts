import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { isIPv4, isIPv6 } from 'node:net'

/**
 * Kleiner Leser für das MaxMind-DB-Format (.mmdb), in dem DB-IP die
 * «IP to City Lite» ausliefert. Bewusst ohne Abhängigkeit: Suchbaum und
 * Datenteil nach der offenen Spezifikation
 * (https://maxmind.github.io/MaxMind-DB/), nur lesend.
 *
 * Gelesen wird über eine Quelle (read(offset, länge)): im Test ein Buffer,
 * im Betrieb die Datei mit kleinem Seiten-Cache – so liegen nicht die ganzen
 * ~130 MB im Speicher.
 */

export interface ByteSource {
  size: number
  read(offset: number, length: number): Buffer
  close?(): void
}

export const bufferSource = (buf: Buffer): ByteSource => ({
  size: buf.length,
  read: (offset, length) => buf.subarray(offset, offset + length),
})

/** Datei mit LRU-Cache aus 4-KB-Seiten (höchstens pages × 4 KB im Speicher) */
export function fileSource(path: string, pages = 4096): ByteSource {
  const fd = openSync(path, 'r')
  const PAGE = 4096
  const cache = new Map<number, Buffer>()
  const size = fstatSync(fd).size
  const page = (n: number): Buffer => {
    const hit = cache.get(n)
    if (hit) {
      cache.delete(n)
      cache.set(n, hit)
      return hit
    }
    const buf = Buffer.alloc(PAGE)
    const got = readSync(fd, buf, 0, PAGE, n * PAGE)
    const p = got < PAGE ? buf.subarray(0, got) : buf
    cache.set(n, p)
    if (cache.size > pages) cache.delete(cache.keys().next().value!)
    return p
  }
  return {
    size,
    read(offset, length) {
      const first = Math.floor(offset / PAGE)
      const last = Math.floor((offset + length - 1) / PAGE)
      if (first === last) {
        const p = page(first)
        const start = offset - first * PAGE
        return p.subarray(start, start + length)
      }
      const parts: Buffer[] = []
      for (let n = first; n <= last; n++) parts.push(page(n))
      const all = Buffer.concat(parts)
      const start = offset - first * PAGE
      return all.subarray(start, start + length)
    },
    close: () => closeSync(fd),
  }
}

const MARKER = Buffer.from('\xab\xcd\xefMaxMind.com', 'latin1')

export interface MmdbMetadata {
  node_count: number
  record_size: number
  ip_version: number
  database_type: string
  build_epoch: number
  languages?: string[]
}

class Decoder {
  constructor(private src: ByteSource, private base: number) {}

  private byte(o: number): number {
    return this.src.read(o, 1)[0]!
  }

  private uint(o: number, n: number): number {
    let v = 0
    const b = this.src.read(o, n)
    for (let i = 0; i < n; i++) v = v * 256 + b[i]!
    return v
  }

  /** Wert an Position (relativ zum Datenteil) → [Wert, nächste Position] */
  decode(offset: number, depth = 0): [unknown, number] {
    if (depth > 64) throw new Error('mmdb: zu tief verschachtelt')
    let o = offset
    const ctrl = this.byte(this.base + o++)
    let type = ctrl >> 5
    if (type === 1) {
      // Zeiger
      const ss = (ctrl >> 3) & 3
      const vvv = ctrl & 7
      let p: number
      if (ss === 0) { p = vvv * 256 + this.uint(this.base + o, 1); o += 1 }
      else if (ss === 1) { p = vvv * 65536 + this.uint(this.base + o, 2) + 2048; o += 2 }
      else if (ss === 2) { p = vvv * 16777216 + this.uint(this.base + o, 3) + 526336; o += 3 }
      else { p = this.uint(this.base + o, 4); o += 4 }
      const [v] = this.decode(p, depth + 1)
      return [v, o]
    }
    if (type === 0) type = 7 + this.byte(this.base + o++)
    let size = ctrl & 0x1f
    if (size === 29) size = 29 + this.uint(this.base + o++, 1)
    else if (size === 30) { size = 285 + this.uint(this.base + o, 2); o += 2 }
    else if (size === 31) { size = 65821 + this.uint(this.base + o, 3); o += 3 }
    switch (type) {
      case 2: return [this.src.read(this.base + o, size).toString('utf8'), o + size]
      case 3: return [this.src.read(this.base + o, 8).readDoubleBE(0), o + 8]
      case 4: return [Buffer.from(this.src.read(this.base + o, size)), o + size]
      case 5: case 6: case 9: case 10: {
        // Grosse Zahlen (uint64/128) nur als Näherung – kommen in City-Daten nicht als Schlüssel vor
        return [size ? this.uint(this.base + o, size) : 0, o + size]
      }
      case 8: {
        const b = Buffer.alloc(4)
        this.src.read(this.base + o, size).copy(b, 4 - size)
        return [b.readInt32BE(0), o + size]
      }
      case 7: {
        const m: Record<string, unknown> = {}
        for (let i = 0; i < size; i++) {
          const [k, a] = this.decode(o, depth + 1)
          const [v, b] = this.decode(a, depth + 1)
          m[String(k)] = v
          o = b
        }
        return [m, o]
      }
      case 11: {
        const arr: unknown[] = []
        for (let i = 0; i < size; i++) {
          const [v, b] = this.decode(o, depth + 1)
          arr.push(v)
          o = b
        }
        return [arr, o]
      }
      case 14: return [size !== 0, o]
      case 15: return [this.src.read(this.base + o, 4).readFloatBE(0), o + 4]
      default: throw new Error(`mmdb: unbekannter Typ ${type}`)
    }
  }
}

/** IP → 4 oder 16 Bytes; null bei ungültiger Adresse */
export function ipBytes(ip: string): number[] | null {
  const s = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  if (isIPv4(s)) return s.split('.').map(Number)
  if (!isIPv6(s)) return null
  let head = s
  let tail4: number[] = []
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (v4) {
    tail4 = v4[1]!.split('.').map(Number)
    head = s.slice(0, -v4[1]!.length) + '0:0'
  }
  const [l, r] = head.split('::')
  const left = l ? l.split(':').filter(Boolean) : []
  const right = r !== undefined ? (r ? r.split(':').filter(Boolean) : []) : []
  const groups = r !== undefined ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
  if (groups.length !== 8) return null
  const out: number[] = []
  for (const g of groups) {
    const n = parseInt(g, 16)
    out.push((n >> 8) & 255, n & 255)
  }
  if (tail4.length) out.splice(12, 4, ...tail4)
  return out
}

export class MmdbReader {
  readonly metadata: MmdbMetadata
  private dataBase: number
  private nodeBytes: number
  private ipv4Start = -1

  constructor(private src: ByteSource) {
    // Metadaten: nach dem letzten Marker in den letzten 128 KB
    const tailLen = Math.min(src.size, 128 * 1024)
    const tail = Buffer.from(src.read(src.size - tailLen, tailLen))
    const at = tail.lastIndexOf(MARKER)
    if (at < 0) throw new Error('Keine MaxMind-DB (Metadaten fehlen)')
    const metaStart = src.size - tailLen + at + MARKER.length
    const [meta] = new Decoder(src, metaStart).decode(0)
    this.metadata = meta as MmdbMetadata
    const { node_count, record_size } = this.metadata
    if (![24, 28, 32].includes(record_size)) throw new Error(`mmdb: Satzgrösse ${record_size} nicht unterstützt`)
    this.nodeBytes = (record_size * 2) / 8
    this.dataBase = node_count * this.nodeBytes + 16
  }

  private record(node: number, bit: number): number {
    const b = this.src.read(node * this.nodeBytes, this.nodeBytes)
    switch (this.metadata.record_size) {
      case 24: return bit ? (b[3]! << 16) | (b[4]! << 8) | b[5]! : (b[0]! << 16) | (b[1]! << 8) | b[2]!
      case 28: return bit
        ? (((b[3]! & 0x0f) << 24) | (b[4]! << 16) | (b[5]! << 8) | b[6]!) >>> 0
        : (((b[3]! & 0xf0) << 20) | (b[0]! << 16) | (b[1]! << 8) | b[2]!) >>> 0
      default: return bit ? b.readUInt32BE(4) : b.readUInt32BE(0)
    }
  }

  /** Datensatz zur Adresse oder null */
  get(ip: string): unknown | null {
    const bytes = ipBytes(ip)
    if (!bytes) return null
    const { node_count, ip_version } = this.metadata
    let node = 0
    if (bytes.length === 4 && ip_version === 6) {
      if (this.ipv4Start < 0) {
        let n = 0
        for (let i = 0; i < 96 && n < node_count; i++) n = this.record(n, 0)
        this.ipv4Start = n
      }
      node = this.ipv4Start
    } else if (bytes.length === 16 && ip_version === 4) {
      return null
    }
    const bits = bytes.length * 8
    for (let i = 0; i < bits && node < node_count; i++) {
      const bit = (bytes[i >> 3]! >> (7 - (i & 7))) & 1
      node = this.record(node, bit)
    }
    if (node === node_count) return null
    if (node < node_count) return null
    const offset = node - node_count - 16
    return new Decoder(this.src, this.dataBase).decode(offset)[0]
  }

  close(): void {
    this.src.close?.()
  }
}

type Names = { names?: Record<string, string> }

/** Stadt und Land aus einem City-Datensatz (GeoIP2-/DB-IP-Aufbau), deutsch vor englisch */
export function cityFromRecord(rec: unknown): { city: string; country: string } | null {
  if (!rec || typeof rec !== 'object') return null
  const r = rec as { city?: Names; country?: { iso_code?: string } }
  const names = r.city?.names ?? {}
  const city = (names.de ?? names.en ?? Object.values(names)[0] ?? '').slice(0, 80)
  const country = (r.country?.iso_code ?? '').toUpperCase()
  if (!city && !country) return null
  return { city, country: /^[A-Z]{2}$/.test(country) ? country : '' }
}

/** ASN und Name aus einem ASN-Datensatz (GeoLite2-ASN-/DB-IP-Aufbau) */
export function asnFromRecord(rec: unknown): { asn: number; name: string } | null {
  if (!rec || typeof rec !== 'object') return null
  const r = rec as { autonomous_system_number?: unknown; autonomous_system_organization?: unknown }
  const asn = Number(r.autonomous_system_number)
  if (!Number.isInteger(asn) || asn <= 0) return null
  // eslint-disable-next-line no-control-regex
  const name = typeof r.autonomous_system_organization === 'string' ? r.autonomous_system_organization.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : ''
  return { asn, name }
}

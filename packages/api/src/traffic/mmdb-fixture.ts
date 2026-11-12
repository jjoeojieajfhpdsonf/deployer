import { ipBytes } from './mmdb.js'

/**
 * Nur für Tests: schreibt eine winzige MaxMind-DB (Satzgrösse 24) mit ein
 * paar Netzen – so prüfen die Tests Leser und Stadt-Auflösung ohne die echte
 * DB-IP-Datei (die heute nicht heruntergeladen wird).
 */

type Value = string | number | boolean | Value[] | { [k: string]: Value }

function sizeBytes(type: number, size: number): number[] {
  const ext = type > 7
  const t = ext ? 0 : type
  const out: number[] = []
  let ctrlSize: number
  const extra: number[] = []
  if (size < 29) ctrlSize = size
  else if (size < 285) { ctrlSize = 29; extra.push(size - 29) }
  else { ctrlSize = 30; const s = size - 285; extra.push((s >> 8) & 255, s & 255) }
  out.push((t << 5) | ctrlSize)
  if (ext) out.push(type - 7)
  return [...out, ...extra]
}

function encode(v: Value): number[] {
  if (typeof v === 'string') {
    const b = [...Buffer.from(v, 'utf8')]
    return [...sizeBytes(2, b.length), ...b]
  }
  if (typeof v === 'boolean') return sizeBytes(14, v ? 1 : 0)
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0) {
      const b = Buffer.alloc(8)
      b.writeDoubleBE(v)
      return [...sizeBytes(3, 8), ...b]
    }
    const bytes: number[] = []
    let n = v
    while (n > 0) { bytes.unshift(n & 255); n = Math.floor(n / 256) }
    return [...sizeBytes(6, bytes.length), ...bytes]
  }
  if (Array.isArray(v)) return [...sizeBytes(11, v.length), ...v.flatMap(encode)]
  const entries = Object.entries(v)
  return [...sizeBytes(7, entries.length), ...entries.flatMap(([k, x]) => [...encode(k), ...encode(x)])]
}

type Rec = number | 'empty' | { data: number }

/** networks: [«1.2.3.0/24» oder «2001:db8::/32», Datensatz] */
export function buildMmdb(networks: [string, Value][], o: { ipVersion?: 4 | 6; databaseType?: string; buildEpoch?: number } = {}): Buffer {
  const ipVersion = o.ipVersion ?? 6
  const depth = ipVersion === 6 ? 128 : 32
  const nodes: [Rec, Rec][] = [['empty', 'empty']]
  const data: number[] = []
  for (const [cidr, value] of networks) {
    const [addr, p] = cidr.split('/')
    let bytes = ipBytes(addr!)!
    let prefix = Number(p)
    if (bytes.length === 4 && ipVersion === 6) {
      bytes = [...Array(12).fill(0), ...bytes]
      prefix += 96
    }
    if (bytes.length * 8 !== depth) throw new Error('Adressfamilie passt nicht zur Datenbank')
    const offset = data.length
    data.push(...encode(value))
    let node = 0
    for (let i = 0; i < prefix; i++) {
      const bit = (bytes[i >> 3]! >> (7 - (i & 7))) & 1
      if (i === prefix - 1) {
        nodes[node]![bit] = { data: offset }
        break
      }
      const next = nodes[node]![bit]
      if (typeof next === 'number') node = next
      else {
        nodes.push(['empty', 'empty'])
        nodes[node]![bit] = nodes.length - 1
        node = nodes.length - 1
      }
    }
  }
  const count = nodes.length
  const val = (r: Rec) => (r === 'empty' ? count : typeof r === 'number' ? r : count + 16 + r.data)
  const tree: number[] = []
  for (const [l, r] of nodes) {
    const a = val(l)
    const b = val(r)
    tree.push((a >> 16) & 255, (a >> 8) & 255, a & 255, (b >> 16) & 255, (b >> 8) & 255, b & 255)
  }
  const meta = encode({
    node_count: count,
    record_size: 24,
    ip_version: ipVersion,
    database_type: o.databaseType ?? 'DBIP-City-Lite',
    build_epoch: o.buildEpoch ?? 1793836800,
    languages: ['de', 'en'],
    binary_format_major_version: 2,
    binary_format_minor_version: 0,
  })
  return Buffer.from([...tree, ...Array(16).fill(0), ...data, ...Buffer.from('\xab\xcd\xefMaxMind.com', 'latin1'), ...meta])
}

/** City-Datensatz im Aufbau von DB-IP / GeoIP2 */
export const cityRecord = (city: string, country: string, cityEn = city): Value => ({
  city: { names: { de: city, en: cityEn } },
  country: { iso_code: country, names: { en: country } },
  location: { latitude: 47.37, longitude: 8.54 },
})

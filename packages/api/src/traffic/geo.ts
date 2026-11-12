import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { MmdbReader, asnFromRecord, cityFromRecord, fileSource } from './mmdb.js'

/**
 * Freie Dateien von DB-IP (Lizenz CC BY 4.0, Quelle https://db-ip.com – in
 * der Oberfläche genannt), beide optional:
 *
 * - «IP to City Lite»: Städte. Fehlt sie, gibt es nur Länder (CF-IPCountry
 *   von Cloudflare) bzw. Städte aus Cloudflares Kopfzeilen.
 * - «IP to ASN Lite» (seit «Besucher neu»): Netz/Provider (Swisscom, Init7 …)
 *   und Rechenzentren («vermutlich Bot»). Fehlt sie, gibt es kein «Netz».
 *
 * DB-IP veröffentlicht die Lite-Dateien monatlich unter
 * https://download.db-ip.com/free/dbip-<art>-lite-JJJJ-MM.mmdb.gz. Geladen
 * wird nur auf Wunsch (Knopf in «Besucher» bzw. Server › Besucher); danach
 * hält ein Job sie monatlich aktuell. Ohne diesen ersten Schritt fragt Airlock
 * nie bei DB-IP an.
 */

export type DbipKind = 'city' | 'asn'

const KIND = {
  city: { file: 'dbip-city-lite.mmdb', info: 'dbip-city-lite.json', type: /city/i, label: 'Städte-Datenbank', name: 'DB-IP «IP to City Lite»' },
  asn: { file: 'dbip-asn-lite.mmdb', info: 'dbip-asn-lite.json', type: /asn/i, label: 'Provider-Datenbank', name: 'DB-IP «IP to ASN Lite»' },
} as const

export const CITY_DB_FILE = KIND.city.file
export const ASN_DB_FILE = KIND.asn.file
export const CITY_DB_SOURCE = { name: KIND.city.name, license: 'CC BY 4.0', url: 'https://db-ip.com' }
export const ASN_DB_SOURCE = { name: KIND.asn.name, license: 'CC BY 4.0', url: 'https://db-ip.com' }

export const dbipUrl = (kind: DbipKind, month: string) => `https://download.db-ip.com/free/dbip-${kind}-lite-${month}.mmdb.gz`
export const cityDbUrl = (month: string) => dbipUrl('city', month)

/** «JJJJ-MM» eines Zeitpunkts (UTC); offset: Monate zurück */
export function monthOf(ms: number, offset = 0): string {
  const d = new Date(ms)
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - offset, 1))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`
}

export interface CityDbInfo {
  month: string
  downloadedAt: string
}

/** Ist eine Aktualisierung fällig? Nur mit vorhandener Datei (erster Download nur auf Wunsch), ab dem 3. des Monats */
export function cityDbDue(info: CityDbInfo | null, now: number): boolean {
  if (!info) return false
  return info.month < monthOf(now) && new Date(now).getUTCDate() >= 3
}
export const dbipDue = cityDbDue

/** Eine Monatsdatei von DB-IP (Städte oder ASN) im Verzeichnis dir */
export class DbipDb {
  private reader: MmdbReader | null = null
  private info: CityDbInfo | null = null

  constructor(private readonly dir: string, readonly kind: DbipKind = 'city') {}

  /** Datei (neu) öffnen; ohne Datei bleibt das Merkmal leer */
  async load(): Promise<boolean> {
    const k = KIND[this.kind]
    const path = join(this.dir, k.file)
    const exists = await stat(path).then((s) => s.isFile()).catch(() => false)
    this.reader?.close()
    this.reader = null
    this.info = null
    if (!exists) return false
    this.reader = new MmdbReader(fileSource(path))
    this.info = await readFile(join(this.dir, k.info), 'utf8').then((t) => JSON.parse(t) as CityDbInfo).catch(() => ({
      month: monthOf(this.reader!.metadata.build_epoch * 1000),
      downloadedAt: new Date(0).toISOString(),
    }))
    return true
  }

  /** Stand der Datei als «JJJJ-MM», null ohne Datei */
  get month(): string | null {
    return this.info?.month ?? null
  }

  get current(): CityDbInfo | null {
    return this.info
  }

  /** Rohdatensatz zu einer IP; null ohne Datei oder Treffer */
  protected record(ip: string): unknown {
    if (!this.reader) return null
    try {
      return this.reader.get(ip)
    } catch {
      return null
    }
  }

  /**
   * Monatsdatei laden: aktueller Monat, sonst der vorige (DB-IP stellt die
   * neue Datei erst in den ersten Tagen bereit). Entpackt in eine
   * temporäre Datei, prüft sie mit dem Leser und ersetzt dann die alte.
   */
  async download(o: { now?: number; fetchImpl?: typeof fetch } = {}): Promise<CityDbInfo> {
    const k = KIND[this.kind]
    const now = o.now ?? Date.now()
    const f = o.fetchImpl ?? fetch
    await mkdir(this.dir, { recursive: true })
    const tmp = join(this.dir, `${k.file}.tmp`)
    let lastError = ''
    for (const month of [monthOf(now), monthOf(now, 1)]) {
      const res = await f(dbipUrl(this.kind, month), { headers: { 'user-agent': 'airlock (self-hosted)' }, signal: AbortSignal.timeout(10 * 60_000) })
      if (!res.ok || !res.body) {
        lastError = `HTTP ${res.status} für ${month}`
        continue
      }
      try {
        await pipeline(Readable.fromWeb(res.body as never), createGunzip(), createWriteStream(tmp))
        const test = new MmdbReader(fileSource(tmp))
        const type = test.metadata.database_type
        test.close()
        if (!k.type.test(type)) throw new Error(`unerwarteter Datenbanktyp «${type}»`)
      } catch (err) {
        await rm(tmp, { force: true })
        throw new Error(`${k.label} unbrauchbar: ${(err as Error).message}`)
      }
      await rename(tmp, join(this.dir, k.file))
      const info = { month, downloadedAt: new Date(now).toISOString() }
      await writeFile(join(this.dir, k.info), JSON.stringify(info))
      await this.load()
      return info
    }
    throw new Error(`${k.label} nicht verfügbar (${lastError})`)
  }

  /** Datei entfernen */
  async remove(): Promise<void> {
    const k = KIND[this.kind]
    this.reader?.close()
    this.reader = null
    this.info = null
    await rm(join(this.dir, k.file), { force: true })
    await rm(join(this.dir, k.info), { force: true })
  }
}

/** Städte (DB-IP «IP to City Lite») */
export class CityDb extends DbipDb {
  constructor(dir: string) {
    super(dir, 'city')
  }

  /** Stadt und Land zu einer öffentlichen IP; null ohne Datei oder Treffer */
  lookup(ip: string): { city: string; country: string } | null {
    return cityFromRecord(this.record(ip))
  }
}

/** Netze (DB-IP «IP to ASN Lite») */
export class AsnDb extends DbipDb {
  constructor(dir: string) {
    super(dir, 'asn')
  }

  /** ASN und Name des Netzes zu einer öffentlichen IP; null ohne Datei oder Treffer */
  lookup(ip: string): { asn: number; name: string } | null {
    return asnFromRecord(this.record(ip))
  }
}

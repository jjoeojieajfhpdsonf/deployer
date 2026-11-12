import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { MmdbReader, cityFromRecord, fileSource } from './mmdb.js'

/**
 * Städte aus DB-IP «IP to City Lite» (Lizenz CC BY 4.0, Quelle
 * https://db-ip.com – in der Oberfläche genannt). Optional: fehlt die Datei,
 * gibt es nur Länder (CF-IPCountry von Cloudflare).
 *
 * DB-IP veröffentlicht die Lite-Datei monatlich unter
 * https://download.db-ip.com/free/dbip-city-lite-JJJJ-MM.mmdb.gz. Geladen
 * wird nur auf Wunsch (System › Besucher, «Städte-Datenbank laden»); danach
 * hält ein Job sie monatlich aktuell. Ohne diesen ersten Schritt fragt Airlock
 * nie bei DB-IP an.
 */

export const CITY_DB_FILE = 'dbip-city-lite.mmdb'
const INFO_FILE = 'dbip-city-lite.json'
export const CITY_DB_SOURCE = { name: 'DB-IP «IP to City Lite»', license: 'CC BY 4.0', url: 'https://db-ip.com' }

export const cityDbUrl = (month: string) => `https://download.db-ip.com/free/dbip-city-lite-${month}.mmdb.gz`

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

export class CityDb {
  private reader: MmdbReader | null = null
  private info: CityDbInfo | null = null

  constructor(private readonly dir: string) {}

  /** Datei (neu) öffnen; ohne Datei bleibt es bei «nur Länder» */
  async load(): Promise<boolean> {
    const path = join(this.dir, CITY_DB_FILE)
    const exists = await stat(path).then((s) => s.isFile()).catch(() => false)
    this.reader?.close()
    this.reader = null
    this.info = null
    if (!exists) return false
    this.reader = new MmdbReader(fileSource(path))
    this.info = await readFile(join(this.dir, INFO_FILE), 'utf8').then((t) => JSON.parse(t) as CityDbInfo).catch(() => ({
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

  /** Stadt und Land zu einer öffentlichen IP; null ohne Datei oder Treffer */
  lookup(ip: string): { city: string; country: string } | null {
    if (!this.reader) return null
    try {
      return cityFromRecord(this.reader.get(ip))
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
    const now = o.now ?? Date.now()
    const f = o.fetchImpl ?? fetch
    await mkdir(this.dir, { recursive: true })
    const tmp = join(this.dir, `${CITY_DB_FILE}.tmp`)
    let lastError = ''
    for (const month of [monthOf(now), monthOf(now, 1)]) {
      const res = await f(cityDbUrl(month), { headers: { 'user-agent': 'airlock (self-hosted)' }, signal: AbortSignal.timeout(10 * 60_000) })
      if (!res.ok || !res.body) {
        lastError = `HTTP ${res.status} für ${month}`
        continue
      }
      try {
        await pipeline(Readable.fromWeb(res.body as never), createGunzip(), createWriteStream(tmp))
        const test = new MmdbReader(fileSource(tmp))
        const type = test.metadata.database_type
        test.close()
        if (!/city/i.test(type)) throw new Error(`unerwarteter Datenbanktyp «${type}»`)
      } catch (err) {
        await rm(tmp, { force: true })
        throw new Error(`Städte-Datenbank unbrauchbar: ${(err as Error).message}`)
      }
      await rename(tmp, join(this.dir, CITY_DB_FILE))
      const info = { month, downloadedAt: new Date(now).toISOString() }
      await writeFile(join(this.dir, INFO_FILE), JSON.stringify(info))
      await this.load()
      return info
    }
    throw new Error(`Städte-Datenbank nicht verfügbar (${lastError})`)
  }

  /** Datei entfernen (zurück zu «nur Länder») */
  async remove(): Promise<void> {
    this.reader?.close()
    this.reader = null
    this.info = null
    await rm(join(this.dir, CITY_DB_FILE), { force: true })
    await rm(join(this.dir, INFO_FILE), { force: true })
  }
}

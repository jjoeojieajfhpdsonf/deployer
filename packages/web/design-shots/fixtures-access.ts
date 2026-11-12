/**
 * Zugriffe neu: Testdaten des Reiters «Zugriffe» (wie GET /projects/:id/access)
 * nach der Vorlage docs/design-cal/zugriffe-neu/: eine kleine öffentliche
 * Seite (hallo-welt), dazu ein Tailnet-Gerät, maskierter Tailnet-Verkehr
 * aus dem Docker-Netz (vom IP-Filter abgewiesen), ein Tippfehler-Pfad in
 * Serie, Scanner aus einem Rechenzentrum, eigene Prüfungen von Airlock und
 * Crawler. Absender wie von der API: gekürzt. Zeit aus Date.now() (in den
 * visuellen Tests die feste Uhr), Kennungen fest, damit ?zeile=… trifft.
 */
import type { AccessEntryDto, AccessListDto } from '@airlock/shared'

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

const PUB = 'hallo-welt.example.ch'
const INT = 'hallo-welt.int.example.ch'

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0'
const cut = (v: string) => (v.length > 60 ? `${v.slice(0, 60).trimEnd()} …` : v)

const ZSCALER = { asn: 62044, name: 'Zscaler, Inc.', datacenter: false }
const INIT7 = { asn: 13030, name: 'Init7 (Switzerland) Ltd.', datacenter: false }
const TELEKOM = { asn: 3320, name: 'Deutsche Telekom AG', datacenter: false }
const DO = { asn: 14061, name: 'DigitalOcean, LLC', datacenter: true }
const GOOGLE = { asn: 15169, name: 'Google LLC', datacenter: true }

type Base = Omit<AccessEntryDto, 'id' | 'at'>

const browser = (ua: string, lang = 'de-CH,de;q=0.9', site = 'none'): Pick<Base, 'headers'> => ({
  headers: [['user-agent', cut(ua)], ['accept-language', lang], ['sec-fetch-site', site], ['sec-fetch-mode', 'navigate'], ['sec-fetch-dest', 'document']],
})

const internet = (o: Partial<Base>): Base => ({
  method: 'GET', host: PUB, path: '/', status: 200, block: null, way: 'public', dockerNet: false, ip: '84.72.10.x', country: 'CH', city: 'Zürich',
  network: ZSCALER, browser: 'Chrome 131', system: 'Windows 10', device: 'desktop', language: 'de-CH', referrer: '', proto: 'HTTP/2', tls: '',
  durationMs: 0.6, bytes: 2140, bot: null, probe: false, scanner: false, ...browser(CHROME), ...o,
})

const internal = (o: Partial<Base>): Base => ({
  method: 'GET', host: INT, path: '/', status: 200, block: null, way: 'tailnet', dockerNet: false, ip: '100.88.41.x', country: '', city: '',
  network: null, browser: 'Safari 18', system: 'iOS 18', device: 'mobile', language: 'de-CH', referrer: '', proto: 'HTTP/2', tls: 'TLS 1.3',
  durationMs: 0.4, bytes: 2140, bot: null, probe: false, scanner: false, ...browser(IPHONE), ...o,
})

/** Tailnet-Verkehr, maskiert auf das Docker-Gateway: Caddy sieht 172.25.0.1, der IP-Filter weist ab */
const masked = (o: Partial<Base> = {}): Base => internal({
  way: 'lan', dockerNet: true, ip: '172.25.0.x', status: 403, block: 'ip-filter', bytes: 168, durationMs: 0.1,
  headers: [...browser(IPHONE).headers, ['x-airlock-block', 'ip-filter']], ...o,
})

const probe = (o: Partial<Base> = {}): Base => internal({
  way: 'lan', ip: '192.168.1.x', browser: '', system: '', device: 'desktop', language: '', probe: true, bot: 'ua', tls: 'TLS 1.3',
  headers: [['user-agent', 'airlock-probe (adresse)']], ...o,
})

const crawler = (o: Partial<Base> = {}): Base => internet({
  path: '/robots.txt', country: 'US', city: '', network: GOOGLE, browser: '', system: '', language: '', bot: 'ua', bytes: 64,
  headers: [['user-agent', cut('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')]], ...o,
})

function list(): AccessEntryDto[] {
  const rows: [string, number, Base][] = [
    ['z-neu', 20 * SEC, internet({})],
    ['z-gw', 21 * SEC, masked()],
    ['z-gw-2', 24 * SEC, masked()],
    ['z-iphone', 22 * SEC, internal({})],
    ['z-zs-1', 7 * MIN + 40 * SEC, internet({})],
    ['z-zs-2', 7 * MIN + 41 * SEC, internet({})],
    ['z-gw-3', 7 * MIN + 42 * SEC, masked()],
    ['z-mac', 18 * MIN, internal({ way: 'lan', ip: '192.168.1.x', browser: 'Safari 18', system: 'macOS', device: 'desktop', ...browser(MAC) })],
    ['z-de', 1 * HOUR + 29 * MIN, internet({ path: '/impressum', country: 'DE', city: 'Berlin', network: TELEKOM, browser: 'Firefox 132', system: 'macOS', referrer: 'https://www.google.com/', ...browser(FIREFOX, 'de-DE,de;q=0.8', 'cross-site') })],
    // Nachts: Scanner aus einem Rechenzentrum, Stammgast aus dem Heimnetz der Eltern
    ['z-wp', 14 * HOUR + 46 * MIN, internet({ path: '/wp-login.php', status: 404, country: 'NL', city: 'Amsterdam', network: DO, browser: '', system: '', language: '', bot: 'datacenter', scanner: true, bytes: 18, headers: [['user-agent', 'Mozilla/5.0']] })],
    ['z-env', 14 * HOUR + 46 * MIN + 2 * SEC, internet({ path: '/.env', status: 404, country: 'NL', city: 'Amsterdam', network: DO, browser: '', system: '', language: '', bot: 'datacenter', scanner: true, bytes: 18, headers: [['user-agent', 'Mozilla/5.0']] })],
  ]
  // Tippfehler in Serie (gleicher Pfad, gleicher Absender, 3 Minuten)
  for (let i = 0; i < 12; i++) rows.push([`z-typo-${i}`, 52 * MIN + i * 15 * SEC, internet({ path: '/tzhjgbvcf', status: 404, bytes: 9 })])
  // Stammgast mit vier Seiten in zwei Minuten
  for (let i = 0; i < 4; i++) rows.push([`z-init7-${i}`, 15 * HOUR + 58 * MIN + i * 30 * SEC, internet({ network: INIT7, city: 'Bern', ip: '213.55.240.x', browser: 'Safari 18', system: 'macOS', ...browser(MAC) })])
  // Eigene Prüfungen (ausgeblendet) und Crawler (ausgeblendet)
  for (let i = 0; i < 9; i++) rows.push([`z-probe-${i}`, 3 * MIN + i * 10 * MIN, probe()])
  for (let i = 0; i < 5; i++) rows.push([`z-bot-${i}`, 35 * MIN + i * 2 * HOUR, crawler()])
  return rows
    .map(([id, t, e]) => ({ id, at: ago(t), ...e }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

export type AccessVariant = 'ok' | 'leer' | 'wartet' | 'aus'

export function accessFixture(id: string, range: string | null, variant: AccessVariant = 'ok'): AccessListDto {
  const minutes = range === '15m' ? 15 : range === '1h' ? 60 : 24 * 60
  const since = ago(minutes * MIN)
  if (variant === 'aus') return { entries: [], since, ingest: 'off', capped: false, error: null }
  if (variant === 'wartet') return { entries: [], since, ingest: 'waiting', capped: false, error: null }
  if (variant === 'leer' || id !== 'p-hallo') return { entries: [], since, ingest: 'ok', capped: false, error: null }
  return { entries: list().filter((e) => e.at >= since), since, ingest: 'ok', capped: false, error: null }
}

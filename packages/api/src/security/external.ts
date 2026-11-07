import { BlockList, isIP } from 'node:net'
import { AppError } from '../lib/errors.js'

/**
 * Externe Ziele mit DNS-Besitznachweis (SPEC). Reine Logik; der Resolver ist
 * austauschbar, damit sich alles ohne echte Domain testen lässt.
 */

export const TXT_PREFIX = '_deployer-verify'
export const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9']
/** So viele öffentliche Resolver müssen den Eintrag bestätigen. */
export const RESOLVER_QUORUM = 2

const bad = (msg: string) => new AppError('external_target_rejected', msg, 400)

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
/** Namen, die nie öffentlich auflösen oder uns selbst gehören. */
const RESERVED_SUFFIXES = ['localhost', 'local', 'internal', 'invalid', 'test', 'example', 'lan', 'home.arpa', 'nip.io']

export function validateExternalHostname(raw: string, internalBaseDomain: string | null): string {
  const h = raw.trim().toLowerCase().replace(/\.$/, '')
  if (!h || h.length > 253) throw bad('Ungültiger Hostname')
  if (isIP(h)) throw bad('Eine IP-Adresse ist kein Ziel; bitte den Hostnamen angeben')
  const labels = h.split('.')
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) throw bad(`"${raw}" ist kein gültiger Hostname`)
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1]!) && !labels[labels.length - 1]!.startsWith('xn--')) {
    throw bad(`"${raw}" hat keine gültige Top-Level-Domain`)
  }
  for (const s of RESERVED_SUFFIXES) {
    if (h === s || h.endsWith(`.${s}`)) throw bad(`"${h}" ist kein öffentlicher Name`)
  }
  if (internalBaseDomain && (h === internalBaseDomain || h.endsWith(`.${internalBaseDomain}`))) {
    throw bad(`"${h}" liegt unter der internen Basisdomain; das sind Projekte von deployer selbst`)
  }
  return h
}

export const txtRecordName = (hostname: string) => `${TXT_PREFIX}.${hostname}`
export const txtExpectedValue = (token: string) => `deployer-verify=${token}`

/** TXT-Einträge kommen in Stücken; ein Eintrag passt, wenn er zusammengesetzt genau stimmt. */
export function txtMatches(records: string[][], token: string): boolean {
  const want = txtExpectedValue(token)
  return records.some((chunks) => chunks.join('').trim() === want)
}

export type TxtResolver = (server: string, name: string) => Promise<string[][]>

/**
 * Fragt alle öffentlichen Resolver. Freigegeben ist das Ziel, wenn
 * mindestens RESOLVER_QUORUM von ihnen den Eintrag liefern – ein einzelner
 * manipulierter Resolver reicht nicht.
 */
export async function verifyTxt(
  hostname: string,
  token: string,
  resolve: TxtResolver,
  servers = PUBLIC_RESOLVERS,
): Promise<{ verified: boolean; confirmedBy: string[]; errors: string[] }> {
  const name = txtRecordName(hostname)
  const results = await Promise.all(
    servers.map(async (s) => {
      try {
        return { s, ok: txtMatches(await resolve(s, name), token), err: null as string | null }
      } catch (e) {
        return { s, ok: false, err: (e as { code?: string }).code ?? (e as Error).message }
      }
    }),
  )
  const confirmedBy = results.filter((r) => r.ok).map((r) => r.s)
  return {
    verified: confirmedBy.length >= Math.min(RESOLVER_QUORUM, servers.length),
    confirmedBy,
    errors: results.filter((r) => r.err).map((r) => `${r.s}: ${r.err}`),
  }
}

/* --- Ziel muss öffentlich sein --------------------------------------------------- */

/**
 * Bereiche, die kein externes Ziel sein dürfen. Ohne diese Prüfung könnte
 * jemand mit Token einen eigenen Namen per TXT nachweisen, ihn aber auf
 * 192.168.1.1 zeigen lassen – und die Scanner (bis hin zum aktiven ZAP)
 * gegen den Router oder andere Geräte im LAN richten (Review M6).
 */
const NON_PUBLIC: [string, number, 'ipv4' | 'ipv6'][] = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'], // CGNAT, auch Tailscale
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['64:ff9b:1::', 48, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
]
const nonPublic = new BlockList()
for (const [a, p, t] of NON_PUBLIC) nonPublic.addSubnet(a, p, t)

export function isPublicAddress(raw: string): boolean {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw)
  const ip = m ? m[1]! : raw
  const v = isIP(ip)
  if (!v) return false
  return !nonPublic.check(ip, v === 6 ? 'ipv6' : 'ipv4')
}

export type AddressResolver = (name: string) => Promise<string[]>

/** Alle Adressen des Namens müssen öffentlich sein; mindestens eine muss es geben. */
export async function assertPublicTarget(hostname: string, resolve: AddressResolver): Promise<string[]> {
  const addrs = await resolve(hostname).catch(() => [] as string[])
  if (addrs.length === 0) throw bad(`${hostname} löst nicht auf`)
  const priv = addrs.filter((a) => !isPublicAddress(a))
  if (priv.length) throw bad(`${hostname} zeigt auf eine nicht öffentliche Adresse (${priv.join(', ')}); solche Ziele scannt deployer nicht`)
  return addrs
}

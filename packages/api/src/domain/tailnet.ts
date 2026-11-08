import { cf as settings, config, cloudflareToken } from '../config.js'
import { Cloudflare, zoneFor, upsertManagedRecord, CloudflareError } from '../drivers/cloudflare.js'
import { audit } from './audit.js'
import { log } from '../lib/log.js'

/**
 * M4: Tailnet-DNS. `*.<basisdomain>` zeigt bei Cloudflare auf die
 * Tailscale-IP des Servers, Typ A, NICHT proxied (SPEC) – Cloudflare kann
 * 100.x-Adressen ohnehin nicht erreichen; der Eintrag dient nur der
 * Namensauflösung unterwegs. Im LAN beantwortet der lokale DNS dieselben
 * Namen mit der LAN-IP.
 */

export interface TailnetDnsResult {
  name: string
  content: string
  action: 'created' | 'updated' | 'unchanged'
  zone: string
}

/** Client mit dem Token aus der Secret-Datei; null, wenn keins da ist. */
export function cloudflareClient(): Cloudflare | null {
  const token = cloudflareToken()
  return token ? new Cloudflare({ token, base: config.CLOUDFLARE_API_BASE }) : null
}

export function tailnetDnsConfigured(): boolean {
  return Boolean(settings.token() && settings.baseDomain() && settings.tailscaleIp())
}

export async function ensureTailnetDns(actor: string, cf = cloudflareClient()): Promise<TailnetDnsResult> {
  const base = settings.baseDomain()
  const ip = settings.tailscaleIp()
  if (!base || !ip) throw new CloudflareError('Für den Tailnet-Eintrag braucht es Basisdomain und Tailscale-IP (System → Cloudflare)', 400)
  if (!cf) throw new CloudflareError('Kein Cloudflare-Token (System → Cloudflare verbinden)', 400)
  return ensureWildcardRecord(cf, base, ip, actor)
}

/** Kern ohne config – testbar mit der Cloudflare-Attrappe. */
export async function ensureWildcardRecord(cf: Cloudflare, baseDomain: string, ip: string, actor: string): Promise<TailnetDnsResult> {
  const zone = zoneFor(baseDomain, await cf.listZones())
  if (!zone) throw new CloudflareError(`Keine Cloudflare-Zone für ${baseDomain} in diesem Konto (oder dem Token fehlen die Rechte)`, 404)
  const name = `*.${baseDomain}`
  const r = await upsertManagedRecord(cf, zone.id, { type: 'A', name, content: ip, proxied: false })
  if (r.action !== 'unchanged') {
    await audit({ actor, action: 'dns.tailnet', targetType: 'dns', targetId: r.record.id, params: { name, content: ip, action: r.action }, result: 'ok' })
    log.info('Tailnet-DNS-Eintrag gesetzt', { name, content: ip, action: r.action })
  }
  return { name, content: ip, action: r.action, zone: zone.name }
}

/** Beim Start: Eintrag sicherstellen, Fehler nur melden (der Start geht weiter). */
export async function ensureTailnetDnsOnBoot(): Promise<void> {
  if (!tailnetDnsConfigured()) return
  try {
    await ensureTailnetDns('system')
  } catch (err) {
    log.warn('Tailnet-DNS-Eintrag nicht gesetzt', { err: (err as Error).message })
  }
}

import { config, net, cloudflareToken } from '../config.js'
import { Cloudflare, zoneFor, upsertManagedRecord, CloudflareError } from '../drivers/cloudflare.js'
import { audit } from './audit.js'
import { log } from '../lib/log.js'

/**
 * M4: Tailnet-DNS. `*.<basisdomain>` zeigt bei Cloudflare auf die
 * Tailscale-IP des Servers, Typ A, NICHT proxied (SPEC) – Cloudflare kann
 * 100.x-Adressen ohnehin nicht erreichen; der Eintrag dient nur der
 * Namensauflösung unterwegs. Im LAN beantwortet der lokale DNS dieselben
 * Namen mit der LAN-IP.
 *
 * M9: ein Eintrag je Umgebung (in ihrer Hauptzone, mit ihrem Token). Die
 * Tailscale-IP ist serverweit; ändert sie sich, zieht Airlock alle nach.
 */

export interface TailnetDnsResult {
  name: string
  content: string
  action: 'created' | 'updated' | 'unchanged'
  zone: string
  /** M9: Umgebung (Slug) */
  environment?: string
}

/** Client mit dem Token der Standard-Umgebung; null, wenn keins da ist. */
export function cloudflareClient(): Cloudflare | null {
  const token = cloudflareToken()
  return token ? new Cloudflare({ token, base: config.CLOUDFLARE_API_BASE }) : null
}

/** Basen mit Token, je Umgebung (aus den Cloudflare-Einstellungen). */
async function targets(): Promise<{ env: string; base: string; token: string }[]> {
  const { allEnvironments } = await import('./environments.js')
  const { cloudflareFor } = await import('./cloudflare-settings.js')
  return allEnvironments().flatMap((e) => {
    const c = cloudflareFor(e.id)
    return c.baseDomain && c.token ? [{ env: e.slug, base: c.baseDomain, token: c.token }] : []
  })
}

export async function tailnetDnsConfigured(): Promise<boolean> {
  return Boolean(net.tailscaleIp()) && (await targets()).length > 0
}

/** Einträge aller Umgebungen setzen. Ein Fehler in einer Umgebung hält die anderen nicht auf; er kommt am Ende. */
export async function ensureTailnetDns(actor: string): Promise<TailnetDnsResult[]> {
  const ip = net.tailscaleIp()
  const list = await targets()
  if (!ip || !list.length) throw new CloudflareError('Für den Tailnet-Eintrag braucht es Basisdomain und Tailscale-IP (Einstellungen → Cloudflare & HTTPS)', 400)
  const out: TailnetDnsResult[] = []
  const errors: string[] = []
  for (const t of list) {
    try {
      out.push({ ...(await ensureTailnetDnsFor(t.base, t.token, actor)), environment: t.env })
    } catch (err) {
      errors.push(`${t.env}: ${(err as Error).message}`)
    }
  }
  if (errors.length && !out.length) throw new CloudflareError(errors.join('; '), 502)
  if (errors.length) log.warn('Tailnet-Eintrag nicht in allen Umgebungen gesetzt', { fehler: errors })
  return out
}

/** Eintrag *.<basis> einer Umgebung mit ihrem Token. */
export async function ensureTailnetDnsFor(base: string, token: string, actor: string): Promise<TailnetDnsResult> {
  const ip = net.tailscaleIp()
  if (!ip) throw new CloudflareError('Keine Tailscale-IP bekannt', 400)
  return ensureWildcardRecord(new Cloudflare({ token, base: config.CLOUDFLARE_API_BASE }), base, ip, actor)
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

/** Beim Start und nach einem IP-Wechsel: Einträge aller Umgebungen sicherstellen, Fehler nur melden. */
export async function ensureTailnetDnsOnBoot(): Promise<void> {
  if (!(await tailnetDnsConfigured())) return
  try {
    await ensureTailnetDns('system')
  } catch (err) {
    log.warn('Tailnet-DNS-Eintrag nicht gesetzt', { err: (err as Error).message })
  }
}

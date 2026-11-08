import { config, net, setNetRuntime, type NetRuntime } from '../config.js'
import * as docker from '../drivers/docker.js'
import { getSetting, setSetting } from '../db/index.js'
import { audit } from './audit.js'
import { log } from '../lib/log.js'

/**
 * Netz des Servers: LAN-IP, LAN-Netz und Tailscale-IP, gelesen vom Host.
 *
 * Der deployer läuft im Container und sieht die Adressen des Hosts nicht.
 * Ein kurzlebiger Hilfscontainer im Host-Netz (`ip route` / `ip addr`, aus
 * dem schon vorhandenen Caddy-Image) liest sie. Beim Start und stündlich;
 * ändert sich etwas, ziehen Adressen, Caddy-Filter und Anzeigen nach – ohne
 * dass jemand .env anpasst.
 *
 * Auf Docker Desktop (Mac/Windows) ist das Host-Netz das der VM, nicht das
 * des Rechners: dort keine Erkennung, es gelten SERVER_LAN_IP und LAN_CIDR.
 */

const HOUR = 60 * 60_000
const KEY = 'network_detected'

export interface Detected { lanIp: string | null; lanCidr: string | null; lanDev: string | null; tailscaleIp: string | null }

const toInt = (ip: string) => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0
const toIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.')

/** 192.168.1.23/24 -> 192.168.1.0/24 */
export function networkOf(cidr: string): string | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr)
  if (!m) return null
  const bits = Number(m[2])
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return `${toIp(toInt(m[1]!) & mask)}/${bits}`
}

const isTailscale = (ip: string) => {
  const [a, b] = ip.split('.').map(Number)
  return a === 100 && b! >= 64 && b! <= 127
}
const ignoredDev = (dev: string) => /^(lo|docker\d*|br-|veth|tailscale|virbr|cni|flannel|wg)/.test(dev)

/**
 * Ausgabe von `ip -4 route get 1.1.1.1; echo ---; ip -4 -o addr show` lesen.
 * LAN: die Schnittstelle der Standardroute, ausser sie führt über Tailscale
 * (Exit-Node) – dann die erste übrige private Adresse.
 */
export function parseIpOutput(out: string): Detected {
  const [routePart = '', addrPart = ''] = out.split(/^---$/m)
  const addrs = [...addrPart.matchAll(/^\d+:\s+(\S+)\s+inet\s+(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})/gm)].map((m) => ({ dev: m[1]!, ip: m[2]!, bits: m[3]! }))
  const tailscale = addrs.find((a) => a.dev.startsWith('tailscale') || isTailscale(a.ip)) ?? null
  const route = /\bdev\s+(\S+).*?\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(routePart)
  let lan = route && !ignoredDev(route[1]!) && !isTailscale(route[2]!) ? addrs.find((a) => a.dev === route[1] && a.ip === route[2]) ?? null : null
  lan ??= addrs.find((a) => !ignoredDev(a.dev) && !isTailscale(a.ip) && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.ip)) ?? null
  return {
    lanIp: lan?.ip ?? null,
    lanCidr: lan ? networkOf(`${lan.ip}/${lan.bits}`) : null,
    lanDev: lan?.dev ?? null,
    tailscaleIp: tailscale?.ip ?? null,
  }
}

let dockerDesktop: boolean | null = null

async function isDockerDesktop(): Promise<boolean> {
  if (dockerDesktop !== null) return dockerDesktop
  const info = (await docker.docker.info().catch(() => null)) as { OperatingSystem?: string } | null
  dockerDesktop = /docker desktop/i.test(info?.OperatingSystem ?? '')
  return dockerDesktop
}

/** Hilfscontainer im Host-Netz, nur lesend, sofort wieder entfernt. */
async function readHostNetwork(): Promise<Detected | null> {
  const caddy = (await docker.docker.getContainer(config.CADDY_CONTAINER).inspect().catch(() => null)) as { Config?: { Image?: string } } | null
  const image = caddy?.Config?.Image
  if (!image) return null
  const c = await docker.docker.createContainer({
    Image: image,
    Entrypoint: ['sh', '-c'],
    Cmd: ['ip -4 route get 1.1.1.1 2>/dev/null; echo ---; ip -4 -o addr show'],
    Labels: { 'deployer.system': 'netcheck' },
    NetworkDisabled: false,
    HostConfig: {
      NetworkMode: 'host',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: 32 * 1024 * 1024,
    },
  })
  try {
    await c.start()
    await docker.waitForExit(c.id, 15_000)
    const out = await docker.getLogs(c.id, { tail: 200 })
    return parseIpOutput(out)
  } finally {
    await c.remove({ force: true }).catch(() => {})
  }
}

let current: Detected & { checkedAt: string | null; mode: 'detected' | 'env' } = { lanIp: null, lanCidr: null, lanDev: null, tailscaleIp: null, checkedAt: null, mode: 'env' }

export const networkState = () => current

/**
 * Einmal prüfen. Gibt true zurück, wenn sich etwas geändert hat (dann sind
 * Adressen und Caddy schon nachgezogen).
 */
export async function checkNetwork(actor = 'system', o: { reconcile?: boolean } = {}): Promise<boolean> {
  if (await isDockerDesktop()) {
    current = { ...current, checkedAt: new Date().toISOString(), mode: 'env' }
    return false
  }
  let d: Detected | null
  try {
    d = await readHostNetwork()
  } catch (err) {
    log.warn('Netz des Servers nicht lesbar', { err: String(err) })
    return false
  }
  if (!d || (!d.lanIp && !d.tailscaleIp)) return false

  const before = net.detected()
  const next: NetRuntime = { lanIp: d.lanIp, lanCidr: d.lanCidr, tailscaleIp: d.tailscaleIp }
  current = { ...d, checkedAt: new Date().toISOString(), mode: 'detected' }
  const changed = before.lanIp !== next.lanIp || before.lanCidr !== next.lanCidr || before.tailscaleIp !== next.tailscaleIp
  setNetRuntime(next)

  // Gegen den letzten gespeicherten Stand vergleichen: so fällt eine
  // Änderung auch über einen Neustart hinweg auf (Audit, Log)
  const last = await getSetting(KEY).catch(() => null)
  const stored = JSON.stringify(next)
  if (last !== stored) {
    await setSetting(KEY, stored)
    if (last) {
      const prev = JSON.parse(last) as NetRuntime
      log.info('Netz des Servers geändert', { vorher: prev, jetzt: next })
      await audit({ actor, action: 'network.change', targetType: 'system', targetId: 'network', params: { before: prev, after: next }, result: 'ok' })
    }
  }
  if (changed && o.reconcile !== false) {
    const { rehostRoutes, reconcileCaddy } = await import('./routes.js')
    const moved = await rehostRoutes()
    await reconcileCaddy()
    log.info('Adressen und Caddy-Filter nachgezogen', { moved, lanCidr: net.lanCidr() })
  }
  return changed
}

/** Beim Start (vor dem ersten Caddy-Abgleich) und dann stündlich. */
export async function startNetworkWatch(): Promise<void> {
  // Letzter bekannter Stand zuerst: scheitert die Prüfung gleich, gelten nicht die alten .env-Werte
  const last = await getSetting(KEY).catch(() => null)
  if (last) {
    try {
      setNetRuntime(JSON.parse(last) as NetRuntime)
    } catch { /* kaputter Eintrag: neu erkennen */ }
  }
  await checkNetwork('system', { reconcile: false }).catch((err) => log.warn('Netzprüfung beim Start fehlgeschlagen', { err: String(err) }))
  setInterval(() => void checkNetwork().catch((err) => log.warn('Netzprüfung fehlgeschlagen', { err: String(err) })), HOUR).unref()
}

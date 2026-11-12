import { docker } from './docker.js'
import { toForeign, type ForeignContainer, type RawContainer } from '../lib/external.js'

/**
 * Bestehender Dienst: fremde Container NUR LESEN (GET /containers/json über
 * den Socket-Proxy). Airlock setzt an fremden Containern nichts – keine
 * Labels, kein Start/Stopp, keine Änderung. Das Einzige, was Airlock
 * verändert, ist Caddys eigene Netz-Mitgliedschaft (docker.connectToNetwork
 * mit Caddy als Container).
 */
export async function listForeignContainers(): Promise<ForeignContainer[]> {
  const raw = (await docker.listContainers({ all: true })) as unknown as RawContainer[]
  return raw.map(toForeign)
}

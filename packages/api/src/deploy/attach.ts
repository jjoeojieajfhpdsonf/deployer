import { config } from '../config.js'
import * as docker from '../drivers/docker.js'

/**
 * Hängt Airlock kurz in ein Projekt-Netz (Healthcheck, Header-Check)
 * und löst ihn danach wieder. Gezählt pro Netz: Laufen ein Healthcheck und
 * ein Scan gleichzeitig, darf das Ende des einen dem anderen die Verbindung
 * nicht wegziehen. Getrennt wird erst, wenn niemand sie mehr braucht.
 *
 * Zählen, Verbinden und Trennen laufen pro Netz strikt nacheinander in einer
 * Warteschlange. Der Zähler steigt erst nach einem erfolgreichen Verbinden;
 * scheitert es, bleibt er unverändert (Review M6: vorher blieb er hängen,
 * und alle späteren Aufrufe liefen ohne Verbindung).
 */

export interface NetOps {
  connect(network: string): Promise<void>
  disconnect(network: string): Promise<void>
}

const dockerOps: NetOps = {
  connect: (n) => docker.connectToNetwork(n, config.AIRLOCK_CONTAINER),
  disconnect: (n) => docker.disconnectFromNetwork(n, config.AIRLOCK_CONTAINER),
}

export function createNetworkAttacher(ops: NetOps) {
  const state = new Map<string, { users: number; chain: Promise<unknown> }>()

  const serial = <T>(network: string, op: () => Promise<T>): Promise<T> => {
    const s = state.get(network) ?? { users: 0, chain: Promise.resolve() }
    state.set(network, s)
    const next = s.chain.then(op, op)
    s.chain = next.catch(() => {})
    return next
  }

  const acquire = (network: string) =>
    serial(network, async () => {
      const s = state.get(network)!
      if (s.users === 0) await ops.connect(network)
      s.users++
    })

  const release = (network: string) =>
    serial(network, async () => {
      const s = state.get(network)!
      s.users = Math.max(0, s.users - 1)
      if (s.users === 0) await ops.disconnect(network).catch(() => {})
    })

  return {
    async with<T>(network: string, fn: () => Promise<T>): Promise<T> {
      await acquire(network)
      try {
        return await fn()
      } finally {
        await release(network)
      }
    },
    users: (network: string) => state.get(network)?.users ?? 0,
  }
}

const attacher = createNetworkAttacher(dockerOps)

export function withProjectNetwork<T>(network: string, fn: () => Promise<T>): Promise<T> {
  return attacher.with(network, fn)
}

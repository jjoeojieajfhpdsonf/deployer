import { lookup } from 'node:dns/promises'
import { config } from '../config.js'
import * as docker from '../drivers/docker.js'
import type { RepoUrlPolicy } from '../lib/repo-url.js'

/**
 * Welche Ziele eine Repo-URL nicht haben darf: die Dienste des eigenen
 * Stacks, nach Name und nach Netz.
 */

/** Die festen Netznamen aus compose.yaml (dort per `name:` gesetzt). */
const STACK_NETWORKS = ['airlock_internal', 'airlock_edge', 'airlock_tunnel']

let cached: { at: number; cidrs: string[] } | null = null

async function stackCidrs(): Promise<string[]> {
  if (cached && Date.now() - cached.at < 60_000) return cached.cidrs
  const all = (await Promise.all(STACK_NETWORKS.map((n) => docker.networkSubnets(n)))).flat()
  cached = { at: Date.now(), cidrs: all }
  return all
}

export async function repoUrlPolicy(): Promise<RepoUrlPolicy> {
  return {
    deniedHosts: [
      'postgres', 'socket-proxy', 'caddy', 'airlock', 'deployer',
      'airlock-postgres', 'airlock-socket-proxy', 'airlock-cloudflared',
      config.AIRLOCK_CONTAINER, config.CADDY_CONTAINER,
      config.AIRLOCK_UPSTREAM.split(':')[0] ?? '',
    ].filter(Boolean),
    deniedCidrs: await stackCidrs(),
    resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
  }
}

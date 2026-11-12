/**
 * Etappe 4: eigene interne Adressen für Dienste mit Oberfläche
 * (x-airlock-internal in compose.yaml, z. B. Adminer, Mailpit, Admin-API von Garage).
 *
 * Regeln:
 *   - Name <dienst>--<projekt> unter der internen Basis der Umgebung (das
 *     Wildcard-Zertifikat *.int.<basis> deckt ihn ab).
 *   - Nur über die internen Wege, über die das Projekt selbst erreichbar ist
 *     (LAN und/oder Tailnet). Ein Projekt ohne internen Weg bekommt auch für
 *     seine Dienste keine Adresse. Nie öffentlich – auch nicht, wenn das
 *     Projekt öffentlich ist (der Tunnel kennt diese Namen nicht, und die
 *     Quell-Bereiche sind nie die von cloudflared).
 *   - Ein pausiertes oder gestopptes Projekt: keine Adresse.
 *
 * Rein (ohne config.ts), damit testbar.
 */

export interface InternalRouteRow {
  projectId: string
  slug: string
  target: string
  paused: boolean
  sourceType: string
  deploymentId: string | null
  internalRoutes: { service: string; port: number }[]
}

export interface InternalServiceRoute {
  projectId: string
  service: string
  hostname: string
  /** Wege (nur lan/tailnet) */
  targets: ('lan' | 'tailnet')[]
  /** Container im Projekt-Netz und Port */
  upstream: string
}

export const internalServiceLabel = (service: string, slug: string): string => `${service}--${slug}`

/** Ein DNS-Label hat höchstens 63 Zeichen; längere Namen bekommen keine Adresse */
const LABEL_MAX = 63

export function internalServiceRoutes(rows: InternalRouteRow[], o: {
  hostFor: (projectId: string, label: string) => string
  /** Compose-Container eines Dienstes, z. B. air_shop-adminer-1 */
  containerFor: (slug: string, service: string) => string
  /** Namen, die schon ein Projekt (oder die Oberfläche) belegt */
  taken: Set<string>
}): InternalServiceRoute[] {
  const byProject = new Map<string, { slug: string; targets: Set<'lan' | 'tailnet'>; routes: { service: string; port: number }[]; ok: boolean }>()
  for (const r of rows) {
    const e = byProject.get(r.projectId) ?? { slug: r.slug, targets: new Set(), routes: [], ok: false }
    if ((r.target === 'lan' || r.target === 'tailnet') && !r.paused) e.targets.add(r.target)
    if (r.sourceType === 'compose' && r.deploymentId && !r.paused && r.internalRoutes.length) {
      e.ok = true
      e.routes = r.internalRoutes
    }
    byProject.set(r.projectId, e)
  }
  const out: InternalServiceRoute[] = []
  for (const [projectId, e] of byProject) {
    if (!e.ok || e.targets.size === 0) continue
    for (const ir of e.routes) {
      const label = internalServiceLabel(ir.service, e.slug)
      if (label.length > LABEL_MAX || !/^[a-z0-9-]+$/.test(label)) continue
      const hostname = o.hostFor(projectId, label)
      if (o.taken.has(hostname)) continue
      out.push({
        projectId, service: ir.service, hostname,
        targets: [...e.targets].sort() as ('lan' | 'tailnet')[],
        upstream: `${o.containerFor(e.slug, ir.service)}:${ir.port}`,
      })
    }
  }
  return out
}

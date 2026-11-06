/**
 * Reiner Konfigurationsbau fuer Caddy. Bewusst OHNE Import von config.ts,
 * damit die Funktion ohne gesetzte Umgebung testbar bleibt.
 */

export const adminAddress = (socketPath: string) => `unix/${socketPath}`

export interface RouteSpec {
  /** Kanonischer Hostname zuerst, danach Aliase (nip.io). */
  hosts: string[]
  kind: 'proxy' | 'files'
  /** Bei kind=proxy: "container:port" */
  upstream?: string
  /** Bei kind=files: Verzeichnis im sites-Volume */
  root?: string
}

export interface CaddyBuildOptions {
  ipFilter: boolean
  /** Erlaubte Quell-Bereiche, wenn ipFilter aktiv ist. */
  cidrs: string[]
  adminSocket: string
}

type Handler = Record<string, unknown> & { handler: string }
type HttpRoute = {
  /** Fehlt bei der Auffangroute: eine Route ohne Matcher trifft auf alles. */
  match?: HostMatch[]
  handle: Handler[]
  terminal: boolean
}

export type HostMatch = { host: string[]; remote_ip?: { ranges: string[] } }

/**
 * Routen -> vollstaendige Caddy-JSON-Konfiguration.
 *
 * Der admin-Block ist IMMER enthalten. Fehlte er, fiele Caddy beim naechsten
 * /load auf den Standard TCP :2019 zurueck - und waere damit aus jedem
 * Projekt-Netz erreichbar, in das Caddy gehaengt wird. Genau das Loch, das
 * der Unix-Socket schliesst.
 */
export function buildCaddyConfig(
  routes: RouteSpec[],
  opts: CaddyBuildOptions,
): Record<string, unknown> {
  const httpRoutes: HttpRoute[] = routes.map((r) => {
    const match: HostMatch = { host: r.hosts }
    if (opts.ipFilter) match.remote_ip = { ranges: opts.cidrs }

    const handle: Handler[] =
      r.kind === 'proxy'
        ? [{ handler: 'reverse_proxy', upstreams: [{ dial: r.upstream }] }]
        : [
            { handler: 'vars', root: r.root },
            { handler: 'file_server', index_names: ['index.html'] },
          ]

    return { match: [match], handle, terminal: true }
  })

  // Auffangroute: Wer den IP-Filter nicht passiert oder einen unbekannten
  // Hostnamen anfragt, bekommt eine klare Antwort statt irgendeiner anderen.
  // Bewusst OHNE Matcher – ein host-Matcher "*" trifft in Caddy nicht auf
  // alles, die Anfrage fiele dann auf eine leere 200 durch.
  httpRoutes.push({
    handle: [
      {
        handler: 'static_response',
        status_code: 404,
        body: 'Kein Projekt unter diesem Namen, oder Zugriff nicht aus LAN/Tailnet.',
      },
    ],
    terminal: true,
  })

  return {
    admin: { listen: adminAddress(opts.adminSocket) },
    logging: { logs: { default: { level: 'INFO' } } },
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [':80'],
            routes: httpRoutes,
            // Kein TLS in M1 (Entscheidung: Zertifikate ab M4).
            automatic_https: { disable: true },
          },
        },
      },
    },
  }
}

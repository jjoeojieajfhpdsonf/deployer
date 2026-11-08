import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { DnsRecord, IngressRule } from '../drivers/cloudflare.js'

/**
 * Attrappe der Cloudflare-API für Tests: Zonen, DNS-Einträge,
 * Tunnel-Konfiguration, Access-Anwendungen – alles im Speicher. Prüft das
 * Bearer-Token, damit Tests auch den Fehlerfall sehen.
 */
export interface FakeCloudflare {
  url: string
  token: string
  zones: { id: string; name: string }[]
  records: Map<string, (DnsRecord & { zoneId: string })>
  ingress: IngressRule[]
  apps: { id: string; name: string; domain: string; policies: unknown }[]
  tunnel: { status: string; connections: unknown[] }
  /** Rechte des Tokens: zone_read, dns_edit, tunnel_edit, access_edit (Standard: alle) */
  perms: Set<string>
  tunnels: { id: string; name: string }[]
  calls: { method: string; path: string }[]
  close(): Promise<void>
}

export async function startFakeCloudflare(zones = ['example.ch', 'beispiel.ch'], listen: { host?: string; port?: number } = {}): Promise<FakeCloudflare> {
  const state: Omit<FakeCloudflare, 'url' | 'close'> = {
    token: 'cf-test-token',
    zones: zones.map((name) => ({ id: `zone-${name}`, name })),
    records: new Map(),
    ingress: [{ service: 'http_status:404' }],
    apps: [],
    tunnel: { status: 'healthy', connections: [{}, {}] },
    perms: new Set(['zone_read', 'dns_edit', 'tunnel_edit', 'access_edit']),
    tunnels: [],
    calls: [],
  }

  const ok = (result: unknown) => JSON.stringify({ success: true, errors: [], result })
  const fail = (code: number, message: string) => JSON.stringify({ success: false, errors: [{ code, message }], result: null })

  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x')
      const path = url.pathname.replace(/^\/client\/v4/, '')
      const method = req.method ?? 'GET'
      state.calls.push({ method, path })
      const send = (status: number, body: string) => res.writeHead(status, { 'content-type': 'application/json' }).end(body)
      if (req.headers.authorization !== `Bearer ${state.token}`) return send(403, fail(10000, 'Authentication error'))
      const body = raw ? JSON.parse(raw) : {}
      const page = Number(url.searchParams.get('page') ?? '1')
      let m: RegExpExecArray | null

      const denied = () => send(403, fail(10000, 'Authentication error'))
      if (method === 'GET' && path === '/user/tokens/verify') return send(200, ok({ id: 'tok-1', status: 'active' }))
      if (method === 'GET' && path === '/accounts') return send(200, ok(page === 1 ? [{ id: 'acc-e2e-test', name: 'Joëls Konto' }] : []))
      if (method === 'GET' && path === '/zones') return send(200, ok(page === 1 && state.perms.has('zone_read') ? state.zones : []))
      // Schreibrechte: ohne Recht 403, mit Recht prüft die Attrappe den Inhalt
      if (method !== 'GET' && /\/dns_records/.test(path) && !state.perms.has('dns_edit')) return denied()
      if (method !== 'GET' && /\/cfd_tunnel/.test(path) && !state.perms.has('tunnel_edit')) return denied()
      if (method !== 'GET' && /\/access\/apps/.test(path) && !state.perms.has('access_edit')) return denied()
      if ((m = /^\/accounts\/([^/]+)\/cfd_tunnel$/.exec(path))) {
        if (method === 'POST') {
          if (!body.name || body.config_src !== 'cloudflare') return send(400, fail(1003, 'Invalid tunnel name or config_src'))
          const t = { id: randomUUID(), name: body.name }
          state.tunnels.push(t)
          return send(200, ok(t))
        }
        if (method === 'GET') return send(200, ok(state.tunnels.filter((t) => !url.searchParams.get('name') || t.name === url.searchParams.get('name'))))
      }
      if ((m = /^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)\/token$/.exec(path)) && method === 'GET') {
        // Gültig aufgebaut (Konto, Tunnel, Geheimnis als Base64-JSON), aber erfunden:
        // cloudflared startet damit und versucht es weiter, statt sofort abzubrechen
        const secret = Buffer.from('nur-fuer-tests-kein-echtes-geheimnis!').toString('base64')
        return send(200, ok(Buffer.from(JSON.stringify({ a: 'acc-e2e-test', t: m[1], s: secret })).toString('base64')))
      }
      if ((m = /^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)\/connections$/.exec(path)) && method === 'DELETE') return send(200, ok(null))
      if ((m = /^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)$/.exec(path)) && method === 'DELETE') {
        state.tunnels = state.tunnels.filter((t) => t.id !== m![1])
        return send(200, ok({ id: m[1] }))
      }

      if ((m = /^\/zones\/([^/]+)\/dns_records$/.exec(path))) {
        const zoneId = m[1]!
        if (!state.zones.some((z) => z.id === zoneId)) return send(404, fail(7003, 'Could not route'))
        if (method === 'GET') {
          const name = url.searchParams.get('name')
          const type = url.searchParams.get('type')
          return send(200, ok([...state.records.values()].filter((r) => r.zoneId === zoneId && (!name || r.name === name) && (!type || r.type === type))))
        }
        if (method === 'POST') {
          if (!['A', 'AAAA', 'CNAME', 'TXT'].includes(body.type)) return send(400, fail(9005, 'Content for type is invalid'))
          const dup = [...state.records.values()].find((r) => r.name === body.name && (r.type === 'CNAME' || body.type === 'CNAME'))
          if (dup) return send(400, fail(81053, 'An A, AAAA, or CNAME record with that host already exists.'))
          const r = { id: randomUUID(), zoneId, ...body }
          state.records.set(r.id, r)
          return send(200, ok(r))
        }
      }
      if ((m = /^\/zones\/([^/]+)\/dns_records\/([^/]+)$/.exec(path))) {
        const r = state.records.get(m[2]!)
        if (!r) return send(404, fail(81044, 'Record does not exist.'))
        if (method === 'PUT') {
          const n = { ...body, id: r.id, zoneId: r.zoneId }
          state.records.set(r.id, n)
          return send(200, ok(n))
        }
        if (method === 'DELETE') {
          state.records.delete(r.id)
          return send(200, ok({ id: r.id }))
        }
      }
      if ((m = /^\/accounts\/[^/]+\/cfd_tunnel\/[^/]+\/configurations$/.exec(path))) {
        if (method === 'GET') return send(200, ok({ config: { ingress: state.ingress } }))
        if (method === 'PUT') {
          const ing = body.config?.ingress as IngressRule[] | undefined
          if (!ing?.length || ing[ing.length - 1]!.hostname) return send(400, fail(1056, 'The last ingress rule must match all URLs'))
          state.ingress = ing
          return send(200, ok({ config: { ingress: ing } }))
        }
      }
      if (/^\/accounts\/[^/]+\/cfd_tunnel\/[^/]+$/.exec(path) && method === 'GET') return send(200, ok(state.tunnel))
      if (/^\/accounts\/[^/]+\/access\/apps$/.exec(path)) {
        if (method === 'GET') return send(200, ok(page === 1 ? state.apps : []))
        if (method === 'POST') {
          if (body.type !== 'self_hosted') return send(400, fail(12000, 'invalid app type'))
          const app = { id: randomUUID(), name: body.name, domain: body.domain, policies: body.policies }
          state.apps.push(app)
          return send(200, ok(app))
        }
      }
      if ((m = /^\/accounts\/[^/]+\/access\/apps\/([^/]+)$/.exec(path)) && method === 'DELETE') {
        const i = state.apps.findIndex((a) => a.id === m![1])
        if (i < 0) return send(404, fail(12130, 'not found'))
        state.apps.splice(i, 1)
        return send(200, ok({ id: m[1] }))
      }
      send(404, fail(7000, `No route for ${method} ${path}`))
    })
  })
  await new Promise<void>((r) => server.listen(listen.port ?? 0, listen.host ?? '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return Object.assign(state, {
    url: `http://${listen.host && listen.host !== '0.0.0.0' ? listen.host : '127.0.0.1'}:${port}/client/v4`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  })
}

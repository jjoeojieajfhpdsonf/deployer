/**
 * Schlanker Client für die Cloudflare-API v4 (M4/M5).
 *
 * Bewusst über fetch statt des SDK: wenige Endpunkte, keine zusätzliche
 * Abhängigkeit, und in Tests gegen einen Attrappen-Server austauschbar.
 * Kein Import von config.ts – Basis-URL und Token kommen von aussen.
 *
 * Das Token erscheint nie in Fehlermeldungen oder Logs.
 */

export const MANAGED_COMMENT = 'managed by deployer'

export interface CfOptions {
  token: string
  base?: string
  fetch?: typeof fetch
}

export class CloudflareError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message)
  }
}

export interface Zone { id: string; name: string; status?: string }
export interface DnsRecord {
  id: string
  type: string
  name: string
  content: string
  proxied?: boolean
  comment?: string | null
  ttl?: number
}
export interface IngressRule { hostname?: string; service: string; path?: string; originRequest?: Record<string, unknown> }

export class Cloudflare {
  private readonly base: string
  private readonly f: typeof fetch

  constructor(private readonly o: CfOptions) {
    this.base = (o.base ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '')
    this.f = o.fetch ?? fetch
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await this.f(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.o.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (err) {
      throw new CloudflareError(`Cloudflare nicht erreichbar: ${(err as Error).message}`, 0)
    }
    const text = await res.text()
    let data: { success?: boolean; result?: T; errors?: { code: number; message: string }[]; result_info?: { total_pages?: number } } = {}
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      /* kein JSON */
    }
    if (!res.ok || data.success === false) {
      const e = data.errors?.[0]
      const msg = e ? `${e.message} (Code ${e.code})` : `HTTP ${res.status}`
      throw new CloudflareError(`Cloudflare: ${msg.replaceAll(this.o.token, '***')}`, res.status, e?.code)
    }
    return data.result as T
  }

  /** Alle Seiten einer Liste. */
  private async all<T>(path: string): Promise<T[]> {
    const out: T[] = []
    for (let page = 1; page <= 50; page++) {
      const sep = path.includes('?') ? '&' : '?'
      const res = await this.req<T[]>('GET', `${path}${sep}per_page=100&page=${page}`)
      out.push(...res)
      if (res.length < 100) break
    }
    return out
  }

  /* --- Token und Konten (Cloudflare verbinden) -------------------------------- */

  /** Status des Tokens: «active», «disabled», «expired». Wirft bei ungültigem Token. */
  async verifyToken(): Promise<{ id: string; status: string; expiresOn: string | null }> {
    const r = await this.req<{ id: string; status: string; expires_on?: string }>('GET', '/user/tokens/verify')
    return { id: r.id, status: r.status, expiresOn: r.expires_on ?? null }
  }

  listAccounts(): Promise<{ id: string; name: string }[]> {
    return this.all<{ id: string; name: string }>('/accounts')
  }

  /**
   * Darf das Token schreiben? Geschickt wird eine absichtlich ungültige
   * Anfrage: Mit dem Recht antwortet Cloudflare mit einem Prüffehler (400),
   * ohne mit «Authentication error» (403). Angelegt wird so nie etwas.
   */
  async probeWrite(method: 'POST' | 'PUT', path: string, invalidBody: unknown): Promise<'allowed' | 'denied' | 'unknown'> {
    try {
      await this.req(method, path, invalidBody)
      return 'allowed'
    } catch (err) {
      if (!(err instanceof CloudflareError)) return 'unknown'
      if (err.status === 401 || err.status === 403 || err.code === 10000 || err.code === 9109) return 'denied'
      if (err.status === 400 || err.status === 409 || err.status === 422) return 'allowed'
      return 'unknown'
    }
  }

  /* --- Zonen ------------------------------------------------------------------ */

  listZones(): Promise<Zone[]> {
    return this.all<Zone>('/zones')
  }

  /* --- DNS ------------------------------------------------------------------ */

  listRecords(zoneId: string, name: string, type?: string): Promise<DnsRecord[]> {
    const q = new URLSearchParams({ name, ...(type ? { type } : {}) })
    return this.req<DnsRecord[]>('GET', `/zones/${zoneId}/dns_records?${q}`)
  }

  createRecord(zoneId: string, r: Omit<DnsRecord, 'id'>): Promise<DnsRecord> {
    return this.req<DnsRecord>('POST', `/zones/${zoneId}/dns_records`, { ttl: 1, ...r })
  }

  updateRecord(zoneId: string, id: string, r: Omit<DnsRecord, 'id'>): Promise<DnsRecord> {
    return this.req<DnsRecord>('PUT', `/zones/${zoneId}/dns_records/${id}`, { ttl: 1, ...r })
  }

  async deleteRecord(zoneId: string, id: string): Promise<void> {
    try {
      await this.req('DELETE', `/zones/${zoneId}/dns_records/${id}`)
    } catch (err) {
      if (err instanceof CloudflareError && err.status === 404) return
      throw err
    }
  }

  /* --- Tunnel (M5) ---------------------------------------------------------- */

  async getTunnelIngress(accountId: string, tunnelId: string): Promise<IngressRule[]> {
    const r = await this.req<{ config?: { ingress?: IngressRule[] } }>('GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`)
    return r?.config?.ingress ?? []
  }

  async putTunnelIngress(accountId: string, tunnelId: string, ingress: IngressRule[]): Promise<void> {
    await this.req('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, { config: { ingress } })
  }

  /** Remote verwalteter Tunnel (Konfiguration über die API). */
  createTunnel(accountId: string, name: string): Promise<{ id: string; name: string }> {
    return this.req('POST', `/accounts/${accountId}/cfd_tunnel`, { name, config_src: 'cloudflare' })
  }

  async findTunnel(accountId: string, name: string): Promise<{ id: string; name: string } | null> {
    const q = new URLSearchParams({ name, is_deleted: 'false' })
    const list = await this.req<{ id: string; name: string }[]>('GET', `/accounts/${accountId}/cfd_tunnel?${q}`)
    return list.find((t) => t.name === name) ?? null
  }

  /** Token, mit dem cloudflared sich als dieser Tunnel anmeldet. */
  tunnelToken(accountId: string, tunnelId: string): Promise<string> {
    return this.req<string>('GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`)
  }

  async deleteTunnel(accountId: string, tunnelId: string): Promise<void> {
    try {
      // Erst die Verbindungen lösen, sonst lehnt Cloudflare das Löschen ab
      await this.req('DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`).catch(() => {})
      await this.req('DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}`)
    } catch (err) {
      if (err instanceof CloudflareError && err.status === 404) return
      throw err
    }
  }

  async tunnelStatus(accountId: string, tunnelId: string): Promise<{ status: string; connections: number }> {
    const r = await this.req<{ status?: string; connections?: unknown[] }>('GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}`)
    return { status: r?.status ?? 'unknown', connections: r?.connections?.length ?? 0 }
  }

  /* --- Access (M5) ---------------------------------------------------------- */

  listAccessApps(accountId: string): Promise<{ id: string; domain: string; name: string }[]> {
    return this.all(`/accounts/${accountId}/access/apps`)
  }

  createAccessApp(accountId: string, app: { name: string; domain: string; email: string }): Promise<{ id: string }> {
    return this.req('POST', `/accounts/${accountId}/access/apps`, {
      name: app.name,
      domain: app.domain,
      type: 'self_hosted',
      session_duration: '24h',
      policies: [{ name: 'deployer: nur Besitzer', decision: 'allow', include: [{ email: { email: app.email } }] }],
    })
  }

  async deleteAccessApp(accountId: string, id: string): Promise<void> {
    try {
      await this.req('DELETE', `/accounts/${accountId}/access/apps/${id}`)
    } catch (err) {
      if (err instanceof CloudflareError && err.status === 404) return
      throw err
    }
  }
}

/** Längste Zone, auf die der Name endet (int.example.ch -> example.ch). */
export function zoneFor(hostname: string, zones: Zone[]): Zone | null {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  let best: Zone | null = null
  for (const z of zones) {
    const n = z.name.toLowerCase()
    if ((h === n || h.endsWith(`.${n}`)) && (!best || n.length > best.name.length)) best = z
  }
  return best
}

/**
 * Legt einen Eintrag an oder bringt ihn auf den gewünschten Stand.
 * Fremde Einträge (ohne deployer-Kommentar) werden nicht überschrieben.
 */
export async function upsertManagedRecord(
  cf: Cloudflare,
  zoneId: string,
  want: Omit<DnsRecord, 'id' | 'comment'>,
): Promise<{ record: DnsRecord; action: 'created' | 'updated' | 'unchanged' }> {
  const existing = (await cf.listRecords(zoneId, want.name)).filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type))
  const body = { ...want, comment: MANAGED_COMMENT }
  if (existing.length === 0) return { record: await cf.createRecord(zoneId, body), action: 'created' }
  const foreign = existing.find((r) => r.comment !== MANAGED_COMMENT)
  if (foreign) {
    throw new CloudflareError(
      `Für ${want.name} gibt es schon einen DNS-Eintrag (${foreign.type} → ${foreign.content}), der nicht von deployer stammt. Bitte in Cloudflare prüfen und entfernen.`,
      409,
    )
  }
  const r = existing[0]!
  if (r.type === want.type && r.content === want.content && Boolean(r.proxied) === Boolean(want.proxied) && existing.length === 1) {
    return { record: r, action: 'unchanged' }
  }
  for (const extra of existing.slice(1)) await cf.deleteRecord(zoneId, extra.id)
  if (r.type !== want.type) {
    await cf.deleteRecord(zoneId, r.id)
    return { record: await cf.createRecord(zoneId, body), action: 'updated' }
  }
  return { record: await cf.updateRecord(zoneId, r.id, body), action: 'updated' }
}

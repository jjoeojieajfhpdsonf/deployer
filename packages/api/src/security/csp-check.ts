import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { eq } from 'drizzle-orm'
import { Agent, request } from 'undici'
import type { CspAnalysisDto, CspCheckDto } from '@airlock/shared'
import { db, schema } from '../db/index.js'
import { config } from '../config.js'
import * as docker from '../drivers/docker.js'
import { withProjectNetwork } from '../deploy/attach.js'
import { aliasesForHost, probeTargetFor } from '../domain/routes.js'
import { log } from '../lib/log.js'
import { probeUa } from '../lib/probe-ua.js'
import { runScanner, SCANNER_IMAGES } from './runner.js'
import { analyzeHtml, mergeAnalyses, parseChromeCsp, countPageViews, CHROME_SCRIPT, type PageAnalysis } from './csp-analysis.js'

/**
 * CSP-Fix: was eine CSP auf den echten Seiten anrichten würde – vor dem
 * Vorschlag (Analyse des HTML), vor dem Scharfschalten (Aufrufe im
 * Report-Only) und danach (Funktionsprüfung im Headless-Browser).
 *
 * Alles geht über Caddys Probe-Socket: dieselben Seiten und Header wie für
 * Besucher, ohne den IP-Filter für Airlock zu öffnen.
 */

const MAX_PAGES = 5
const MAX_HTML = 1024 * 1024

type Fetched = { status: number; headers: Record<string, string | string[]>; body: Buffer }

/** Über den Probe-Socket holen (Host aus dem Namen des Projekts). */
async function viaProbe(host: string, path: string, method: 'GET' | 'HEAD' = 'GET'): Promise<Fetched> {
  const agent = new Agent({ keepAliveTimeout: 1, pipelining: 0, connect: { socketPath: config.CADDY_PROBE_SOCKET } })
  try {
    const res = await request(`http://${host}${path}`, { method, headersTimeout: 10_000, bodyTimeout: 10_000, dispatcher: agent, headers: { connection: 'close', 'user-agent': probeUa('csp') } })
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of res.body) {
      size += (c as Buffer).length
      if (size > MAX_HTML * 4) break
      chunks.push(c as Buffer)
    }
    const headers: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = v as string | string[]
    return { status: res.statusCode, headers, body: Buffer.concat(chunks) }
  } finally {
    await agent.close().catch(() => {})
  }
}

/** Namen eines Projekts (alle Ziele, mit nip.io-Aliasen) – für Proxy und Zählung. */
export async function projectHosts(projectId: string): Promise<string[]> {
  const rows = await db.select({ hostname: schema.routes.hostname, target: schema.routes.target }).from(schema.routes).where(eq(schema.routes.projectId, projectId))
  return [...new Set(rows.flatMap((r) => (r.target === 'public' ? [r.hostname] : [r.hostname, ...aliasesForHost(r.hostname)])))]
}

const cache = new Map<string, { at: number; value: Omit<CspAnalysisDto, 'conflicts'> & { pageUrls: string[] } }>()

/**
 * Startseite und bis zu vier weitere Seiten derselben Herkunft lesen.
 * Ergebnis 60 s im Speicher (die Oberfläche fragt oft).
 */
export async function analyzeProjectPages(projectId: string, o: { fresh?: boolean } = {}): Promise<Omit<CspAnalysisDto, 'conflicts'> & { pageUrls: string[] }> {
  const hit = cache.get(projectId)
  if (!o.fresh && hit && Date.now() - hit.at < 60_000) return hit.value
  const empty = { pages: [], pageUrls: [], inlineScripts: 0, inlineStyles: 0, styleAttributes: 0, eventHandlers: 0, external: {} }
  const probe = await probeTargetFor(projectId)
  if (!probe) return { ...empty, error: 'Caddy bedient das Projekt gerade nicht' }
  const pages: PageAnalysis[] = []
  const queue = ['/']
  const seen = new Set<string>()
  try {
    while (queue.length && pages.length < MAX_PAGES) {
      const path = queue.shift()!
      if (seen.has(path)) continue
      seen.add(path)
      const r = await viaProbe(probe.host, path)
      const type = String(r.headers['content-type'] ?? '')
      if (r.status >= 400 || !/text\/html|application\/xhtml/i.test(type)) continue
      const a = analyzeHtml(r.body.subarray(0, MAX_HTML).toString('utf8'), `${probe.secure ? 'https' : 'http'}://${probe.host}${path}`)
      pages.push(a)
      for (const l of a.links) if (!seen.has(l)) queue.push(l)
    }
  } catch (err) {
    return { ...empty, error: `Seiten nicht lesbar: ${(err as Error).message.slice(0, 160)}` }
  }
  const value = {
    ...mergeAnalyses(pages),
    pageUrls: pages.map((p) => `http://${probe.host}${p.path}`),
    error: pages.length ? null : 'Keine HTML-Seite gefunden (Startseite liefert kein HTML)',
  }
  cache.set(projectId, { at: Date.now(), value })
  return value
}

/** Aufrufe seit Beginn von Report-Only, aus Caddys Zugriffs-Log. null: nicht lesbar. */
export async function viewsSince(projectId: string, since: Date): Promise<number | null> {
  try {
    const logs = await docker.getLogs(config.CADDY_CONTAINER, { since: Math.floor(since.getTime() / 1000), tail: 50_000 })
    return countPageViews(logs, { hosts: await projectHosts(projectId), sinceMs: since.getTime() })
  } catch (err) {
    log.warn('Caddy-Log für CSP-Aufrufe nicht lesbar', { err: String(err) })
    return null
  }
}

/* --- Funktionsprüfung -------------------------------------------------------------- */

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'proxy-connection', 'upgrade', 'te', 'trailer'])

/**
 * Kleiner HTTP-Proxy in Airlock, im Netz des Projekts: der Browser im
 * Scanner-Container fragt darüber, Airlock holt die Antwort über den
 * Probe-Socket – mit Caddys Headern, wie für Besucher. Nur GET/HEAD und nur
 * die Namen dieses Projekts; alles andere 403. Lebt nur für die Prüfung.
 */
async function withProbeProxy<T>(network: string, hosts: Set<string>, fn: (proxy: string) => Promise<T>): Promise<T> {
  return withProjectNetwork(network, async () => {
    const ip = await docker.containerIp(config.AIRLOCK_CONTAINER, network)
    if (!ip) throw new Error('Airlock hat keine Adresse im Netz des Projekts')
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        try {
          const u = new URL(req.url ?? '/', 'http://invalid')
          if ((req.method !== 'GET' && req.method !== 'HEAD') || !hosts.has(u.hostname.toLowerCase())) {
            res.writeHead(403).end()
            return
          }
          const r = await viaProbe(u.hostname, `${u.pathname}${u.search}`, req.method)
          const headers: Record<string, string | string[]> = {}
          for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) headers[k] = v
          headers['content-length'] = String(r.body.length)
          res.writeHead(r.status, headers).end(req.method === 'HEAD' ? undefined : r.body)
        } catch {
          res.writeHead(502).end()
        }
      })()
    })
    await new Promise<void>((resolve, reject) => server.listen(0, ip, resolve).once('error', reject))
    const port = (server.address() as { port: number }).port
    try {
      return await fn(`http://${ip}:${port}`)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
}


/**
 * Seiten des Projekts im Headless-Chromium laden und CSP-Verstösse aus der
 * Konsole lesen. Die Header kommen von Caddy (über den Probe-Socket).
 */
export async function browserCheck(projectId: string, slug: string, pageUrls: string[]): Promise<Omit<CspCheckDto, 'at'>> {
  const network = docker.projectNetworkName(slug)
  const hosts = new Set((await projectHosts(projectId)).map((h) => h.toLowerCase()))
  const urls = pageUrls.slice(0, MAX_PAGES)
  if (!urls.length) return { state: 'unavailable', pages: [], violations: [], message: 'Keine Seite zum Prüfen gefunden.' }
  try {
    await docker.ensureNetwork(network)
    const r = await withProbeProxy(network, hosts, (proxy) => runScanner({
      name: `air_csp_check_${slug}`.slice(0, 60),
      image: SCANNER_IMAGES.chrome,
      network,
      entrypoint: ['sh', '-c'],
      cmd: [CHROME_SCRIPT],
      // Adressen über die Umgebung, nicht in den Befehl: nichts zum Einschleusen
      env: { CHECK_URLS: urls.join(' '), CHECK_PROXY: proxy },
      reportPath: '/tmp/chrome.log',
      labels: { [docker.LABEL_PROJECT]: slug, 'airlock.check': 'csp' },
      timeoutMs: 120_000,
      memoryMb: 1024,
    }))
    const text = r.report?.toString('utf8') ?? ''
    if (!text.includes('### PAGE')) {
      return { state: 'unavailable', pages: [], violations: [], message: `Browser lieferte kein Ergebnis (Code ${r.exitCode}).` }
    }
    const parsed = parseChromeCsp(text)
    return parsed.violations.length
      ? { state: 'failed', ...parsed, message: `${parsed.violations.length === 1 ? '1 Verstoss' : `${parsed.violations.length} Verstösse`} beim Laden im Browser.` }
      : { state: 'ok', ...parsed, message: `Funktionsprüfung bestanden: ${parsed.pages.length === 1 ? '1 Seite' : `${parsed.pages.length} Seiten`} ohne CSP-Verstoss geladen.` }
  } catch (err) {
    log.warn('CSP-Funktionsprüfung nicht möglich', { project: slug, err: String(err) })
    return { state: 'unavailable', pages: [], violations: [], message: `Funktionsprüfung nicht möglich: ${(err as Error).message.slice(0, 160)}` }
  }
}

import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { request, Agent } from 'undici'
import { config } from '../config.js'
import * as docker from '../drivers/docker.js'
import { packDir } from '../deploy/workdir.js'
import { withProjectNetwork } from '../deploy/attach.js'
import { runScanner, singleFileTar, SCANNER_IMAGES, SCANNER_CACHES } from './runner.js'
import { parseTrivy, parseZap, parseNuclei, parseTestssl } from './parsers.js'
import { checkHeaders } from './headers.js'
import type { FindingInput } from './score.js'

/**
 * Die einzelnen Scan-Stufen. Jede liefert Befunde oder wirft; der Aufrufer
 * (scan.ts) hält Fehler pro Stufe fest und macht mit der nächsten weiter.
 */

export interface ScanTarget {
  /** URL, gegen die Laufzeit- und Expositions-Scanner gehen. */
  url: string
  /** Netz, in dem Scanner laufen: das Projekt-Netz oder dep_ext-scan. */
  network: string
  host: string
  isHttps: boolean
  external: boolean
}

const short = (id: string) => id.replace(/-/g, '').slice(0, 10)
const scanDir = (scanId: string) => join(config.DATA_DIR, 'scan', scanId)

/* --- Stufe 1: Trivy ---------------------------------------------------------- */

export async function trivyImage(scanId: string, imageRef: string, network: string, labels: Record<string, string>): Promise<FindingInput[]> {
  // Image als Tar auf die Platte (die Grösse muss für den Tar-Kopf bekannt sein),
  // dann in den Trivy-Container. Kein Docker-Socket für den Scanner.
  const dir = scanDir(scanId)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'image.tar')
  try {
    await pipeline(await docker.exportImage(imageRef), createWriteStream(file))
    const { size } = await stat(file)
    const r = await runScanner({
      name: `dep_scan_trivyimg_${short(scanId)}`,
      image: SCANNER_IMAGES.trivy,
      network,
      cmd: ['image', '--quiet', '--format', 'json', '--ignore-unfixed', '--scanners', 'vuln,secret,misconfig', '--input', '/scan/image.tar', '--output', '/scan/out.json'],
      inputs: [{ tar: singleFileTar('scan/image.tar', size, createReadStream(file)), path: '/' }],
      reportPath: '/scan/out.json',
      cache: { volume: SCANNER_CACHES.trivy, target: '/root/.cache' },
      labels,
      timeoutMs: 15 * 60_000,
      memoryMb: 2048,
    })
    if (!r.report) throw new Error(`Trivy lieferte keinen Bericht (Code ${r.exitCode}): ${r.logs.slice(-300)}`)
    return parseTrivy(JSON.parse(r.report.toString('utf8')))
  } finally {
    await rm(file, { force: true })
  }
}

export async function trivySource(scanId: string, srcDir: string, network: string, labels: Record<string, string>): Promise<FindingInput[]> {
  const r = await runScanner({
    name: `dep_scan_trivysrc_${short(scanId)}`,
    image: SCANNER_IMAGES.trivy,
    network,
    cmd: ['fs', '--quiet', '--format', 'json', '--scanners', 'secret,misconfig', '--output', '/scan/out.json', '/scan/src'],
    inputs: [{ tar: await packDir(srcDir, { prefix: 'scan/src', exclude: ['node_modules'] }), path: '/' }],
    reportPath: '/scan/out.json',
    cache: { volume: SCANNER_CACHES.trivy, target: '/root/.cache' },
    labels,
    timeoutMs: 10 * 60_000,
  })
  if (!r.report) throw new Error(`Trivy lieferte keinen Bericht (Code ${r.exitCode}): ${r.logs.slice(-300)}`)
  return parseTrivy(JSON.parse(r.report.toString('utf8')))
}

/* --- Stufe 2: Header ------------------------------------------------------------ */

async function fetchForHeaders(url: string, isHttps: boolean, socketPath?: string) {
  // Eigener Agent ohne Keep-Alive: Der Healthcheck des Deploys hat dieselbe
  // Adresse gerade angefragt, und seine Verbindung im globalen Pool ist tot,
  // seit der deployer das Projekt-Netz verlassen hat. Wiederverwendet hiesse
  // das: Anfrage ins Leere, Zeitüberschreitung (gefunden in der M6-Abnahme).
  // M8: mit socketPath über Caddys Probe-Server (Host aus der URL).
  const agent = new Agent({ keepAliveTimeout: 1, pipelining: 0, ...(socketPath ? { connect: { socketPath } } : {}) })
  let body = ''
  let res: Awaited<ReturnType<typeof request>>
  try {
    res = await request(url, { method: 'GET', headersTimeout: 10_000, bodyTimeout: 10_000, dispatcher: agent, headers: { connection: 'close' } })
    for await (const chunk of res.body) {
      body += (chunk as Buffer).toString('utf8')
      if (body.length > 1024 * 1024) break
    }
  } finally {
    await agent.close().catch(() => {})
  }
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = v as string | string[]
  return checkHeaders({ url, status: res.statusCode, headers, body, isHttps })
}

/**
 * M8: Header-Check über Caddy, so wie Besucher die Seite sehen – inklusive
 * der Header, die Caddy ergänzt. Gefragt wird über den Probe-Socket (eigener
 * Caddy-Server ohne IP-Filter, nur als Datei im gemeinsamen Volume
 * erreichbar). `url` ist die Adresse, die Besucher benutzen; über den Socket
 * geht nur HTTP, das Schema bestimmt isHttps (HSTS, Secure-Cookies).
 */
export async function headerCheckViaCaddy(url: string, isHttps: boolean): Promise<FindingInput[]> {
  const u = new URL(url)
  const viaSocket = `http://${u.host}${u.pathname}`
  const found = await fetchForHeaders(viaSocket, isHttps, config.CADDY_PROBE_SOCKET)
  return found.map((f) => ({ ...f, location: f.location === viaSocket ? url : f.location }))
}

export async function headerCheck(t: ScanTarget): Promise<FindingInput[]> {
  if (t.external) return fetchForHeaders(t.url, t.isHttps)
  // Intern: der deployer hängt sich (gezählt) ins Projekt-Netz.
  return withProjectNetwork(t.network, () => fetchForHeaders(t.url, t.isHttps))
}

/* --- Stufe 2: ZAP ------------------------------------------------------------------ */

export async function zap(scanId: string, t: ScanTarget, labels: Record<string, string>, active: boolean): Promise<FindingInput[]> {
  const script = active ? 'zap-full-scan.py' : 'zap-baseline.py'
  // Externe Ziele: ein Thread, Pause zwischen Anfragen (Grenze ~5 pro Sekunde).
  const zOpts = t.external
    ? '-silent -config spider.thread=1 -config scanner.threadPerHost=1 -config scanner.delayInMs=200'
    : '-silent'
  // Die URL kommt über die Umgebung, nicht in den Shell-Befehl: nichts zum Einschleusen.
  const r = await runScanner({
    name: `dep_scan_zap_${short(scanId)}`,
    image: SCANNER_IMAGES.zap,
    network: t.network,
    entrypoint: ['sh', '-c'],
    cmd: [`mkdir -p /zap/wrk && cd /zap/wrk && ${script} -t "$ZAP_TARGET" -J report.json -m ${active ? 3 : 1} -I -z "${zOpts}" >/zap/wrk/zap.log 2>&1; exit 0`],
    env: { ZAP_TARGET: t.url },
    reportPath: '/zap/wrk/report.json',
    labels,
    timeoutMs: active ? 45 * 60_000 : 15 * 60_000,
    memoryMb: 2048,
  })
  if (!r.report) throw new Error(`ZAP lieferte keinen Bericht${r.timedOut ? ' (Zeitlimit)' : ''}`)
  return parseZap(JSON.parse(r.report.toString('utf8')), t.url)
}

/* --- Stufe 3: Nuclei -------------------------------------------------------------- */

export async function nuclei(scanId: string, t: ScanTarget, labels: Record<string, string>): Promise<FindingInput[]> {
  // Vorlagen liegen im Cache-Volume. "-duc" verhindert auch das automatische
  // Herunterladen beim ersten Lauf – ohne Vorlagen bricht Nuclei mit "no
  // templates provided" ab, und der Scan prüfte nichts (gefunden in der
  // Abnahme). Deshalb: fehlen sie oder sind sie älter als 7 Tage, erst laden.
  const rl = t.external ? '5' : '50'
  const r = await runScanner({
    name: `dep_scan_nuclei_${short(scanId)}`,
    image: SCANNER_IMAGES.nuclei,
    network: t.network,
    entrypoint: ['sh', '-c'],
    cmd: [
      'if [ -z "$(find /root/nuclei-templates -maxdepth 0 -mtime -7 2>/dev/null)" ]; then nuclei -ut -silent || exit 3; fi; ' +
      // Nur nicht-invasive Vorlagen (SPEC). Die URL kommt über die Umgebung.
      `nuclei -u "$NUCLEI_TARGET" -tags exposure,config,misconfig,panel,default-login -etags intrusive,dos,fuzz,bruteforce -jsonl -o /tmp/r.jsonl -silent -nc -duc -rl ${rl}`,
    ],
    env: { NUCLEI_TARGET: t.url },
    reportPath: '/tmp/r.jsonl',
    cache: { volume: SCANNER_CACHES.nuclei, target: '/root' },
    labels,
    timeoutMs: 15 * 60_000,
  })
  if (r.timedOut) throw new Error('Nuclei: Zeitlimit')
  if (r.exitCode === 3) throw new Error(`Nuclei-Vorlagen nicht ladbar: ${r.logs.slice(-300)}`)
  if (r.exitCode !== 0 || /\[FTL\]/.test(r.logs)) throw new Error(`Nuclei gescheitert (Code ${r.exitCode}): ${r.logs.slice(-300)}`)
  // Keine Treffer heisst: keine Datei.
  return r.report ? parseNuclei(r.report.toString('utf8')) : []
}

/* --- Stufe 3: testssl.sh ---------------------------------------------------------- */

export async function testssl(scanId: string, t: ScanTarget, labels: Record<string, string>): Promise<FindingInput[]> {
  const r = await runScanner({
    name: `dep_scan_testssl_${short(scanId)}`,
    image: SCANNER_IMAGES.testssl,
    network: t.network,
    cmd: ['--jsonfile', '/tmp/r.json', '--quiet', '--fast', '--warnings', 'off', '--color', '0', t.host],
    reportPath: '/tmp/r.json',
    labels,
    timeoutMs: 10 * 60_000,
  })
  if (!r.report) throw new Error('testssl.sh lieferte keinen Bericht')
  return parseTestssl(JSON.parse(r.report.toString('utf8')), t.host)
}

/* --- Ziel für statische Seiten ---------------------------------------------------- */

/**
 * Statische Seiten haben keinen Container. Für ZAP und Nuclei startet ein
 * kurzlebiger Datei-Server im Projekt-Netz, der das Seiten-Volume nur lesend
 * einbindet. Über Caddy zu gehen hiesse, den IP-Filter für Docker-Netze zu
 * öffnen (siehe MILESTONE-6.md).
 */
export async function startStaticTarget(slug: string, scanId: string): Promise<{ url: string; network: string; stop: () => Promise<void> }> {
  const network = docker.projectNetworkName(slug)
  await docker.ensureNetwork(network)
  await docker.pullImage(SCANNER_IMAGES.httpd).catch(() => {})
  const name = `dep_${slug}_scansrv_${short(scanId)}`
  const id = await docker.createOnly({
    name,
    image: SCANNER_IMAGES.httpd,
    network,
    env: {},
    labels: { [docker.LABEL_MANAGED]: 'true', [docker.LABEL_PROJECT]: slug, 'deployer.role': 'scanner' },
    memoryLimitMb: 64,
    cpuLimit: 0.5,
    oneShot: true,
    cmd: ['caddy', 'file-server', '--root', `/srv/sites/${slug}/current`, '--listen', ':8080'],
    volumes: [{ source: config.SITES_VOLUME, target: '/srv/sites', readOnly: true }],
    extraVolumes: [{ name: config.SITES_VOLUME, readOnly: true }],
  })
  try {
    await docker.startById(id)
  } catch (err) {
    // Etwa wenn das Projekt während des Scans gelöscht wurde (Netz weg): den
    // erzeugten Container nicht liegen lassen (gefunden in der Abnahme).
    await docker.removeContainer(id).catch(() => {})
    throw err
  }
  await new Promise((r) => setTimeout(r, 800))
  return {
    url: `http://${name}:8080/`,
    network,
    stop: async () => {
      await docker.removeContainer(id)
    },
  }
}
